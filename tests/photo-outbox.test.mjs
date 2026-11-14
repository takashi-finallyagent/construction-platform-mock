import test from 'node:test'
import assert from 'node:assert/strict'
import { IndexedDbPhotoStore, MAX_PHOTO_BYTES, PhotoOutbox, photoOutbox, preparePhoto, sameScope, scopeKey } from '../src/product/photo-outbox.ts'

const scope = { userId: 'user-a', companyId: 'company-a', jobId: 'job-a' }
const photoBlob = () => new Blob(['photo-binary'], { type: 'image/jpeg' })
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
function replaceGlobal(t, key, value) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, key)
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value })
  t.after(() => { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key] })
}

class MemoryStore {
  records = new Map()
  puts = 0
  removes = []
  failPut = false
  failRemove = false
  commit = null
  async list(value) { return [...this.records.values()].filter(item => sameScope(item.scope, value)).map(item => structuredClone(item)) }
  async put(item) {
    this.puts++
    if (this.failPut) throw new DOMException('storage full', 'QuotaExceededError')
    if (this.commit) await this.commit.promise
    this.records.set(item.key, structuredClone(item))
  }
  async remove(key) { if (this.failRemove) throw new Error('delete failed'); this.removes.push(key); this.records.delete(key) }
}

const fileFor = (id, value = scope) => ({ id, companyId: value.companyId, jobId: value.jobId, name: 'photo.jpg', kind: 'photo', size: 12, contentType: 'image/jpeg', sha256: 'a'.repeat(64), createdBy: value.userId, createdAt: new Date().toISOString() })
const sender = (value = scope) => {
  const uploads = [], appends = []
  return { uploads, appends, canSend: () => true,
    upload: async (blob, name, kind, id) => { uploads.push({ blob, name, kind, id }); return fileFor(id, value) },
    append: async photo => { appends.push(structuredClone(photo)); return true },
  }
}
async function enqueueReady(outbox, source = 'camera', capturedAt = '2026-10-26T01:23:45.000Z') {
  const key = await outbox.enqueue(photoBlob(), 'photo.jpg', 'before', source, capturedAt)
  await outbox.prepare(key)
  return key
}

// Browser decoding is deliberately injected; upload/append/storage code is the real module.
test.beforeEach(t => {
  replaceGlobal(t, 'createImageBitmap', async () => ({ width: 1600, height: 1200, close() {} }))
})

test('durable state is not announced until storage commit completes', async () => {
  const store = new MemoryStore(), outbox = new PhotoOutbox(scope, store)
  store.commit = deferred()
  let completed = false
  const writing = outbox.enqueue(photoBlob(), 'photo.jpg', 'during', 'camera', '2026-10-26T01:23:45.000Z').then(key => { completed = true; return key })
  await Promise.resolve()
  assert.equal(completed, false)
  assert.equal(outbox.snapshot()[0].durable, false)
  assert.equal(store.records.size, 0)
  store.commit.resolve()
  await writing
  assert.equal(completed, true)
  assert.equal(outbox.snapshot()[0].durable, true)
  assert.equal(store.records.size, 1)
})

test('success requires file upload and photo append, then removes only that entry', async () => {
  const store = new MemoryStore(), outbox = new PhotoOutbox(scope, store), send = sender()
  const key = await enqueueReady(outbox)
  const other = new PhotoOutbox({ ...scope, jobId: 'job-other' }, store)
  const otherKey = await enqueueReady(other)
  const appendGate = deferred()
  send.append = async photo => { send.appends.push(photo); await appendGate.promise; return true }
  const sending = outbox.flush(send)
  await Promise.resolve(); await Promise.resolve()
  assert.equal(store.records.has(key), true)
  assert.equal(outbox.lastSaved, '')
  appendGate.resolve(); await sending
  assert.equal(outbox.snapshot().length, 0)
  assert.equal(outbox.lastSaved, send.appends[0].id)
  assert.deepEqual(store.removes, [key])
  assert.equal(store.records.has(otherKey), true)
  assert.equal(other.snapshot().length, 1)
})

