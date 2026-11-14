import type { FieldPhoto, FieldWorkspace, IssuedDocument } from './model'

const DB_NAME = 'construction-field-workspace'
let opening: Promise<IDBDatabase> | undefined

export function openFieldDatabase(): Promise<IDBDatabase> {
  if (opening) return opening
  opening = new Promise((resolve, reject) => {
    if (!globalThis.indexedDB) { reject(new Error('このブラウザでは写真を保存できません。通常のSafariまたはChromeで開いてください。')); return }
    const request = indexedDB.open(DB_NAME, 1)
    request.onupgradeneeded = () => {
      const db = request.result
      db.createObjectStore('workspace')
      const photos = db.createObjectStore('photos', { keyPath: 'id' })
      photos.createIndex('jobId', 'jobId')
      const documents = db.createObjectStore('documents', { keyPath: 'id' })
      documents.createIndex('jobId', 'jobId')
    }
    request.onsuccess = () => {
      const db = request.result
      db.onversionchange = () => { db.close(); opening = undefined }
      resolve(db)
    }
    request.onerror = () => { opening = undefined; reject(request.error ?? new Error('保存領域を開けませんでした。')) }
    request.onblocked = () => { opening = undefined; reject(new Error('別のタブを閉じてから、もう一度開いてください。')) }
  })
  return opening
}

async function read<T>(store: string, key?: IDBValidKey): Promise<T> {
  const db = await openFieldDatabase()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readonly')
    const request = key === undefined ? tx.objectStore(store).getAll() : tx.objectStore(store).get(key)
    let value: T
    request.onsuccess = () => { value = request.result as T }
    tx.oncomplete = () => resolve(value)
    tx.onabort = tx.onerror = () => reject(tx.error ?? new Error('保存したデータを読み取れませんでした。'))
  })
}

async function write(store: string, value: unknown, key?: IDBValidKey) {
  const db = await openFieldDatabase()
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite')
    try {
      if (key === undefined) tx.objectStore(store).put(value)
      else tx.objectStore(store).put(value, key)
    } catch (error) { tx.abort(); reject(error); return }
    tx.oncomplete = () => resolve()
    tx.onabort = tx.onerror = () => reject(tx.error ?? new Error('保存できませんでした。空き容量をご確認ください。'))
  })
}

export const loadWorkspace = () => read<FieldWorkspace | undefined>('workspace', 'current')
export const saveWorkspace = (value: FieldWorkspace) => write('workspace', value, 'current')
export const loadPhotos = () => read<FieldPhoto[]>('photos')
export const putPhoto = (photo: FieldPhoto) => write('photos', photo)
export const loadDocuments = () => read<IssuedDocument[]>('documents')
export const putDocument = (doc: IssuedDocument) => write('documents', doc)

export function saveError(error: unknown) {
  if (error instanceof DOMException && error.name === 'QuotaExceededError') return '端末の空き容量が不足しています。写真はまだ保存できていません。'
  return error instanceof Error ? error.message : '保存できませんでした。もう一度お試しください。'
}
