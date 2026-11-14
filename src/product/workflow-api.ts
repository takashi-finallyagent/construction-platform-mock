import { Ajv } from 'ajv'
import { ApiError } from './api'
import { workflowSchema } from './workflow-schema'
import type { SitePhoto, StoredFile, WorkflowAudit, WorkflowPut, WorkflowView } from './workflow-model'

const valid = new Ajv({ strict: true, coerceTypes: false, removeAdditional: false, useDefaults: false }).compile(workflowSchema)
const uuid = (v: unknown) => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v)
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const integer = (v: unknown) => Number.isSafeInteger(v) && Number(v) >= 0
const failure = (): never => { throw new ApiError(0, '業務記録の応答を確認できませんでした。再読込してください。') }
function view(value: unknown, companyId: string, jobId: string): WorkflowView {
  if (!object(value) || value.companyId !== companyId || value.jobId !== jobId || !integer(value.version) || !integer(value.jobVersion) || Number(value.jobVersion) < 1 || !(value.classificationVersion === null || integer(value.classificationVersion) && Number(value.classificationVersion) >= 1) || !valid(value.data) || !(value.updatedAt === null || typeof value.updatedAt === 'string') || !(value.updatedBy === null || typeof value.updatedBy === 'string')) return failure()
  return value as unknown as WorkflowView
}
function file(value: unknown, companyId: string, jobId: string): StoredFile {
  if (!object(value) || !uuid(value.id) || value.companyId !== companyId || value.jobId !== jobId || !['photo', 'evidence'].includes(String(value.kind)) || !['image/jpeg', 'image/png', 'image/webp', 'application/pdf'].includes(String(value.contentType)) || !integer(value.size) || Number(value.size) < 1 || typeof value.name !== 'string' || typeof value.createdAt !== 'string' || typeof value.createdBy !== 'string' || typeof value.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.sha256)) return failure()
  return value as unknown as StoredFile
}
async function request(url: string, signal: AbortSignal, init: RequestInit = {}): Promise<unknown> {
  let response: Response
  try { response = await fetch(url, { ...init, signal, credentials: 'same-origin', mode: 'same-origin', cache: 'no-store', headers: { Accept: 'application/json', ...init.headers } }) }
  catch (error) { if (signal.aborted) throw error; throw new ApiError(0, '通信結果を確認できません。入力・送信待ちの写真を保持しています。') }
  if (!response.ok) {
    let message = '処理結果を確認できませんでした。'
    try { const result: unknown = await response.json(); if (object(result) && typeof result.message === 'string') message = result.message } catch { /* Keep the status and generic message. */ }
    throw new ApiError(response.status, message)
  }
  try { return await response.json() } catch { return failure() }
}
const base = (companyId: string, jobId: string) => `/api/companies/${encodeURIComponent(companyId)}/jobs/${encodeURIComponent(jobId)}`
export const workflowApi = {
  get: async (companyId: string, jobId: string, signal: AbortSignal) => view(await request(`${base(companyId, jobId)}/workflow`, signal), companyId, jobId),
  put: async (companyId: string, jobId: string, body: WorkflowPut, signal: AbortSignal) => {
    const next = view(await request(`${base(companyId, jobId)}/workflow`, signal, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }), companyId, jobId)
    if (next.version !== body.version + 1) return failure()
    return next
  },
  files: async (companyId: string, jobId: string, signal: AbortSignal) => {
    const value = await request(`${base(companyId, jobId)}/files`, signal)
    if (!object(value) || !Array.isArray(value.files)) return failure()
    return value.files.map(v => file(v, companyId, jobId))
  },
  upload: async (companyId: string, jobId: string, blob: Blob, name: string, kind: StoredFile['kind'], id: string, signal: AbortSignal) => {
    const stored = file(await request(`${base(companyId, jobId)}/files/${encodeURIComponent(id)}`, signal, { method: 'PUT', headers: { 'Content-Type': blob.type, 'x-file-name': encodeURIComponent(name), 'x-file-kind': kind }, body: blob }), companyId, jobId)
    if (stored.id !== id) return failure()
    return stored
  },
  photo: async (companyId: string, jobId: string, body: SitePhoto, signal: AbortSignal) => view(await request(`${base(companyId, jobId)}/workflow/photos`, signal, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }), companyId, jobId),
  fileUrl: (companyId: string, jobId: string, id: string) => `${base(companyId, jobId)}/files/${encodeURIComponent(id)}`,
  audit: async (companyId: string, jobId: string, cursor: string | null, signal: AbortSignal) => {
    const result = await request(`${base(companyId, jobId)}/workflow/audit?limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, signal)
    if (!object(result) || !Array.isArray(result.events) || !(result.nextCursor === null || typeof result.nextCursor === 'string' && /^[1-9]\d*$/.test(result.nextCursor))) return failure()
    const events = result.events.map(v => {
      if (!object(v) || !uuid(v.id) || !integer(v.version) || Number(v.version) < 1 || typeof v.actorName !== 'string' || typeof v.occurredAt !== 'string' || !(v.beforeData === null || valid(v.beforeData)) || !valid(v.afterData)) return failure()
      return v as unknown as WorkflowAudit
    })
    if (events.length > 50 || new Set(events.map(v => v.version)).size !== events.length || events.some((v, i) => i > 0 && v.version >= events[i - 1].version)) return failure()
    return { events, nextCursor: result.nextCursor as string | null }
  },
}