test('file failure retains the exact blob and IDs and retries without extra metadata', async () => {
  const store = new MemoryStore(), outbox = new PhotoOutbox(scope, store), send = sender()
  await enqueueReady(outbox)
  const original = outbox.snapshot()[0]
  send.upload = async (blob, name, kind, id) => { send.uploads.push({ blob, name, kind, id }); throw new Error('offline') }
  await outbox.flush(send)
  assert.equal(send.appends.length, 0)
  assert.equal(store.records.size, 1)
  assert.equal(outbox.lastSaved, '')
  assert.match(outbox.snapshot()[0].error, /offline/)
  send.upload = async (blob, name, kind, id) => { send.uploads.push({ blob, name, kind, id }); return fileFor(id) }
  await outbox.flush(send, true)
  assert.equal(send.uploads.length, 2)
  assert.equal(send.uploads[0].id, original.photo.fileId)
  assert.equal(send.uploads[1].id, original.photo.fileId)
  assert.equal(send.uploads[1].blob, original.blob)
  assert.equal(send.appends[0].id, original.photo.id)
  assert.deepEqual(Object.keys(send.appends[0]).sort(), ['caption', 'capturedAt', 'fileId', 'id', 'phase', 'source'])
})

test('unknown append result remains pending and retries with the same photo and file IDs', async () => {
  const store = new MemoryStore(), outbox = new PhotoOutbox(scope, store), send = sender()
  await enqueueReady(outbox)
  send.append = async photo => { send.appends.push(structuredClone(photo)); return send.appends.length > 1 }
  await outbox.flush(send)
  assert.equal(outbox.snapshot().length, 1)
  assert.equal(outbox.lastSaved, '')
  await outbox.flush(send, true)
  assert.deepEqual(send.appends[0], send.appends[1])
  assert.equal(send.uploads[0].id, send.uploads[1].id)
  assert.equal(outbox.snapshot().length, 0)
})

test('same-user reload restores pending data, device camera timestamp stays unknown', async () => {
  const store = new MemoryStore(), first = new PhotoOutbox(scope, store)
  await enqueueReady(first, 'device-camera', null)
  const expected = first.snapshot()[0]
  const reloaded = new PhotoOutbox(scope, store), send = sender()
  await reloaded.restore()
  assert.equal(reloaded.snapshot()[0].durable, true)
  await reloaded.flush(send)
  assert.equal(send.appends[0].id, expected.photo.id)
  assert.equal(send.uploads[0].id, expected.photo.fileId)
  assert.equal(send.appends[0].source, 'device-camera')
  assert.equal(send.appends[0].capturedAt, null)
})

test('changing any identity segment never restores or flushes another scope', async () => {
  const store = new MemoryStore(), original = new PhotoOutbox(scope, store)
  await enqueueReady(original)
  for (const changed of [{ ...scope, userId: 'user-b' }, { ...scope, companyId: 'company-b' }, { ...scope, jobId: 'job-b' }]) {
    const outbox = new PhotoOutbox(changed, store), send = sender(changed)
    await outbox.restore(); await outbox.flush(send)
    assert.equal(send.uploads.length, 0)
    assert.equal(send.appends.length, 0)
    assert.equal(outbox.snapshot().length, 0)
  }
  assert.equal(store.records.size, 1)
  assert.notEqual(scopeKey({ userId: 'a/b', companyId: 'c', jobId: 'd' }), scopeKey({ userId: 'a', companyId: 'b/c', jobId: 'd' }))
})

test('restoration also rejects a faulty store returning another scope', async () => {
  const store = new MemoryStore(), original = new PhotoOutbox(scope, store)
  await enqueueReady(original)
  store.list = async () => [...store.records.values()]
  const other = new PhotoOutbox({ ...scope, userId: 'other' }, store), send = sender()
  await other.restore(); await other.flush(send)
  assert.equal(send.uploads.length, 0)
})

test('offline/read-only prevents sending; identity change during upload prevents append', async () => {
  const store = new MemoryStore(), outbox = new PhotoOutbox(scope, store), send = sender()
  await enqueueReady(outbox)
  let allowed = false
  send.canSend = () => allowed
  await outbox.flush(send)
  assert.equal(send.uploads.length, 0)
  allowed = true
  send.upload = async (_blob, _name, _kind, id) => { allowed = false; return fileFor(id) }
  await outbox.flush(send)
  assert.equal(send.appends.length, 0)
  assert.equal(store.records.size, 1)
  assert.equal(outbox.lastSaved, '')
})

test('a mismatched upload result never appends or announces server saved', async () => {
  for (const mismatch of ['id', 'companyId', 'jobId', 'kind']) {
    const store = new MemoryStore(), outbox = new PhotoOutbox(scope, store), send = sender()
    await enqueueReady(outbox)
    send.upload = async (_blob, _name, _kind, id) => ({ ...fileFor(id), [mismatch]: 'wrong' })
    await outbox.flush(send)
    assert.equal(send.appends.length, 0)
    assert.equal(outbox.lastSaved, '')
    assert.equal(outbox.snapshot().length, 1)
  }
})

