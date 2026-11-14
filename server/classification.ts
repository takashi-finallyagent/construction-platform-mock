import { classificationSchema } from './classification-schema.ts'
import { Ajv } from 'ajv'
import { HttpError } from './jobs.ts'
import { deriveClassificationIssues } from './classification-issues.ts'
import { CATALOG_VERSION, RULES_VERSION, type ClassificationData, type ClassificationRecord,
  type ClassificationView, type JobBasis } from '../src/product/classification-model.ts'

const valid = new Ajv({ strict: true, coerceTypes: false, removeAdditional: false, useDefaults: false }).compile(classificationSchema)
function trim(value: unknown, depth = 0): unknown {
  if (depth > 32) throw new HttpError(400, '入力内容を確認してください。')
  if (typeof value === 'string') {
    // PostgreSQL JSONB cannot represent NUL or unmatched UTF-16 surrogate code units.
    if (value.includes('\u0000') || /\p{Surrogate}/u.test(value)) throw new HttpError(400, '入力内容を確認してください。')
    return value.trim()
  }
  if (Array.isArray(value)) return value.map(v => trim(v,depth+1))
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k,v]) => [k,trim(v,depth+1)]))
  return value
}
export function normalizeClassification(input: unknown): ClassificationData {
  const value = trim(input)
  const fail = () => { throw new HttpError(400, '入力内容を確認してください。') }
  if (!valid(value)) fail()
  const data = value as ClassificationData
  const ids = new Set(data.workItems.map(item => item.id.toLowerCase()))
  if (ids.size !== data.workItems.length || data.workItems.filter(i => i.relationship.state === 'known' && i.relationship.value === 'primary').length > 1) fail()
  for (const item of data.workItems) {
    item.id = item.id.toLowerCase()
    item.parentItemId = item.parentItemId?.toLowerCase() ?? null
    if (item.relationship.state === 'known' && item.relationship.value === 'ancillary') {
      const parent = data.workItems.find(p => p.id.toLowerCase() === item.parentItemId)
      if (!parent || parent.id.toLowerCase() === item.id || parent.relationship.state !== 'known'
        || !['primary','independent'].includes(parent.relationship.value)) fail()
    } else if (item.parentItemId !== null) fail()
  }
  const a = data.amounts
  for (const [parent, child] of [[a.suppliedMaterials,a.suppliedMaterialValue],[a.suppliedMaterials,a.suppliedMaterialTransport],
    [a.splitContracts,a.relatedContractValue],[a.splitContracts,a.splitReason],[a.subcontracting,a.subcontractTotal]] as const) {
    const no = parent.state === 'known' && parent.value === 'no'
    if (no && child.state === 'known' || !no && child.state === 'not_applicable') fail()
  }
  if (data.permit.declaration.state === 'known' && data.permit.declaration.value === 'not_held' && data.permit.reportedTrades.state === 'known') fail()
  return data
}

export const basisSql = (alias: string) => `jsonb_build_object('version',${alias}.version,'name',${alias}.name,
  'siteAddress',${alias}.site_address,'customerName',${alias}.customer_name,'workDescription',${alias}.work_description,
  'plannedStart',to_char(${alias}.planned_start,'YYYY-MM-DD'),'plannedEnd',to_char(${alias}.planned_end,'YYYY-MM-DD'))`

export const recordSql = (alias: string) => `CASE WHEN ${alias}.job_id IS NULL THEN NULL ELSE jsonb_build_object(
  'companyId',${alias}.company_id,'jobId',${alias}.job_id,'version',${alias}.version,'data',${alias}.data,
  'basisJob',${alias}.basis_job_snapshot,'rulesVersion',${alias}.rules_version,'catalogVersion',${alias}.catalog_version,
  'createdBy',jsonb_build_object('id',${alias}.created_by,'name',${alias}.created_by_name),
  'updatedBy',jsonb_build_object('id',${alias}.updated_by,'name',${alias}.updated_by_name),
  'createdAt',to_char(${alias}.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  'updatedAt',to_char(${alias}.updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) END`

export function classificationView(companyId: string, jobId: string, currentJob: JobBasis, record: ClassificationRecord | null): ClassificationView {
  const staleReasons: ClassificationView['staleReasons'] = []
  if (record) {
    if (record.basisJob.version !== currentJob.version) staleReasons.push('job_changed')
    if (record.rulesVersion !== RULES_VERSION) staleReasons.push('rules_changed')
    if (record.catalogVersion !== CATALOG_VERSION) staleReasons.push('catalog_changed')
  }
  const fields = ['name','siteAddress','customerName','workDescription','plannedStart','plannedEnd'] as const
  return { companyId, jobId, currentJob, record, currentRulesVersion: RULES_VERSION, currentCatalogVersion: CATALOG_VERSION,
    staleReasons, jobDifferences: record ? fields.filter(f => record.basisJob[f] !== currentJob[f])
      .map(field => ({ field, saved: record.basisJob[field], current: currentJob[field] })) : [],
    issues: deriveClassificationIssues(record?.data ?? null,currentJob,staleReasons) }
}
