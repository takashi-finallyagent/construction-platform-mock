import { ApiError } from './api'
import { TRADE_CATALOG } from './classification-model'
import type { ClassificationData, ClassificationView, ClassificationRecord, ClassificationPut, ClassificationAuditPage, JobBasis } from './classification-model'

type Obj = Record<string, unknown>
type Guard = (value: unknown) => boolean
const object = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v)
const exact = (v: unknown, fields: Record<string, Guard>): boolean => object(v) && Object.keys(v).length === Object.keys(fields).length && Object.entries(fields).every(([k, check]) => check(v[k]))
const text: Guard = v => typeof v === 'string'
const nullableText: Guard = v => v === null || text(v)
const integer: Guard = v => Number.isInteger(v) && Number(v) > 0 && Number(v) <= 2147483647
const uuid: Guard = v => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)
const iso: Guard = v => typeof v === 'string' && /^\d{4}-\d\d-\d\dT/.test(v) && Number.isFinite(Date.parse(v))
const date: Guard = v => v === null || typeof v === 'string' && /^\d{4}-\d\d-\d\d$/.test(v) && Number.isFinite(Date.parse(v)) && new Date(v).toISOString().slice(0, 10) === v
const choice = (...values: string[]): Guard => v => typeof v === 'string' && values.includes(v)
const bounded = (max: number, min = 0): Guard => v => typeof v === 'string' && [...v.trim()].length >= min && [...v.trim()].length <= max
const codes = new Set<string>(TRADE_CATALOG.map(t => t.code))
const trades: Guard = v => Array.isArray(v) && v.length > 0 && v.length <= 29 && new Set(v).size === v.length && v.every(code => typeof code === 'string' && codes.has(code))
const money: Guard = v => exact(v, { yen: v => typeof v === 'string' && /^(0|[1-9][0-9]{0,11})$/.test(v), taxBasis: choice('tax_included', 'tax_excluded', 'unknown') })
const answer = (value: Guard, allowNA = false): Guard => v => object(v) && exact(v, { state: text, value: () => true, reason: nullableText }) && (
  ['unanswered', 'unknown'].includes(String(v.state)) ? v.value === null && v.reason === null :
    v.state === 'known' ? value(v.value) && v.reason === null :
      v.state === 'not_applicable' && allowNA && v.value === null && bounded(300, 1)(v.reason))
const yesNo = answer(choice('yes', 'no'))

