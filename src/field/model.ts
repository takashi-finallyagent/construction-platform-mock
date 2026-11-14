import { sites } from '../data/mock/domain'
import type { ComplianceProfile, ComplianceReview } from './compliance'
import type { PaymentCase } from './payment'

export type PhotoPhase = 'before' | 'during' | 'after'
export const phaseLabels: Record<PhotoPhase, string> = { before: '施工前', during: '作業中', after: '完成' }
export const stageLabels = ['相談・見積', '受注・準備', '施工', '完了・請求'] as const
export type PaperKind = 'estimate' | 'order' | 'receipt' | 'invoice'
export interface PaperLine { name: string; quantity: number; unit: string; unitPrice: number; amount: number | null }
export interface NoticeInput {
  title: string; recipient: string; start: string; end: string; startTime: string; endTime: string
  work: string; impacts: string[]; extra: string
}
export const paperLabels: Record<PaperKind, string> = { estimate: '御見積書', order: '工事注文書', receipt: '注文請書', invoice: '請求書' }
export interface WorkTask {
  id: string
  name: string
  company: string
  start: string
  end: string
  startTime: string
  endTime: string
  status: '未着手' | '作業中' | '完了'
}
export interface FieldJob {
  id: string
  name: string
  building: string
  part: string
  company: string
  client: string
  contact: string
  stage: number
  start: string
  end: string
  tasks: WorkTask[]
  paperLines?: PaperLine[]
  paperDueDate?: string
  noticeDraft?: NoticeInput
  complianceProfile?: ComplianceProfile
  complianceReviews?: ComplianceReview[]
  paymentCases?: PaymentCase[]
}
export interface FieldPhoto {
  id: string
  jobId: string
  phase: PhotoPhase
  part: string
  caption: string
  takenAt: string | null
  savedAt: string
  source: 'camera' | 'device-camera'
  blob: Blob
}
export interface IssuedDocument {
  id: string
  jobId: string
  title: string
  kind: 'notice' | 'album' | 'schedule' | PaperKind
  filename: string
  createdAt: string
  blob: Blob
}
export interface FieldWorkspace { version: 1; jobs: FieldJob[] }

export function localDate(date = new Date()) {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Tokyo' }).format(date)
}
export function shiftDate(value: string, offset: number) {
  const date = new Date(`${value}T12:00:00+09:00`)
  date.setDate(date.getDate() + offset)
  return localDate(date)
}
export function uid() { return crypto.randomUUID() }
export function formatDay(value: string) {
  return new Intl.DateTimeFormat('ja-JP', { month: 'numeric', day: 'numeric', weekday: 'short', timeZone: 'Asia/Tokyo' }).format(new Date(`${value}T12:00:00+09:00`))
}
export function formatTime(value: string) {
  return new Intl.DateTimeFormat('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Tokyo' }).format(new Date(value))
}

export function seedWorkspace(): FieldWorkspace {
  const today = localDate()
  return { version: 1, jobs: [
    {
      id: 'sample-door', name: '201号室 玄関ドア修繕', building: 'サンプルマンション', part: '201号室 / 玄関ドア',
      company: 'ABC建設株式会社', client: 'サンプル管理株式会社', contact: '045-000-1000', stage: 2,
      start: today, end: today,
      tasks: [
        { id: 'door-1', name: '養生・施工前確認', company: 'ABC建設', start: today, end: today, startTime: '09:00', endTime: '09:30', status: '完了' },
        { id: 'door-2', name: '丁番調整・クローザー交換', company: 'ABC建設', start: today, end: today, startTime: '09:30', endTime: '11:30', status: '作業中' },
        { id: 'door-3', name: '動作確認・清掃・完成写真', company: 'ABC建設', start: today, end: today, startTime: '11:30', endTime: '12:00', status: '未着手' },
      ],
    },
    ...sites.map((site, i) => ({
      id: site.id, name: site.name, building: site.name.replace(/(改修|新築)工事$/, ''), part: '共用部', company: 'ABC建設株式会社',
      client: site.client, contact: '045-000-1000', stage: site.status === '準備中' ? 1 : 2,
      start: site.startDate, end: site.endDate,
      tasks: [
        { id: `${site.id}-1`, name: i === 0 ? '給排水配管更新' : '設備施工', company: '山田設備', start: today, end: shiftDate(today, 2), startTime: '09:00', endTime: '17:00', status: '作業中' as const },
        { id: `${site.id}-2`, name: '検査・完成写真', company: 'ABC建設', start: shiftDate(today, 3), end: shiftDate(today, 3), startTime: '09:00', endTime: '12:00', status: '未着手' as const },
      ],
    })),
  ] }
}