test('simultaneous flushes send one at a time, and a new capture joins the current drain', async () => {
  const store = new MemoryStore(), outbox = new PhotoOutbox(scope, store), send = sender(), gate = deferred()
  await enqueueReady(outbox)
  let concurrent = 0, maximum = 0
  send.upload = async (_blob, _name, _kind, id) => { concurrent++; maximum = Math.max(maximum, concurrent); send.uploads.push(id); await gate.promise; concurrent--; return fileFor(id) }
  const first = outbox.flush(send), second = outbox.flush(send)
  assert.equal(first, second)
  await enqueueReady(outbox)
  gate.resolve(); await Promise.all([first, second])
  assert.equal(maximum, 1)
  assert.equal(send.uploads.length, 2)
  assert.equal(send.appends.length, 2)
  assert.equal(new Set(send.uploads).size, 2)
})

test('one network failure stops the batch, with no timer or automatic retry loop', async () => {
  const store = new MemoryStore(), outbox = new PhotoOutbox(scope, store), send = sender()
  await enqueueReady(outbox); await enqueueReady(outbox)
  send.upload = async () => { send.uploads.push('attempt'); throw new Error('unavailable') }
  await outbox.flush(send)
  await outbox.flush(send)
  await outbox.flush(send)
  await new Promise(resolve => setTimeout(resolve, 30))
  assert.equal(send.uploads.length, 1)
  assert.equal(outbox.snapshot().length, 2)
  assert.equal(store.removes.length, 0)
})

test('quota failure retains memory, never automatically re-writes, and supports explicit retry', async () => {
  const store = new MemoryStore(), outbox = new PhotoOutbox(scope, store)
  store.failPut = true
  const key = await enqueueReady(outbox)
  assert.equal(store.puts, 1)
  assert.equal(outbox.snapshot()[0].durable, false)
  assert.equal(await outbox.snapshot()[0].blob.text(), 'photo-binary')
  assert.match(outbox.snapshot()[0].error, /端末に保管できません/)
  await outbox.restore()
  assert.equal(store.puts, 1)
  store.failPut = false
  await outbox.retryStorage(key)
  assert.equal(store.puts, 2)
  assert.equal(outbox.snapshot()[0].durable, true)
})

test('memory-only capture can be sent or explicitly discarded even when storage is unavailable', async () => {
  const store = new MemoryStore(), outbox = new PhotoOutbox(scope, store), send = sender()
  store.failPut = true; store.failRemove = true
  await enqueueReady(outbox); await outbox.flush(send)
  assert.equal(send.appends.length, 1)
  assert.equal(outbox.snapshot().length, 0)
  const key = await enqueueReady(outbox)
  await outbox.discard(key)
  assert.equal(outbox.snapshot().length, 0)
})

test('failed durable cleanup is visible and a cleanup retry never reuploads or reappends', async () => {
  const store = new MemoryStore(), outbox = new PhotoOutbox(scope, store), send = sender()
  await enqueueReady(outbox)
  store.failRemove = true
  await outbox.flush(send)
  assert.equal(outbox.snapshot()[0].acknowledged, true)
  assert.notEqual(outbox.lastSaved, '')
  assert.equal(store.records.size, 1)
  store.failRemove = false
  await outbox.flush(send, true)
  assert.equal(send.uploads.length, 1)
  assert.equal(send.appends.length, 1)
  assert.equal(store.records.size, 0)
})

test('unsupported formats retain their original and never reach upload without conversion', async () => {
  const store = new MemoryStore(), outbox = new PhotoOutbox(scope, store), send = sender()
  const original = new Blob(['original-heic'], { type: 'image/heic' })
  const key = await outbox.enqueue(original, 'photo.heic', 'after', 'device-camera', null)
  await outbox.prepare(key); await outbox.flush(send)
  assert.equal(outbox.snapshot()[0].ready, false)
  assert.equal(outbox.snapshot()[0].blob, original)
  assert.match(outbox.snapshot()[0].error, /未対応/)
  assert.equal(send.uploads.length, 0)
  assert.equal(store.records.size, 1)
})

