import { validDate } from './compliance.ts'

export const PAYMENT_RULE_VERSION = '2026-10-22.1'
export const PAYMENT_SOURCE = 'https://www.thr.mlit.go.jp/bumon/b06111/kenseibup/kensetsu_shido/kensetsu_shido_files/handbook_point.pdf'
export interface PaymentTerms {
  counterparty: string
  scope: string
  amountYen: number
  payerPermit: 'unknown' | 'none' | 'general' | 'special'
  payeeSpecial: 'unknown' | 'yes' | 'no'
  payeeSize: 'unknown' | 'individual' | 'small' | 'large'
  agreement: 'unknown' | 'unset' | 'agreed'
  schedule: { date: string; amountYen: number }[]
  handoverTerm: 'unknown' | 'none' | 'fixed'
}
export interface PaymentRecord {
  id: string
  recorder: string
  note: string
  recordedAt: string
  evidenceName: string
  evidence?: Blob
}
export interface PaymentRevision extends PaymentRecord {
  terms: PaymentTerms
  previousId: string | null
  ruleVersion: string
}
export const eventLabels = { completion: '完成通知を受けた', inspection: '検査を完了した', offer: '引渡しの申出を受けた', receipt: '上位業者から入金があった', payment: '下請へ支払った', void: '記録を訂正対象にした' } as const
export type PaymentEventKind = keyof typeof eventLabels
export interface PaymentEvent extends PaymentRecord {
  kind: PaymentEventKind
  date: string
  amountYen: number | null
  voids: string | null
}
export interface PaymentCase { id: string; revisions: PaymentRevision[]; events: PaymentEvent[] }
export const emptyTerms: PaymentTerms = { counterparty: '', scope: '', amountYen: 0, payerPermit: 'unknown', payeeSpecial: 'unknown', payeeSize: 'unknown', agreement: 'unknown', schedule: [], handoverTerm: 'unknown' }
export const money = (value: number) => `¥${value.toLocaleString('ja-JP')}`
const validMoney = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= 1_000_000_000_000
const dateValue = (value: string) => {
  if (!validDate(value) || value < '1900-01-01' || value > '2199-12-31') throw new Error('日付は1900年〜2199年の実在する日付を指定してください。')
  return new Date(`${value}T00:00:00Z`)
}
export function addDays(value: string, days: number) {
  const date = dateValue(value)
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10)
}
// Civil Code 140/143: exclude receipt day; use the next day's corresponding day,
// or the last day of the target month when that corresponding day does not exist.
export function monthDeadline(receivedOn: string) {
  const start = dateValue(addDays(receivedOn, 1))
  const last = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 2, 0))
  if (start.getUTCDate() > last.getUTCDate()) return last.toISOString().slice(0, 10)
  return new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, start.getUTCDate() - 1)).toISOString().slice(0, 10)
}
export function activeEvents(item: PaymentCase) {
  const voided = new Set(item.events.filter((event) => event.kind === 'void').map((event) => event.voids))
  return item.events.filter((event) => event.kind !== 'void' && !voided.has(event.id))
}
function validateRecord(record: PaymentRecord) {
  if (!record.id || !record.recorder.trim() || record.note.trim().length < 10) throw new Error('記録者と具体的な根拠・訂正理由（10文字以上）を入力してください。')
  if (!Number.isFinite(Date.parse(record.recordedAt))) throw new Error('記録日時が不正です。')
  if (record.evidence && (!(record.evidence instanceof Blob) || !record.evidence.size || record.evidence.size > 10 * 1024 * 1024 || !['application/pdf', 'image/png', 'image/jpeg'].includes(record.evidence.type) || !record.evidenceName.trim())) throw new Error('資料は10MB以下のPDF・JPEG・PNGを指定してください。')
}
export function revisePaymentCase(previous: PaymentCase | undefined, id: string, revision: PaymentRevision): PaymentCase {
  validateRecord(revision)
  if (!id || revision.previousId !== (previous?.revisions.at(-1)?.id ?? null)) throw new Error('他の更新が入りました。画面を開き直してください。')
  if (revision.ruleVersion !== PAYMENT_RULE_VERSION) throw new Error('期限ルールが変わりました。画面を開き直してください。')
  if (previous?.revisions.some((r) => r.id === revision.id)) throw new Error('同じ条件記録は登録済みです。')
  const t = revision.terms
  if (!t.counterparty.trim() || !t.scope.trim() || !validMoney(t.amountYen)) throw new Error('下請業者・工事範囲・税込契約総額（1円以上）を入力してください。')
  if (!['unknown', 'none', 'general', 'special'].includes(t.payerPermit) || !['unknown', 'yes', 'no'].includes(t.payeeSpecial) || !['unknown', 'individual', 'small', 'large'].includes(t.payeeSize) || !['unknown', 'unset', 'agreed'].includes(t.agreement) || !['unknown', 'none', 'fixed'].includes(t.handoverTerm)) throw new Error('取引条件の選択が不正です。')
  if (t.agreement === 'agreed') {
    if (!t.schedule.length || t.schedule.length > 36) throw new Error('契約の支払期日を1件以上、36件以下で登録してください。')
    for (const row of t.schedule) { dateValue(row.date); if (!validMoney(row.amountYen)) throw new Error('各支払額は1円以上の整数にしてください。') }
    if (t.schedule.reduce((sum, row) => sum + row.amountYen, 0) !== t.amountYen) throw new Error('支払予定の合計を税込契約総額と一致させてください。')
  } else if (t.schedule.length) throw new Error('期日が未確認・未設定の場合は支払予定を空にしてください。')
  const events = previous ? activeEvents(previous) : []
  for (const kind of ['receipt', 'payment']) {
    if (events.filter((event) => event.kind === kind).reduce((sum, event) => sum + (event.amountYen ?? 0), 0) > t.amountYen) throw new Error('契約総額を記録済みの入金対応額・支払額より小さくできません。先に誤記録を訂正してください。')
  }
  return { id, revisions: [...(previous?.revisions ?? []), revision], events: previous?.events ?? [] }
}
export function appendPaymentEvent(item: PaymentCase, event: PaymentEvent, today: string): PaymentCase {
  validateRecord(event); dateValue(today); dateValue(event.date)
  if (event.date > today) throw new Error('実績日は今日以前の日付にしてください。支払予定は取引条件に記録します。')
  if (!Object.hasOwn(eventLabels, event.kind)) throw new Error('記録の種類が不正です。')
  if (item.events.some((record) => record.id === event.id)) throw new Error('同じ実績は登録済みです。')
  const active = activeEvents(item)
  if (event.kind === 'void') {
    if (!active.some((record) => record.id === event.voids)) throw new Error('訂正対象の記録が見つかりません。')
    if (event.amountYen !== null) throw new Error('訂正操作に金額は指定できません。')
  } else {
    if (event.voids !== null) throw new Error('訂正対象が不正です。')
    if (event.kind === 'payment' || event.kind === 'receipt') {
      if (!validMoney(event.amountYen)) throw new Error('金額は1円以上の整数にしてください。')
      const total = active.filter((record) => record.kind === event.kind).reduce((sum, record) => sum + (record.amountYen ?? 0), 0) + event.amountYen
      if (total > item.revisions.at(-1)!.terms.amountYen) throw new Error('累計額が契約総額を超えています。重複・対応する工事範囲を確認してください。')
      if (event.kind === 'payment' && !event.evidence) throw new Error('支払実績には振込結果・領収書等の資料を添付してください。振込予約は実績ではありません。')
    } else {
      if (event.amountYen !== null) throw new Error('この記録には金額を指定できません。')
      if (active.some((record) => record.kind === event.kind)) throw new Error('同じ種類の基準日は登録済みです。誤りは履歴から訂正してください。')
      const completion = active.find((record) => record.kind === 'completion')
      const inspection = active.find((record) => record.kind === 'inspection')
      if (event.kind === 'inspection' && (!completion || event.date < completion.date)) throw new Error('先に完成通知日を記録し、それ以降の検査完了日を指定してください。')
      if (event.kind === 'completion' && inspection && event.date > inspection.date) throw new Error('完成通知日が検査完了日より後です。記録を確認してください。')
    }
  }
  return { ...item, events: [...item.events, event] }
}
export interface PaymentDeadline { id: string; label: string; date: string; amountYen: number; provisional: boolean }
export function assessPayment(item: PaymentCase, today: string) {
  dateValue(today)
  const revision = item.revisions.at(-1)!
  const t = revision.terms
  const active = activeEvents(item).filter((event) => event.date <= today)
  const payments = active.filter((e) => e.kind === 'payment').sort((a, b) => a.date.localeCompare(b.date))
  const paidAt = (date: string) => payments.filter((e) => e.date <= date).reduce((sum, e) => sum + (e.amountYen ?? 0), 0)
  const paidYen = paidAt(today)
  const remainingYen = Math.max(0, t.amountYen - paidYen)
  const issues: string[] = []
  const staleRule = revision.ruleVersion !== PAYMENT_RULE_VERSION
  if (staleRule) issues.push('計算ルールが更新されています。取引条件と適用時期を再確認してください。')
  const licensed = t.payerPermit === 'general' || t.payerPermit === 'special'
  const fifty = t.payerPermit === 'none' || t.payerPermit === 'general' || t.payeeSpecial === 'yes' || t.payeeSize === 'large' ? false
    : t.payerPermit === 'special' && t.payeeSpecial === 'no' && ['individual', 'small'].includes(t.payeeSize) ? true : null
  if (t.payerPermit === 'unknown') issues.push('支払う側の建設業許可が未確認です。法定期限の適用を確定できません。')
  if (t.payerPermit === 'none') issues.push('許可なしの取引です。契約・民法等の義務を別途確認してください。')
  if (fifty === null) issues.push('50日ルールの適用条件（特定許可・下請の資本金等）が未確認です。')
  if (t.agreement !== 'agreed') issues.push(t.agreement === 'unset' ? '支払期日の合意がありません。契約条件の是正が必要です。' : '契約の支払期日が未確認です。')
  const deadlines: PaymentDeadline[] = []
  let contractSum = 0
  for (const [index, row] of [...t.schedule].sort((a, b) => a.date.localeCompare(b.date)).entries()) {
    contractSum += row.amountYen
    deadlines.push({ id: `contract-${index}`, label: '契約期日', date: row.date, amountYen: contractSum, provisional: false })
  }
  const receipts = active.filter((e) => e.kind === 'receipt').sort((a, b) => a.date.localeCompare(b.date))
  if (!receipts.length) issues.push('上位業者の入金実績が未登録です。未入金とは判定していません。')
  let receiptSum = 0
  for (const receipt of receipts) {
    receiptSum += receipt.amountYen ?? 0
    if (t.payerPermit !== 'none') deadlines.push({ id: receipt.id, label: '入金から1か月（24条の3）', date: monthDeadline(receipt.date), amountYen: receiptSum, provisional: !licensed })
  }
  const completion = active.find((e) => e.kind === 'completion')
  const inspection = active.find((e) => e.kind === 'inspection')
  const offer = active.find((e) => e.kind === 'offer')
  if (inspection && !completion) issues.push('検査の基準となる完成通知日が訂正対象です。正しい日付を再登録してください。')
  const inspectionDate = completion && t.payerPermit !== 'none' ? addDays(completion.date, 20) : null
  const inspectionLate = !!inspectionDate && (inspection ? inspection.date > inspectionDate : today > inspectionDate)
  const inspectionUnconfirmed = !!offer && (!inspection || inspection.date > offer.date)
  if (inspectionUnconfirmed) issues.push('引渡申出の前提となる完成検査が未確認です。管理上は申出日を基準に警告します。')
  if (fifty !== false) {
    if (!offer) issues.push('引渡申出日が未登録です。50日ルールの基準日を確認してください。')
    if (t.handoverTerm !== 'none') issues.push('引渡特約が未確認または設定されています。特約による期限延長は反映せず、申出日を仮の基準にします。')
    if (offer) {
      const provisional = fifty === null || t.handoverTerm !== 'none' || inspectionUnconfirmed
      deadlines.push({ id: 'fifty', label: '引渡申出から50日（24条の6）', date: addDays(offer.date, 49), amountYen: t.amountYen, provisional })
      if (t.agreement !== 'agreed') deadlines.push({ id: 'unset', label: '期日未設定時の申出日（24条の6第2項）', date: offer.date, amountYen: t.amountYen, provisional: provisional || t.agreement === 'unknown' })
    }
  }
  // Competing rules cover the same debt. Use cumulative maxima, never add their amounts.
  const assessed = deadlines.sort((a, b) => a.date.localeCompare(b.date)).map((deadline) => ({ ...deadline,
    provisional: deadline.provisional || staleRule,
    unpaidYen: Math.max(0, deadline.amountYen - paidYen),
    lateYen: deadline.date < today ? Math.max(0, deadline.amountYen - paidAt(deadline.date)) : 0,
  }))
  const overdueYen = Math.max(0, ...assessed.filter((d) => d.date < today).map((d) => d.unpaidYen))
  const next = assessed.find((d) => d.unpaidYen > 0)
  const lateHistory = assessed.some((d) => d.lateYen > 0) || inspectionLate
  const inspectionAttention = !!inspectionDate && !inspection && inspectionDate <= addDays(today, 7)
  return { terms: t, issues, deadlines: assessed, paidYen, remainingYen, overdueYen, next, lateHistory,
    inspection: { due: inspectionDate, completedOn: inspection?.date ?? null, late: inspectionLate, provisional: !licensed || staleRule, attention: inspectionAttention },
    attention: overdueYen > 0 || inspectionAttention || !!next && next.date <= addDays(today, 7),
  }
}