export function validClassificationData(v: unknown): v is ClassificationData {
  if (!exact(v, {
    schemaVersion: v => v === 1,
    context: v => exact(v, { market: answer(choice('private', 'public')), companyRole: answer(choice('prime_contractor', 'subcontractor', 'owner', 'other')), workKind: answer(choice('repair', 'renovation', 'demolition', 'new_build', 'other')), targetKind: answer(choice('building', 'structure', 'other')) }),
    workItems: v => Array.isArray(v) && v.length <= 12 && v.every(item => exact(item, { id: uuid, description: bounded(300, 1), tradeCandidates: answer(trades), relationship: answer(choice('primary', 'ancillary', 'independent')), parentItemId: v => v === null || uuid(v) })),
    amounts: v => exact(v, { contract: answer(money), suppliedMaterials: yesNo, suppliedMaterialValue: answer(money, true), suppliedMaterialTransport: answer(money, true), splitContracts: yesNo, relatedContractValue: answer(money, true), splitReason: answer(bounded(500, 1), true), subcontracting: yesNo, subcontractTotal: answer(money, true) }),
    permit: v => exact(v, { declaration: answer(choice('held', 'not_held', 'renewal_pending')), reportedTrades: answer(trades), note: bounded(1000) }),
    conditions: v => exact(v, { electricalWork: yesNo, existingStructureWork: yesNo, demolitionWork: yesNo, specifiedMaterials: yesNo, constructionWaste: yesNo, structuralChange: yesNo }),
    note: bounded(2000),
  })) return false
  const data = v as ClassificationData
  const items = data.workItems
  if (new Set(items.map(i => i.id)).size !== items.length || items.filter(i => i.relationship.state === 'known' && i.relationship.value === 'primary').length > 1) return false
  for (const item of items) {
    if (item.relationship.state === 'known' && item.relationship.value === 'ancillary') {
      const parent = items.find(p => p.id === item.parentItemId && p.id !== item.id)
      if (!parent || parent.relationship.state !== 'known' || !['primary', 'independent'].includes(parent.relationship.value)) return false
    } else if (item.parentItemId !== null) return false
  }
  const a = data.amounts
  for (const [parent, children] of [[a.suppliedMaterials, [a.suppliedMaterialValue, a.suppliedMaterialTransport]], [a.splitContracts, [a.relatedContractValue, a.splitReason]], [a.subcontracting, [a.subcontractTotal]]] as const) {
    const no = parent.state === 'known' && parent.value === 'no'
    if (children.some(child => no ? child.state === 'known' : child.state === 'not_applicable')) return false
  }
  return !(data.permit.declaration.state === 'known' && data.permit.declaration.value === 'not_held' && data.permit.reportedTrades.state === 'known')
}
function fail(): never { throw new ApiError(0, '確認事項の応答形式を確認できません。再読込してください。') }
const basis: Guard = v => exact(v, { version: integer, name: text, siteAddress: text, customerName: text, workDescription: text, plannedStart: date, plannedEnd: date })
const actor: Guard = v => exact(v, { id: text, name: text })
function decodeRecord(v: unknown, companyId: string, jobId: string): ClassificationRecord {
  if (!exact(v, { companyId: v => v === companyId, jobId: v => v === jobId, version: integer, data: validClassificationData, basisJob: basis, rulesVersion: text, catalogVersion: text, createdBy: actor, createdAt: iso, updatedBy: actor, updatedAt: iso })) return fail()
  return v as ClassificationRecord
}
function decodeView(v: unknown, companyId: string, jobId: string): ClassificationView {
  if (!exact(v, {
    companyId: v => v === companyId, jobId: v => v === jobId, currentJob: basis, record: v => v === null || !!decodeRecord(v, companyId, jobId), currentRulesVersion: text, currentCatalogVersion: text,
    staleReasons: v => Array.isArray(v) && new Set(v).size === v.length && v.every(choice('job_changed', 'rules_changed', 'catalog_changed')),
    jobDifferences: v => Array.isArray(v) && v.length <= 6 && v.every(v => exact(v, { field: choice('name', 'siteAddress', 'customerName', 'workDescription', 'plannedStart', 'plannedEnd'), saved: nullableText, current: nullableText })),
    issues: v => Array.isArray(v) && v.every(v => exact(v, { id: text, code: text, path: text, kind: choice('missing', 'unknown', 'review', 'out_of_scope', 'stale'), title: text, sourceIds: v => Array.isArray(v) && v.every(text) })),
  })) return fail()
  return v as ClassificationView
}
const base = (companyId: string, jobId: string) => `/api/companies/${encodeURIComponent(companyId)}/jobs/${encodeURIComponent(jobId)}/classification`
async function request<T>(url: string, signal: AbortSignal, decode: (v: unknown) => T, body?: ClassificationPut): Promise<T> {
  let response: Response
  try { response = await fetch(url, { method: body ? 'PUT' : 'GET', signal, mode: 'same-origin', credentials: 'same-origin', cache: 'no-store', headers: { Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) }) }
  catch (error) { if (signal.aborted) throw error; throw new ApiError(0, '通信結果を確認できません。入力内容を保持しています。') }
  if (!response.ok) throw new ApiError(response.status, ({ 400: '入力の組合せ・金額・施工範囲を確認してください。', 401: '認証の有効期限が切れました。', 403: '保存・履歴参照の権限がありません。', 404: '対象の工事が見つかりません。', 409: '工事情報または回答の版が更新されています。', 413: '入力が大きすぎます。内容を短くしてください。' } as Record<number, string>)[response.status] ?? '処理結果を確認できません。現在の保存内容を確認してください。')
  let value: unknown
  try { value = await response.json() } catch { return fail() }
  return decode(value)
}
export const classificationApi = {
  get: (companyId: string, jobId: string, signal: AbortSignal) => request(base(companyId, jobId), signal, v => decodeView(v, companyId, jobId)),
  put: (companyId: string, jobId: string, body: ClassificationPut, signal: AbortSignal) => request(base(companyId, jobId), signal, v => {
    const view = decodeView(v, companyId, jobId)
    if (view.record?.version !== body.version + 1 || view.record.basisJob.version !== body.jobVersion) return fail()
    return view
  }, body),
  audit: (companyId: string, jobId: string, signal: AbortSignal, cursor: string | null = null) => {
    const query = new URLSearchParams({ limit: '50' }); if (cursor) query.set('cursor', cursor)
    return request(`${base(companyId, jobId)}/audit?${query}`, signal, (v): ClassificationAuditPage => {
      if (!exact(v, { events: Array.isArray, nextCursor: v => v === null || typeof v === 'string' && /^[1-9]\d*$/.test(v) && integer(Number(v)) })) return fail()
      const page = v as ClassificationAuditPage
      if (page.events.length > 50 || !page.events.every(e => exact(e, { id: uuid, companyId: v => v === companyId, jobId: v => v === jobId, targetVersion: integer, requestId: text, actorId: text, actorName: text, action: choice('classification.created', 'classification.updated'), occurredAt: iso, beforeData: v => v === null || !!decodeRecord(v, companyId, jobId), afterData: v => !!decodeRecord(v, companyId, jobId) }))) return fail()
      if (new Set(page.events.map(e => e.id)).size !== page.events.length || page.events.some((e, i) => e.targetVersion >= (i ? page.events[i - 1].targetVersion : cursor === null ? Infinity : Number(cursor)) || e.afterData.version !== e.targetVersion || (e.targetVersion === 1 ? e.beforeData !== null : e.beforeData?.version !== e.targetVersion - 1))) return fail()
      if (page.nextCursor !== null && Number(page.nextCursor) !== page.events.at(-1)?.targetVersion) return fail()
      return page
    })
  },
}
export const JOB_LABELS: Record<Exclude<keyof JobBasis, 'version'>, string> = { name: '工事名', siteAddress: '所在地', customerName: '発注者', workDescription: '施工内容', plannedStart: '開始予定日', plannedEnd: '終了予定日' }