test('browser JPEG conversion retains original and stable IDs, and labels the converted record', async t => {
  const original = new Blob(['original'], { type: 'image/heic' }), converted = photoBlob()
  const canvas = { width: 0, height: 0, getContext: () => ({ fillRect() {}, drawImage() {}, fillStyle: '' }), toBlob: callback => callback(converted) }
  replaceGlobal(t, 'document', { createElement: () => canvas })
  const store = new MemoryStore(), outbox = new PhotoOutbox(scope, store)
  const key = await outbox.enqueue(original, 'photo.heic', 'after', 'device-camera', null)
  const id = outbox.snapshot()[0].photo.fileId
  await outbox.prepare(key, true)
  const item = outbox.snapshot()[0]
  assert.equal(item.ready, true)
  assert.equal(item.converted, true)
  assert.equal(item.originalBlob, original)
  assert.equal(item.originalName, 'photo.heic')
  assert.equal(item.blob, converted)
  assert.equal(item.photo.fileId, id)
  assert.equal(item.photo.capturedAt, null)
  assert.equal(item.photo.caption, 'JPEG変換済み')
  assert.equal(canvas.width, 0)
  assert.equal(canvas.height, 0)
})

test('12 MiB and 20 MP validation rejects oversize or undecodable photos', async t => {
  await assert.rejects(preparePhoto(new Blob([new Uint8Array(MAX_PHOTO_BYTES + 1)], { type: 'image/jpeg' })), /12 MiB/)
  await assert.rejects(preparePhoto(new Blob([], { type: 'image/png' })), /空/)
  t.mock.method(globalThis, 'createImageBitmap', async () => ({ width: 6000, height: 4000, close() {} }))
  await assert.rejects(preparePhoto(photoBlob()), /20メガピクセル/)
  t.mock.method(globalThis, 'createImageBitmap', async () => { throw new Error('decode failed') })
  await assert.rejects(preparePhoto(photoBlob()), /読み取れません/)
})

test('scope registry reuses only the exact identity and rejects incomplete identity', () => {
  assert.equal(photoOutbox(scope), photoOutbox({ ...scope }))
  assert.notEqual(photoOutbox(scope), photoOutbox({ ...scope, userId: 'other' }))
  assert.throws(() => new PhotoOutbox({ ...scope, userId: '' }), /特定できません/)
})

test('concurrent restore preparation decodes and commits an entry only once', async t => {
  const store = new MemoryStore(), outbox = new PhotoOutbox(scope, store), gate = deferred()
  const key = await outbox.enqueue(photoBlob(), 'photo.jpg', 'before', 'camera', null)
  let decodes = 0
  t.mock.method(globalThis, 'createImageBitmap', async () => { decodes++; await gate.promise; return { width: 100, height: 100, close() {} } })
  const first = outbox.prepare(key), second = outbox.prepare(key)
  assert.equal(first, second)
  gate.resolve(); await Promise.all([first, second])
  assert.equal(decodes, 1)
  assert.equal(store.puts, 2)
})

function indexedDbHarness(t) {
  const transactions = [], closes = []
  const database = {
    close: () => closes.push(true),
    transaction: () => {
      const request = { result: 'written-key', error: null }
      const tx = { error: null, objectStore: () => ({ put: () => request, delete: () => request }), request }
      transactions.push(tx)
      return tx
    },
  }
  replaceGlobal(t, 'indexedDB', { open: () => { const request = { result: database }; queueMicrotask(() => request.onsuccess()); return request } })
  return { transactions, closes }
}

test('actual IndexedDbPhotoStore waits for transaction complete, not request success', async t => {
  const harness = indexedDbHarness(t), store = new IndexedDbPhotoStore()
  let resolved = false
  const writing = store.put({ key: 'key' }).then(() => { resolved = true })
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
  const tx = harness.transactions[0]
  assert.ok(tx)
  tx.request.onsuccess?.()
  await Promise.resolve()
  assert.equal(resolved, false)
  assert.equal(harness.closes.length, 0)
  tx.oncomplete()
  await writing
  assert.equal(resolved, true)
  assert.equal(harness.closes.length, 1)
})

test('actual IndexedDbPhotoStore rejects transaction abort after a successful request', async t => {
  const harness = indexedDbHarness(t), store = new IndexedDbPhotoStore()
  const writing = store.put({ key: 'key' })
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
  const tx = harness.transactions[0]
  tx.error = new DOMException('quota', 'QuotaExceededError')
  tx.onabort()
  await assert.rejects(writing, /quota/)
  assert.equal(harness.closes.length, 1)
})
