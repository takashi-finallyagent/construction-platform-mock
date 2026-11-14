export type Role = 'owner' | 'manager' | 'viewer'
export interface Company { id: string; name: string; role: Role }
export interface Session {
  user: { id: string; name: string; email: string }
  companies: Company[]
}
export interface JobInput {
  name: string
  siteAddress: string
  customerName: string
  workDescription: string
  plannedStart: string | null
  plannedEnd: string | null
}
export interface Job extends JobInput {
  id: string
  companyId: string
  version: number
  createdAt: string
  updatedAt: string
  createdBy: string
}
export interface AuditEvent {
  id: string
  targetVersion: number
  requestId: string
  actorId: string
  actorName: string
  action: string
  occurredAt: string
  beforeData: Record<string, unknown> | null
  afterData: Record<string, unknown> | null
}
export interface AuditPage { events: AuditEvent[]; nextCursor: string | null }
export class ApiError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

type Decoder<T> = (value: unknown) => T
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
const strings = (value: Record<string, unknown>, keys: string[]) => keys.every(key => typeof value[key] === 'string')
function invalid(): never { throw new ApiError(0, '応答を確認できませんでした。再試行してください。') }
function decodeSession(value: unknown): Session {
  if (!record(value) || !record(value.user) || !strings(value.user, ['id', 'name', 'email']) || !Array.isArray(value.companies)) return invalid()
  if (!value.companies.every(c => record(c) && strings(c, ['id', 'name']) && ['owner', 'manager', 'viewer'].includes(String(c.role)))) return invalid()
  return value as unknown as Session
}
function decodeJob(value: unknown): Job {
  if (!record(value) || !strings(value, ['id', 'companyId', 'name', 'siteAddress', 'customerName', 'workDescription', 'createdAt', 'updatedAt', 'createdBy']) || !Number.isInteger(value.version) || Number(value.version) < 1) return invalid()
  if (![value.plannedStart, value.plannedEnd].every(date => date === null || typeof date === 'string')) return invalid()
  return value as unknown as Job
}
const messages: Record<number, string> = {
  400: '入力内容を確認してください。',
  401: '認証の有効期限が切れました。再度ログインしてください。',
  403: 'この操作を行う権限がありません。',
  404: '対象の工事が見つかりません。',
  409: '保存内容の版が変わっています。現在の保存内容を確認してください。',
  422: '入力内容を確認してください。',
  429: '操作が集中しています。しばらく待って再試行してください。',
}
async function request<T>(path: string, decode: Decoder<T>, options: RequestInit = {}): Promise<T> {
  let response: Response
  try {
    response = await fetch(path, {
      ...options,
      mode: 'same-origin',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { Accept: 'application/json', ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers },
    })
  } catch (error) {
    if (options.signal?.aborted) throw error
    throw new ApiError(0, '通信できませんでした。接続を確認して再試行してください。')
  }
  if (!response.ok) throw new ApiError(response.status, messages[response.status] ?? '処理できませんでした。しばらく待って再試行してください。')
  let value: unknown
  try { value = response.status === 204 ? null : await response.json() }
  catch { return invalid() }
  return decode(value)
}
const jobsPath = (companyId: string) => `/api/companies/${encodeURIComponent(companyId)}/jobs`
const jobPath = (companyId: string, jobId: string) => `${jobsPath(companyId)}/${encodeURIComponent(jobId)}`
function companyJob(companyId: string): Decoder<Job> {
  return value => {
    const job = decodeJob(value)
    return job.companyId === companyId ? job : invalid()
  }
}
export const api = {
  me: (signal: AbortSignal) => request('/api/me', decodeSession, { signal }),
  signIn: (email: string, password: string, signal: AbortSignal) => request('/api/auth/sign-in/email', value => {
    if (!record(value) || value.error) throw new ApiError(400, 'ログインできませんでした。入力内容を確認してください。')
  }, { method: 'POST', body: JSON.stringify({ email, password }), signal }),
  signOut: async (signal: AbortSignal) => {
    // Sign-out may return an empty body; success is determined by the HTTP status.
    let response: Response
    try {
      response = await fetch('/api/auth/sign-out', { method: 'POST', mode: 'same-origin', credentials: 'same-origin', cache: 'no-store', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: '{}', signal })
    } catch (error) {
      if (signal.aborted) throw error
      throw new ApiError(0, 'ログアウトを完了できませんでした。再試行してください。')
    }
    if (!response.ok && response.status !== 401) throw new ApiError(response.status, 'ログアウトを完了できませんでした。再試行してください。')
  },
  list: (companyId: string, offset: number, signal: AbortSignal) => request(jobsPath(companyId) + `?offset=${offset}&limit=50`, value => {
    if (!record(value) || !Array.isArray(value.jobs) || !Number.isInteger(value.total) || Number(value.total) < 0) return invalid()
    return { jobs: value.jobs.map(companyJob(companyId)), total: Number(value.total) }
  }, { signal }),
  get: (companyId: string, jobId: string, signal: AbortSignal) => request(jobPath(companyId, jobId), value => {
    const job = companyJob(companyId)(value)
    return job.id === jobId ? job : invalid()
  }, { signal }),
  create: (companyId: string, input: JobInput, key: string, signal: AbortSignal) => request(jobsPath(companyId), companyJob(companyId), { method: 'POST', headers: { 'Idempotency-Key': key }, body: JSON.stringify(input), signal }),
  update: (companyId: string, jobId: string, input: JobInput, version: number, signal: AbortSignal) => request(jobPath(companyId, jobId), value => {
    const job = companyJob(companyId)(value)
    return job.id === jobId ? job : invalid()
  }, { method: 'PATCH', body: JSON.stringify({ ...input, version }), signal }),
  audit: (companyId: string, jobId: string, signal: AbortSignal, cursor: string | null = null) => {
    const query = new URLSearchParams({ limit: '50' })
    if (cursor !== null) query.set('cursor', cursor)
    return request(`${jobPath(companyId, jobId)}/audit?${query}`, (value): AuditPage => {
      if (!record(value) || !Array.isArray(value.events) || value.events.length > 50 || !value.events.every(e => record(e) && strings(e, ['id', 'actorId', 'actorName', 'action', 'occurredAt', 'requestId']) && Number.isSafeInteger(e.targetVersion) && Number(e.targetVersion) > 0 && (e.beforeData === null || record(e.beforeData)) && (e.afterData === null || record(e.afterData)))) return invalid()
      const events = value.events as AuditEvent[]
      if (new Set(events.map(event => event.id)).size !== events.length || events.some((event, index) => event.targetVersion >= (index ? events[index - 1].targetVersion : cursor === null ? Infinity : Number(cursor)))) return invalid()
      if (value.nextCursor !== null && (typeof value.nextCursor !== 'string' || !/^[1-9]\d*$/.test(value.nextCursor) || !Number.isSafeInteger(Number(value.nextCursor)) || Number(value.nextCursor) !== events.at(-1)?.targetVersion)) return invalid()
      return { events, nextCursor: value.nextCursor as string | null }
    }, { signal })
  },
}
export function errorMessage(error: unknown): string {
  return error instanceof ApiError ? error.message : '処理できませんでした。再試行してください。'
}
