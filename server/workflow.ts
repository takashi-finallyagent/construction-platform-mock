import { Ajv } from 'ajv'
import { isDeepStrictEqual } from 'node:util'
import type { Job } from '../src/product/api.ts'
import { documentTotals, type WorkflowData, type SitePhoto } from '../src/product/workflow-model.ts'
import { workflowSchema, photoSchema } from './workflow-schema.ts'
import { HttpError } from './jobs.ts'
import type { ClassificationView } from '../src/product/classification-model.ts'

const ajv = new Ajv({ strict: true, coerceTypes: false, removeAdditional: false, useDefaults: false })
const valid = ajv.compile(workflowSchema), validPhoto = ajv.compile(photoSchema)
export const failWorkflow = (message = '業務記録の入力内容と関連資料を確認してください。'): never => { throw new HttpError(400, message) }
function normalize(value: unknown, key = '', depth = 0): unknown {
  if (depth > 20) return failWorkflow()
  if (typeof value === 'string') {
    if (value.includes('\u0000') || /\p{Surrogate}/u.test(value)) return failWorkflow()
    const trimmed = value.trim()
    return /^(id|fileId|estimateId|originalContractId|contractId|invoiceId|reversesId|evidenceIds|photoIds|companyId|jobId)$/.test(key) ? trimmed.toLowerCase() : trimmed
  }
  if (Array.isArray(value)) return value.map(v => normalize(v,key,depth+1))
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k,v]) => [k,normalize(v,k,depth+1)]))
  return value
}
export function normalizePhoto(input: unknown): SitePhoto {
  const photo = normalize(input)
  if (!validPhoto(photo)) return failWorkflow()
  return photo as SitePhoto
}
export function normalizeWorkflow(input: unknown): WorkflowData {
  const data = normalize(input)
  if (!valid(data)) return failWorkflow()
  return data as WorkflowData
}
export function validateWorkflow(data: WorkflowData, previous: WorkflowData, job: Job, classificationVersion: number | null, classification: ClassificationView) {
  const issueIds=new Set(classification.issues.map(i=>i.id))
  const publications = ['estimates','contracts','notices','reports','invoices'] as const
  for (const section of publications) for (const old of previous[section]) {
    const current = data[section].find(v => v.id === old.id)
    if (old.status === 'issued' && !isDeepStrictEqual(current,old)) return failWorkflow('発行済みの文書は変更・削除できません。')
  }
  for (const section of ['reviews','contractEvents','payments','milestones'] as const) {
    if (!previous[section].every((old,i) => isDeepStrictEqual(data[section][i],old))) return failWorkflow('確定した履歴は変更・削除・並べ替えできません。')
  }
  if (data.payments.slice(previous.payments.length).some(payment=>payment.evidenceIds.length<1)) {
    return failWorkflow('入出金・取消の新しい記録には根拠資料を1件以上選択してください。')
  }
  for (const review of data.reviews.slice(previous.reviews.length)) {
    if (review.jobVersion !== job.version || review.classificationVersion !== classificationVersion || !issueIds.has(review.issueId)) return failWorkflow('確認対象の工事・分類を更新してください。')
  }
  if (data.contracts.some(c=>c.status==='issued' && previous.contracts.find(old=>old.id===c.id)?.status!=='issued')) {
    const record=classification.record
    if (!record) return failWorkflow('契約発行前に工事分類を保存してください。')
    if (classification.staleReasons.length) return failWorkflow('契約発行前に現在の工事・確認基準で分類を保存し直してください。')
    const context=record.data.context
    if (context.market.state!=='known' || context.market.value!=='private' || context.workKind.state!=='known' || !['repair','renovation'].includes(context.workKind.value)) {
      return failWorkflow('契約発行は、分類で確認した民間の修繕・改修工事が対象です。')
    }
    const unresolved=classification.issues.filter(i=>['missing','unknown','out_of_scope','stale'].includes(i.kind))
    if (unresolved.length) return failWorkflow(`契約発行前の入力確認：${unresolved[0].title}（未了${unresolved.length}件）。`)
    const pending=classification.issues.filter(issue=>issue.kind==='review').filter(issue=>{
      const review=data.reviews.filter(r=>r.issueId===issue.id && r.jobVersion===job.version && r.classificationVersion===classificationVersion).at(-1)
      return !review || !['confirmed','not_applicable'].includes(review.conclusion) || !review.note || !review.evidenceIds.length
    })
    if (pending.length) return failWorkflow(`契約発行前の資料確認：${pending[0].title}（未了${pending.length}件）。`)
  }
  // The database owns publication metadata and validates all persisted cross-record relationships.
  for (const document of [...data.estimates,...data.invoices]) {
    try { documentTotals(document) } catch { return failWorkflow('数量・単価・合計金額を確認してください。') }
  }
}
