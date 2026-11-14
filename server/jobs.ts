export type JobInput = {
  name: string
  siteAddress: string
  customerName: string
  workDescription: string
  plannedStart: string | null
  plannedEnd: string | null
}

export const jobProperties = {
  name: { type: 'string', minLength: 1, maxLength: 120, pattern: '\\S' },
  siteAddress: { type: 'string', minLength: 1, maxLength: 250, pattern: '\\S' },
  customerName: { type: 'string', minLength: 1, maxLength: 120, pattern: '\\S' },
  workDescription: { type: 'string', minLength: 1, maxLength: 2000, pattern: '\\S' },
  plannedStart: { anyOf: [{ type: 'string', format: 'date' }, { type: 'null' }] },
  plannedEnd: { anyOf: [{ type: 'string', format: 'date' }, { type: 'null' }] },
}

export const jobColumns = `id, company_id AS "companyId", name, site_address AS "siteAddress",
  customer_name AS "customerName", work_description AS "workDescription",
  to_char(planned_start, 'YYYY-MM-DD') AS "plannedStart", to_char(planned_end, 'YYYY-MM-DD') AS "plannedEnd",
  version, created_by AS "createdBy", created_at AS "createdAt", updated_at AS "updatedAt"`

export function normalizeJob(value: JobInput): JobInput {
  for (const date of [value.plannedStart, value.plannedEnd]) {
    const parsed = date === null ? null : new Date(`${date}T00:00:00Z`)
    if (date !== null && (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date < '1900-01-01' || date > '2199-12-31' ||
      !parsed || !Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date)) {
      throw new HttpError(400, '日付を確認してください。')
    }
  }
  if (value.plannedStart && value.plannedEnd && value.plannedEnd < value.plannedStart) throw new HttpError(400, '終了日は開始日以降にしてください。')
  return { name: value.name.trim(), siteAddress: value.siteAddress.trim(), customerName: value.customerName.trim(),
    workDescription: value.workDescription.trim(), plannedStart: value.plannedStart, plannedEnd: value.plannedEnd }
}

export class HttpError extends Error {
  statusCode: number
  constructor(statusCode: number, message: string) { super(message); this.statusCode = statusCode }
}
