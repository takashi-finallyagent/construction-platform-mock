import type { SitePhoto, StoredFile } from './workflow-model'

export type PhotoScope = { userId: string; companyId: string; jobId: string }
export type PendingPhoto = {
  key: string; scope: PhotoScope; photo: SitePhoto; blob: Blob; name: string; createdAt: string
  ready: boolean; converted: boolean; originalBlob?: Blob; originalName?: string
}
export type OutboxItem = PendingPhoto & { durable: boolean; storedCopy: boolean; error: string; sending: boolean; acknowledged: boolean }
export interface PhotoStore {
  list(scope: PhotoScope): Promise<PendingPhoto[]>
  put(item: PendingPhoto): Promise<void>
  remove(key: string): Promise<void>
}
export const scopeKey = (scope: PhotoScope) => JSON.stringify([scope.userId, scope.companyId, scope.jobId])
export const sameScope = (a: PhotoScope, b: PhotoScope) => scopeKey(a) === scopeKey(b)
const errorText = (error: unknown) => error instanceof Error ? error.message : '写真の処理に失敗しました。'

/** Resolves writes only after the entire IndexedDB transaction commits. */
export class IndexedDbPhotoStore implements PhotoStore {
  private async open(): Promise<IDBDatabase> {
    if (!globalThis.indexedDB) throw new Error('このブラウザーでは端末保管を利用できません。')
    return new Promise((resolve, reject) => {
      const request = indexedDB.open('construction-photo-outbox', 1)
      request.onupgradeneeded = () => {
        const store = request.result.createObjectStore('pending', { keyPath: 'key' })
        store.createIndex('scope', ['scope.userId', 'scope.companyId', 'scope.jobId'])
      }
      let blocked = false
      request.onblocked = () => { blocked = true; reject(new Error('端末保管が他のタブにより使用中です。')) }
      request.onerror = () => reject(request.error ?? new Error('端末保管を開けませんでした。'))
      request.onsuccess = () => {
        if (blocked) { request.result.close(); return }
        request.result.onversionchange = () => request.result.close()
        resolve(request.result)
      }
    })
  }
  private async transaction<T>(mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
    const db = await this.open()
    try {
      return await new Promise<T>((resolve, reject) => {
        const tx = db.transaction('pending', mode)
        const request = action(tx.objectStore('pending'))
        tx.oncomplete = () => resolve(request.result)
        tx.onabort = () => reject(tx.error ?? request.error ?? new Error('端末保管を完了できませんでした。'))
        tx.onerror = () => reject(tx.error ?? request.error ?? new Error('端末保管に失敗しました。'))
      })
    } finally { db.close() }
  }
  list(scope: PhotoScope) {
    return this.transaction<PendingPhoto[]>('readonly', store => store.index('scope').getAll([scope.userId, scope.companyId, scope.jobId]))
  }
  async put(item: PendingPhoto) { await this.transaction('readwrite', store => store.put(item)) }
  async remove(key: string) { await this.transaction('readwrite', store => store.delete(key)) }
}

export type PhotoSender = {
  canSend: () => boolean
  upload: (blob: Blob, name: string, kind: 'photo', id: string) => Promise<StoredFile>
  append: (photo: SitePhoto) => Promise<boolean>
}

