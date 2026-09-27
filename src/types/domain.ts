export type Role =
  | '会社オーナー'
  | '管理者'
  | '経理'
  | '営業'
  | '現場責任者'
  | '一般社員'
  | '協力会社'
  | '閲覧のみ'

export type NoticeLevel = 'INFO' | 'WARNING' | 'CONFIRM'

export type SiteStatus = '準備中' | '施工中' | '完了' | '保留' | '中止'

export type Direction = '受注' | '発注'

export type TransactionKind =
  | '建設工事'
  | '人工・応援'
  | '資材'
  | '機材・車両'
  | '業務委託'
  | 'その他'

export type TransactionStatus =
  | '見積中'
  | '発注予定'
  | '契約待ち'
  | '契約済'
  | '施工中'
  | '完了'
  | '請求済'

export type ContractStatus =
  | '作成中'
  | '相手確認中'
  | '合意済'
  | '締結済'
  | '変更あり'
  | '完了'

export type InvoiceStatus =
  | '未請求'
  | '作成中'
  | '発行済'
  | '入金待ち'
  | '入金済'
  | '一部入金'

export type PermissionKey =
  | 'amounts'
  | 'contracts'
  | 'costs'
  | 'invoices'
  | 'employees'
  | 'sites'
  | 'licenses'

export interface Company {
  id: string
  name: string
  type: '元請' | '一次下請' | '二次下請' | '資材会社' | '個人事業主'
  representative: string
  address: string
  phone: string
  email: string
  constructionLicenseNo?: string
  invoiceNo?: string
  bankAccount?: string
}

export interface User {
  id: string
  name: string
  companyId: string
  role: Role
}

export interface Employee {
  id: string
  name: string
  companyId: string
  employmentType: '正社員' | '契約社員' | '個人事業主' | '協力会社'
  trade: string
  position: string
  joinedAt: string
  leftAt?: string
  canDrive: boolean
  qualifications: string[]
  note: string
}

export interface Site {
  id: string
  companyId: string
  name: string
  address: string
  client: string
  primeCompanyId: string
  startDate: string
  endDate: string
  status: SiteStatus
  ownRole: '元請' | '下請' | '協力会社'
  managerId: string
  chiefEngineer: string
  supervisingEngineer?: string
  constructionType: string
  description: string
  contractAmount: number
  headcountToday: number
  memo: string
}

export interface SiteCompany {
  id: string
  siteId: string
  companyId: string
  role: '元請' | '一次下請' | '二次下請' | '資材会社'
}

export interface Transaction {
  id: string
  companyId: string
  siteId: string
  number: string
  partnerCompanyId: string
  direction: Direction
  kind: TransactionKind
  amount: number
  status: TransactionStatus
  createdAt: string
  complianceNote?: string
  confirmedException?: boolean
}

export interface EstimateItem {
  id: string
  category:
    | '材料費'
    | '労務費'
    | '法定福利費'
    | '安全衛生経費'
    | '外注費'
    | '諸経費'
    | 'その他'
  name: string
  quantity: number
  unit: string
  unitPrice: number
}

export interface Estimate {
  id: string
  companyId: string
  siteId: string
  number: string
  partnerCompanyId: string
  subject: string
  description: string
  items: EstimateItem[]
  taxRate: number
  expiresAt: string
  note: string
}

export interface ContractRevision {
  id: string
  title: string
  amount: number
  changedAt: string
  reason: string
}

export interface Contract {
  id: string
  companyId: string
  siteId: string
  number: string
  buyerCompanyId: string
  sellerCompanyId: string
  content: string
  amount: number
  startDate: string
  endDate: string
  paymentTerms: string
  contractDate: string
  status: ContractStatus
  revisions: ContractRevision[]
}

export interface MaterialOrder {
  id: string
  siteId: string
  supplierCompanyId: string
  productName: string
  specification: string
  quantity: number
  unit: string
  unitPrice: number
  desiredDeliveryDate: string
  deliveryPlace: string
  note: string
}

export interface WorkSchedule {
  id: string
  date: string
  siteId: string
  employeeIds: string[]
  vehicle: string
}

export interface DailyReport {
  id: string
  date: string
  siteId: string
  weather: string
  startTime: string
  endTime: string
  workDescription: string
  workerIds: string[]
  quantity: string
  note: string
  photoCount: number
}

export interface Invoice {
  id: string
  siteId: string
  partnerCompanyId: string
  number: string
  issueDate: string
  amount: number
  dueDate: string
  status: InvoiceStatus
}

export interface DocumentRecord {
  id: string
  siteId: string
  relatedId: string
  type:
    | '見積書'
    | '注文書'
    | '注文請書'
    | '請負契約書'
    | '変更契約'
    | '請求書'
    | '資材発注書'
    | '日報'
    | 'その他'
  fileName: string
  createdAt: string
  evidenceLevel: '自己入力' | '相互確認済' | '確定済'
}

export interface License {
  id: string
  companyId: string
  licenseNo: string
  authority: '大臣' | '知事'
  classType: '一般' | '特定'
  trades: string[]
  expiresAt: string
}

export interface ExperienceRecord {
  id: string
  employeeId: string
  trade: string
  from: string
  to: string
  siteIds: string[]
  documentIds: string[]
}

export interface AuditLog {
  id: string
  at: string
  actor: string
  action: string
  target: string
}

export interface Notice {
  id: string
  level: NoticeLevel
  title: string
  body: string
  action: string
}
