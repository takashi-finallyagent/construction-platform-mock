import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open, rename, unlink } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import sharp from 'sharp'
import { HttpError } from './jobs.ts'

export const fileLimit = 12*1024*1024
export const fileTypes = ['image/jpeg','image/png','image/webp','application/pdf'] as const
export function fileRoot() { return resolve(process.env.FILE_STORAGE_DIR || '.runtime/private-files') }
export function storagePath(key: string) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(key)) throw new Error('Invalid storage key')
  return join(fileRoot(),key,'original')
}
export function fileName(header: unknown) {
  if (typeof header!=='string' || header.length>3000) throw new HttpError(400,'ファイル名を確認してください。')
  let name: string
  try { name=decodeURIComponent(header).normalize('NFC').trim() } catch { throw new HttpError(400,'ファイル名を確認してください。') }
  const unsafe = [...name].some(char => { const code = char.codePointAt(0)!; return code<32 || code>=127 && code<=159 || char==='/' || char==='\\' })
  if (!name || Array.from(name).length>240 || unsafe || /\p{Surrogate}/u.test(name) || ['.','..'].includes(name)) throw new HttpError(400,'ファイル名を確認してください。')
  return name
}
export async function inspectFile(body: unknown,type: string,kind: string) {
  if (!Buffer.isBuffer(body) || body.length<1) throw new HttpError(400,'ファイルが空です。')
  if (body.length>fileLimit) throw new HttpError(413,'ファイルは12 MiB以下にしてください。')
  const jpeg=body[0]===0xff && body[1]===0xd8 && body[2]===0xff
  const png=body.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))
  const webp=body.toString('ascii',0,4)==='RIFF' && body.toString('ascii',8,12)==='WEBP'
  const pdf=body.toString('ascii',0,5)==='%PDF-' && /%%EOF\s*$/.test(body.subarray(-1024).toString('latin1'))
  if (!({'image/jpeg':jpeg,'image/png':png,'image/webp':webp,'application/pdf':pdf}[type])) throw new HttpError(415,'ファイル形式と内容が一致しません。')
  if (type==='application/pdf') {
    if (kind!=='evidence') throw new HttpError(400,'PDFは証拠資料として保存してください。')
  } else {
    try {
      const image=sharp(body,{failOn:'warning',limitInputPixels:20_000_000})
      const metadata=await image.metadata()
      if (!metadata.width || !metadata.height || metadata.width*metadata.height>20_000_000 || (metadata.pages ?? 1)!==1
        || `image/${metadata.format}`!==type) throw new Error('Unsupported image')
      // metadata() alone does not decode pixels. Decode fully, then persist original bytes.
      await image.raw().toBuffer()
    } catch { throw new HttpError(415,'画像を読み取れません。JPEG・PNG・WebPの静止画を使用してください。') }
  }
  return {body,sha256:createHash('sha256').update(body).digest('hex')}
}
export async function persistFile(body: Buffer) {
  await mkdir(fileRoot(),{recursive:true,mode:0o700})
  const key=randomUUID()
  // Exclusive directory creation reserves a unique destination before rename on every platform.
  await mkdir(join(fileRoot(),key),{mode:0o700})
  const temporary=storagePath(key)+'.tmp'
  const handle=await open(temporary,'wx',0o600)
  try { await handle.writeFile(body); await handle.sync() } finally { await handle.close() }
  try {
    // A random server-only key is never reused, including on DB rollback/uncertain commit.
    await rename(temporary,storagePath(key))
  } catch (error) {
    try { await unlink(temporary) } catch { /* A failed cleanup leaves only an inaccessible orphan. */ }
    throw error
  }
  return key
}