/** One controller per identity; only pending images live here, never a local gallery. */
export class PhotoOutbox {
  readonly scope: PhotoScope
  private store: PhotoStore
  private items = new Map<string, OutboxItem>()
  private listeners = new Set<() => void>()
  private running: Promise<void> | null = null
  private followUp: PhotoSender | null = null
  private paused = false
  private restoring: Promise<void> | null = null
  private preparing = new Map<string, Promise<void>>()
  lastSaved = ''
  storageError = ''
  constructor(scope: PhotoScope, store: PhotoStore = new IndexedDbPhotoStore()) {
    if (!scope.userId || !scope.companyId || !scope.jobId) throw new Error('写真の保管先を特定できません。')
    this.scope = { ...scope }; this.store = store
  }
  subscribe(listener: () => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  private emit() { for (const listener of this.listeners) listener() }
  snapshot() { return [...this.items.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt)) }
  private raw(item: OutboxItem): PendingPhoto {
    const { key, scope, photo, blob, name, createdAt, ready, converted, originalBlob, originalName } = item
    return { key, scope, photo, blob, name, createdAt, ready, converted, originalBlob, originalName }
  }
  restore(): Promise<void> {
    if (this.restoring) return this.restoring
    this.restoring = (async () => {
      try {
        const records = await this.store.list(this.scope)
        for (const record of records) if (sameScope(record.scope, this.scope) && !this.items.has(record.key)) {
          this.items.set(record.key, { ...record, durable: true, storedCopy: true, error: '', sending: false, acknowledged: false })
        }
        this.storageError = ''
      } catch (error) { this.storageError = errorText(error) }
      this.emit()
    })().finally(() => { this.restoring = null })
    return this.restoring
  }
  async enqueue(blob: Blob, name: string, phase: SitePhoto['phase'], source: SitePhoto['source'], capturedAt: string | null) {
    const id = crypto.randomUUID()
    const item: OutboxItem = {
      key: `${scopeKey(this.scope)}:${id}`, scope: { ...this.scope },
      photo: { id, fileId: crypto.randomUUID(), phase, source, capturedAt, caption: '' },
      blob, name, createdAt: new Date().toISOString(), ready: false, converted: false,
      durable: false, storedCopy: false, error: '', sending: false, acknowledged: false,
    }
    this.items.set(item.key, item); this.emit()
    await this.persist(item)
    return item.key
  }
  private async persist(item: OutboxItem) {
    try { await this.store.put(this.raw(item)); item.durable = true; item.storedCopy = true; item.error = '' }
    catch (error) {
      item.durable = false
      item.error = `端末に保管できませんでした（${errorText(error)}）。この画面を閉じる前に原本をダウンロードしてください。`
    }
    this.emit()
  }
  async retryStorage(key: string) {
    const item = this.items.get(key)
    if (item && !item.sending && !item.acknowledged) await this.persist(item)
  }
  prepare(key: string, convert = false): Promise<void> {
    const existing = this.preparing.get(key)
    if (existing) return existing
    const task = this.prepareOne(key, convert).finally(() => { this.preparing.delete(key) })
    this.preparing.set(key, task)
    return task
  }
  private async prepareOne(key: string, convert: boolean) {
    const item = this.items.get(key)
    if (!item || item.sending || item.acknowledged) return
    try {
      const result = await preparePhoto(item.originalBlob ?? item.blob, convert)
      if (result.converted && !item.originalBlob) { item.originalBlob = item.blob; item.originalName = item.name }
      item.blob = result.blob; item.ready = true; item.converted = result.converted
      if (result.converted) {
        item.name = `${item.originalName ?? item.name}.converted.jpg`
        item.photo = { ...item.photo, caption: item.photo.caption || 'JPEG変換済み' }
      }
      // A quota failure is never retried automatically; the Blob stays in memory.
      if (item.durable) await this.persist(item)
      else this.emit()
    } catch (error) { item.ready = false; item.error = errorText(error); this.emit() }
  }
  async discard(key: string) {
    const item = this.items.get(key)
    if (!item || item.sending) return
    // Deleting an unpersisted replacement must also remove any earlier durable copy.
    try { if (item.storedCopy) await this.store.remove(key) }
    catch (error) { item.error = `端末保管の削除に失敗しました。${errorText(error)}`; this.emit(); throw error }
    this.items.delete(key); this.emit()
  }
  flush(sender: PhotoSender, retry = false): Promise<void> {
    if (retry) this.paused = false
    if (this.running) { this.followUp = sender; return this.running }
    if (this.paused) return Promise.resolve()
    const run = async () => {
      // At most 200 entries per drain, including new captures; no retry timers.
      const attempted = new Set<string>()
      for (let count = 0; count < 200; count++) {
        const entry = this.snapshot().find(item => !attempted.has(item.key) && !this.preparing.has(item.key) && (item.ready || item.acknowledged))
        if (!entry) break
        attempted.add(entry.key)
        const item = this.items.get(entry.key)
        if (!item || !sameScope(item.scope, this.scope)) continue
        if (!sender.canSend()) break
        item.sending = true; this.emit()
        try {
          if (!item.acknowledged) {
            const stored = await sender.upload(item.blob, item.name, 'photo', item.photo.fileId)
            if (stored.id !== item.photo.fileId || stored.companyId !== this.scope.companyId || stored.jobId !== this.scope.jobId || stored.kind !== 'photo') throw new Error('写真の保存先が一致しません。送信を停止しました。')
            if (!sender.canSend()) break
            if (!await sender.append({ ...item.photo })) throw new Error('写真情報を保存できませんでした。再送信してください。')
            item.acknowledged = true
            this.lastSaved = item.photo.id
          }
          if (item.storedCopy) await this.store.remove(item.key)
          this.items.delete(item.key)
        } catch (error) { item.error = errorText(error); this.paused = true; break }
        finally { item.sending = false; this.emit() }
      }
    }
    const locks = globalThis.navigator?.locks
    this.running = (locks ? locks.request(`photo-outbox:${scopeKey(this.scope)}`, run) : run()).finally(() => {
      const next = this.followUp; this.followUp = null; this.running = null; this.emit()
      if (next && !this.paused && next.canSend()) void this.flush(next).catch(() => { /* A subsequent explicit retry retains the entries. */ })
    })
    return this.running
  }
}

