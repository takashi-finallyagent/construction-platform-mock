import type { Job } from './api.ts'

export type MoneyText = string
export type LineItem = { id: string; description: string; category: 'material' | 'labor' | 'welfare' | 'safety' | 'retirement' | 'other'; quantity: string; unit: string; unitPrice: MoneyText }
export type TaxRate = '10' | '8' | '0'
export type Rounding = 'floor' | 'round' | 'ceil'
export type DocumentBasis = { job: Job; classificationVersion: number | null }
export type Publication = { status: 'draft' | 'issued'; issuedAt: string | null; issuedBy: string | null; basis: DocumentBasis | null }
export type ReviewRecord = { id: string; issueId: string; classificationVersion: number; jobVersion: number; conclusion: 'confirmed' | 'not_applicable' | 'needs_action'; reviewedOn: string; evidenceIds: string[]; note: string }
export type Estimate = Publication & { id: string; title: string; recipient: string; recipientAddress: string; issuer: string; issuerAddress: string; issuedOn: string; validUntil: string | null; items: LineItem[]; taxRate: TaxRate; rounding: Rounding; notes: string }
export const CONTRACT_TERM_LABELS = {
  scope: '施工範囲', exclusions: '含まない工事', startDate: '着工日', endDate: '完成日', handoverDate: '引渡日',
  workingHours: '施工時間', nonWorkingDays: '施工しない日', paymentTerms: '代金の支払時期・方法', inspectionTerms: '検査・引渡し',
  changeTerms: '設計・工期・内容変更の方法', priceChangeTerms: '価格変動時の変更・算定方法', suppliedTerms: '支給材料・貸与品',
  thirdPartyDamageTerms: '第三者への損害', forceMajeureTerms: '不可抗力の損害・負担', delayTerms: '履行遅滞・違約金',
  defectTerms: '契約不適合への対応', disputeTerms: '紛争の解決方法', riskNotice: '資材・工期等の事前通知事項',
} as const
export type ContractTerms = Record<keyof typeof CONTRACT_TERM_LABELS, string>
export type Contract = Publication & { id: string; title: string; estimateId: string; kind: 'initial' | 'change'; originalContractId: string | null; changeReason: string; effectiveDate: string | null; partyRole: 'receiving' | 'ordering'; counterparty: string; terms: ContractTerms }
export type ContractEvent = { id: string; contractId: string; type: 'delivered' | 'accepted' | 'change_requested' | 'cancelled'; eventDate: string; counterparty: string; evidenceIds: string[]; note: string }
export type ScheduleTask = { id: string; title: string; company: string; startsOn: string; endsOn: string; status: 'planned' | 'active' | 'done'; note: string }
export type SitePhoto = { id: string; fileId: string; phase: 'before' | 'during' | 'after'; caption: string; capturedAt: string | null; source: 'camera' | 'device-camera' | 'upload' }
export type Notice = Publication & { id: string; kind: 'construction' | 'change' | 'delay' | 'cancel' | 'complete'; title: string; recipient: string; startsOn: string; endsOn: string; timeFrom: string; timeTo: string; impacts: string[]; contactName: string; contactPhone: string; message: string }
export type PhotoReport = Publication & { id: string; title: string; photoIds: string[]; photoSnapshot: SitePhoto[] | null; notes: string }
export type Invoice = Publication & { id: string; number: string; direction: 'receivable' | 'payable'; contractId: string; recipient: string; issuer: string; issuedOn: string; dueOn: string; bank: string; registrationNumber: string; items: LineItem[]; taxRate: TaxRate; rounding: Rounding; notes: string }
export type PaymentRecord = { id: string; invoiceId: string; type: 'payment' | 'reversal'; reversesId: string | null; paidOn: string; amountYen: MoneyText; method: string; reference: string; evidenceIds: string[]; note: string }
export type Milestone = { id: string; contractId: string; type: 'completion_notice' | 'inspection' | 'handover_offer' | 'handover' | 'upstream_receipt'; eventDate: string; amountYen: MoneyText | null; evidenceIds: string[]; note: string }
export type LaborInsurance = { arrangement: 'unknown' | 'blanket' | 'individual'; principalName: string; insuranceNumber: string; startsOn: string | null; endsOn: string | null; evidenceIds: string[]; note: string }
export type WorkflowData = { schemaVersion: 1; reviews: ReviewRecord[]; estimates: Estimate[]; contracts: Contract[]; contractEvents: ContractEvent[]; tasks: ScheduleTask[]; photos: SitePhoto[]; notices: Notice[]; reports: PhotoReport[]; invoices: Invoice[]; payments: PaymentRecord[]; milestones: Milestone[]; laborInsurance: LaborInsurance }
export type WorkflowView = { companyId: string; jobId: string; version: number; jobVersion: number; classificationVersion: number | null; data: WorkflowData; updatedAt: string | null; updatedBy: string | null }
export type WorkflowPut = { version: number; jobVersion: number; classificationVersion: number | null; data: WorkflowData }
export type StoredFile = { id: string; companyId: string; jobId: string; name: string; contentType: string; size: number; sha256: string; kind: 'photo' | 'evidence'; createdAt: string; createdBy: string }
export type WorkflowAudit = { id: string; version: number; actorName: string; occurredAt: string; beforeData: WorkflowData | null; afterData: WorkflowData }
export type WorkflowSectionProps = { job: Job; companyName: string; data: WorkflowData; files: StoredFile[]; readOnly: boolean; busy: boolean; userId: string; onChange: (data: WorkflowData) => void; onSave: (data: WorkflowData) => Promise<boolean>; onUpload: (file: Blob, name: string, kind: StoredFile['kind'], id?: string) => Promise<StoredFile>; onPhoto: (photo: SitePhoto) => Promise<boolean>; fileUrl: (id: string) => string; onTransientDirty?: (dirty: boolean) => void }
export const draftPublication = (): Publication => ({ status: 'draft', issuedAt: null, issuedBy: null, basis: null })
export const emptyTerms = (): ContractTerms => Object.fromEntries(Object.keys(CONTRACT_TERM_LABELS).map(key => [key, ''])) as ContractTerms
export const emptyWorkflow = (): WorkflowData => ({ schemaVersion: 1, reviews: [], estimates: [], contracts: [], contractEvents: [], tasks: [], photos: [], notices: [], reports: [], invoices: [], payments: [], milestones: [], laborInsurance: { arrangement: 'unknown', principalName: '', insuranceNumber: '', startsOn: null, endsOn: null, evidenceIds: [], note: '' } })
export function lineTotal(item: LineItem): bigint {
  if (!/^(0|[1-9]\d{0,8})(\.\d{1,2})?$/.test(item.quantity) || !/^(0|[1-9]\d{0,11})$/.test(item.unitPrice)) throw new Error('数量・単価を確認してください。')
  const [whole, fraction = ''] = item.quantity.split('.')
  return (BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'))) * BigInt(item.unitPrice) / 100n
}
export function documentTotals(document: { items: LineItem[]; taxRate: TaxRate; rounding: Rounding }) {
  const subtotal = document.items.reduce((sum, item) => sum + lineTotal(item), 0n)
  const rate = { '10': 10n, '8': 8n, '0': 0n }[document.taxRate]
  if (rate === undefined || !['floor', 'round', 'ceil'].includes(document.rounding)) throw new Error('税の設定を確認してください。')
  const numerator = subtotal * rate
  const tax = (numerator + (document.rounding === 'round' ? 50n : document.rounding === 'ceil' ? 99n : 0n)) / 100n
  const total = subtotal + tax
  if (total > 999999999999n) throw new Error('合計金額が上限を超えています。')
  return { subtotal: subtotal.toString(), tax: tax.toString(), total: total.toString() }
}
export function invoicePaid(data: WorkflowData, invoiceId: string): string {
  return data.payments.filter(p => p.invoiceId === invoiceId).reduce((sum, p) => sum + (p.type === 'reversal' ? -1n : 1n) * BigInt(p.amountYen), 0n).toString()
}
export const yen = (value: string) => `${BigInt(value).toLocaleString('ja-JP')} 円`