const controllers = new Map<string, PhotoOutbox>()
export function photoOutbox(scope: PhotoScope) {
  const key = scopeKey(scope)
  let controller = controllers.get(key)
  if (!controller) { controller = new PhotoOutbox(scope); controllers.set(key, controller) }
  return controller
}

export const MAX_PHOTO_BYTES = 12 * 1024 * 1024
export const MAX_PHOTO_PIXELS = 20_000_000
export async function preparePhoto(blob: Blob, convert = false): Promise<{ blob: Blob; converted: boolean }> {
  if (!blob.size) throw new Error('空の写真です。原本を確認してください。')
  const supported = ['image/jpeg', 'image/png', 'image/webp'].includes(blob.type)
  if (!supported && !convert) throw new Error('未対応の画像形式です。原本を保持しています。「JPEGに変換して再送信」を選ぶとブラウザーで変換を試みます。')
  if (supported && blob.size > MAX_PHOTO_BYTES && !convert) throw new Error('写真は12 MiB以下です。原本を保持しています。JPEG変換で縮小できます。')
  const bitmap = await createImageBitmap(blob, { imageOrientation: 'from-image' }).catch(() => { throw new Error('ブラウザーで画像を読み取れません。原本をダウンロードし、対応形式で撮り直してください。') })
  try {
    const pixels = bitmap.width * bitmap.height
    if (!pixels) throw new Error('画像の大きさを確認できません。')
    if (!convert && pixels > MAX_PHOTO_PIXELS) throw new Error('写真は20メガピクセル以下です。原本を保持しています。JPEG変換で縮小できます。')
    if (!convert) return { blob, converted: false }
    const scale = Math.min(1, Math.sqrt(MAX_PHOTO_PIXELS / pixels), 3840 / Math.max(bitmap.width, bitmap.height))
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.floor(bitmap.width * scale)); canvas.height = Math.max(1, Math.floor(bitmap.height * scale))
    try {
      const ctx = canvas.getContext('2d')
      if (!ctx) throw new Error('JPEG変換の描画を開始できません。')
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height)
      ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
      const jpeg = await new Promise<Blob>((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error('JPEG変換に失敗しました。')), 'image/jpeg', 0.9))
      if (jpeg.type !== 'image/jpeg' || jpeg.size > MAX_PHOTO_BYTES) throw new Error('12 MiB以下のJPEGへ変換できませんでした。原本をダウンロードしてください。')
      return { blob: jpeg, converted: true }
    } finally { canvas.width = 0; canvas.height = 0 }
  } finally { bitmap.close() }
}
