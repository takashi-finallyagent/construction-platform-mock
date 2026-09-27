import {
  createContext,
  type FormEvent,
  type ReactNode,
  useContext,
  useMemo,
  useState,
} from 'react'
import {
  createHashRouter,
  Link,
  NavLink,
  Outlet,
  RouterProvider,
  useNavigate,
  useParams,
} from 'react-router'
import {
  AlertTriangle,
  BriefcaseBusiness,
  Building2,
  CalendarDays,
  CheckCircle2,
  ChevronRight,
  ClipboardList,
  EyeOff,
  FileSignature,
  FileText,
  FolderArchive,
  Hammer,
  Home,
  Info,
  LogIn,
  Menu,
  NotebookText,
  Package,
  Plus,
  ReceiptText,
  Search,
  Settings,
  ShieldCheck,
  Users,
  X,
  type LucideIcon,
} from 'lucide-react'
import {
  auditLogs as seedAuditLogs,
  companies,
  contracts,
  dailyReports,
  documents,
  employees,
  estimates,
  experienceRecords,
  invoices,
  licenses,
  materialOrders,
  notices,
  rolePermissions,
  roles,
  siteCompanies,
  sites,
  transactions as seedTransactions,
  users,
  workSchedules,
} from './data/mock/domain'
import type {
  AuditLog,
  Contract,
  DailyReport,
  DocumentRecord,
  Estimate,
  Invoice,
  NoticeLevel,
  PermissionKey,
  Role,
  Site,
  Transaction,
  TransactionKind,
} from './types/domain'

interface AppState {
  role: Role
  setRole: (role: Role) => void
  transactions: Transaction[]
  auditLogs: AuditLog[]
  addTransaction: (transaction: Transaction) => void
  addAuditLog: (log: Omit<AuditLog, 'id' | 'at'>) => void
}

interface NavItem {
  to: string
  label: string
  icon: LucideIcon
}

const storageKey = 'construction-platform-mock-role'
const mockToday = '2026-09-27'

const navItems: NavItem[] = [
  { to: '/dashboard', label: 'ダッシュボード', icon: Home },
  { to: '/sites', label: '現場', icon: Building2 },
  { to: '/transactions', label: '受発注', icon: ClipboardList },
  { to: '/estimates', label: '見積', icon: FileText },
  { to: '/contracts', label: '契約', icon: FileSignature },
  { to: '/materials', label: '資材', icon: Package },
  { to: '/employees', label: '人員', icon: Users },
  { to: '/schedule', label: '配置', icon: CalendarDays },
  { to: '/daily-reports', label: '日報', icon: NotebookText },
  { to: '/invoices', label: '請求', icon: ReceiptText },
  { to: '/documents', label: '書類', icon: FolderArchive },
  { to: '/licenses', label: '建設業許可', icon: ShieldCheck },
  { to: '/company', label: '会社情報', icon: BriefcaseBusiness },
  { to: '/settings', label: '設定', icon: Settings },
]

const router = createHashRouter([
  {
    path: '/',
    element: <Outlet />,
    children: [
      { index: true, element: <LoginPage /> },
      {
        element: <AppShell />,
        children: [
          { path: 'dashboard', element: <DashboardPage /> },
          { path: 'sites', element: <SitesPage /> },
          { path: 'sites/:siteId', element: <SiteDetailPage /> },
          { path: 'transactions', element: <TransactionsPage /> },
          { path: 'estimates', element: <EstimatesPage /> },
          { path: 'contracts', element: <ContractsPage /> },
          { path: 'materials', element: <MaterialsPage /> },
          { path: 'employees', element: <EmployeesPage /> },
          { path: 'schedule', element: <SchedulePage /> },
          { path: 'daily-reports', element: <DailyReportsPage /> },
          { path: 'invoices', element: <InvoicesPage /> },
          { path: 'documents', element: <DocumentsPage /> },
          { path: 'licenses', element: <LicensesPage /> },
          { path: 'company', element: <CompanyPage /> },
          { path: 'settings', element: <SettingsPage /> },
        ],
      },
      { path: '*', element: <NotFoundPage /> },
    ],
  },
])

const AppStateContext = createContext<AppState | null>(null)

function App() {
  return (
    <AppStateProvider>
      <RouterProvider router={router} />
    </AppStateProvider>
  )
}

function AppStateProvider({ children }: { children: ReactNode }) {
  const [role, setRoleState] = useState<Role>(() => readStoredRole())
  const [transactions, setTransactions] = useState<Transaction[]>(seedTransactions)
  const [auditLogs, setAuditLogs] = useState<AuditLog[]>(seedAuditLogs)

  const setRole = (nextRole: Role) => {
    setRoleState(nextRole)

    try {
      window.localStorage.setItem(storageKey, nextRole)
    } catch {
      // localStorage is optional for this mock.
    }
  }

  const addTransaction = (transaction: Transaction) => {
    setTransactions((current) => [transaction, ...current])
  }

  const addAuditLog = (log: Omit<AuditLog, 'id' | 'at'>) => {
    const now = new Intl.DateTimeFormat('ja-JP', {
      dateStyle: 'short',
      timeStyle: 'short',
      timeZone: 'Asia/Tokyo',
    }).format(new Date())

    setAuditLogs((current) => [
      {
        id: `log-${Date.now()}`,
        at: now,
        ...log,
      },
      ...current,
    ])
  }

  const value = useMemo(
    () => ({ role, setRole, transactions, auditLogs, addTransaction, addAuditLog }),
    [role, transactions, auditLogs],
  )

  return <AppStateContext.Provider value={value}>{children}</AppStateContext.Provider>
}

function useAppState() {
  const state = useContext(AppStateContext)

  if (!state) {
    throw new Error('AppStateProvider is missing')
  }

  return state
}

function readStoredRole(): Role {
  try {
    const stored = window.localStorage.getItem(storageKey)
    if (stored && roles.includes(stored as Role)) {
      return stored as Role
    }
  } catch {
    // localStorage can be unavailable in restricted preview contexts.
  }

  return '会社オーナー'
}

function AppShell() {
  const [isMenuOpen, setIsMenuOpen] = useState(false)
  const { role, setRole } = useAppState()

  return (
    <div className="min-h-screen bg-slate-100 text-slate-900">
      <aside
        className={`fixed inset-y-0 left-0 z-40 w-72 border-r border-slate-200 bg-white shadow-sm transition-transform lg:translate-x-0 ${
          isMenuOpen ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        <div className="flex h-16 items-center gap-3 border-b border-slate-200 px-5">
          <div className="grid h-10 w-10 place-items-center rounded-md bg-sky-700 text-white">
            <Hammer size={22} aria-hidden="true" />
          </div>
          <div>
            <p className="text-sm font-semibold text-slate-950">建設業務台帳</p>
            <p className="text-xs text-slate-500">Phase 1 UI Mock</p>
          </div>
          <button
            className="ml-auto inline-flex h-9 w-9 items-center justify-center rounded-md border border-slate-200 text-slate-600 lg:hidden"
            type="button"
            onClick={() => setIsMenuOpen(false)}
            aria-label="メニューを閉じる"
            title="メニューを閉じる"
          >
            <X size={18} aria-hidden="true" />
          </button>
        </div>

        <nav className="grid gap-1 px-3 py-4">
          {navItems.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              onClick={() => setIsMenuOpen(false)}
              className={({ isActive }) =>
                `flex min-h-11 items-center gap-3 rounded-md px-3 text-sm font-medium transition ${
                  isActive
                    ? 'bg-sky-50 text-sky-800 ring-1 ring-sky-100'
                    : 'text-slate-600 hover:bg-slate-100 hover:text-slate-950'
                }`
              }
            >
              <item.icon size={18} aria-hidden="true" />
              <span>{item.label}</span>
            </NavLink>
          ))}
        </nav>
      </aside>

      {isMenuOpen ? (
        <button
          type="button"
          className="fixed inset-0 z-30 bg-slate-950/30 lg:hidden"
          onClick={() => setIsMenuOpen(false)}
          aria-label="メニュー背景を閉じる"
        />
      ) : null}

      <div className="lg:pl-72">
        <header className="sticky top-0 z-20 flex min-h-16 items-center gap-3 border-b border-slate-200 bg-white/95 px-4 backdrop-blur md:px-6">
          <button
            className="inline-flex h-10 w-10 items-center justify-center rounded-md border border-slate-200 text-slate-700 lg:hidden"
            type="button"
            onClick={() => setIsMenuOpen(true)}
            aria-label="メニューを開く"
            title="メニューを開く"
          >
            <Menu size={20} aria-hidden="true" />
          </button>
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold text-slate-950">ABC建設株式会社</p>
            <p className="text-xs text-slate-500">現場中心の受発注・履歴管理モック</p>
          </div>
          <label className="ml-auto grid gap-1 text-xs font-medium text-slate-600">
            ロール
            <select
              className="h-10 min-w-40 rounded-md border border-slate-300 bg-white px-3 text-sm text-slate-900 outline-none focus:border-sky-500 focus:ring-2 focus:ring-sky-100"
              value={role}
              onChange={(event) => setRole(event.target.value as Role)}
            >
              {roles.map((item) => (
                <option key={item} value={item}>
                  {item}
                </option>
              ))}
            </select>
          </label>
        </header>

        <main className="mx-auto grid w-full max-w-7xl gap-6 px-4 py-6 md:px-6">
          <Outlet />
        </main>
      </div>
    </div>
  )
}

function LoginPage() {
  const navigate = useNavigate()
  const { role, setRole, addAuditLog } = useAppState()

  const completeLogin = () => {
    addAuditLog({ actor: 'デモユーザー', action: `${role}としてログイン`, target: 'ログイン画面' })
    navigate('/dashboard')
  }

  const login = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    completeLogin()
  }

  return (
    <main className="grid min-h-screen bg-slate-100 p-4 md:grid-cols-[minmax(0,1fr)_440px] md:p-8">
      <section className="flex min-h-[360px] flex-col justify-between rounded-l-md bg-slate-950 p-8 text-white md:p-10">
        <div>
          <div className="mb-8 inline-flex h-12 w-12 items-center justify-center rounded-md bg-sky-600">
            <Hammer size={26} aria-hidden="true" />
          </div>
          <h1 className="max-w-3xl text-3xl font-semibold leading-tight md:text-5xl">
            現場を中心に、契約・人員・請求・証憑を一本の履歴にする
          </h1>
          <p className="mt-5 max-w-2xl text-base leading-7 text-slate-300">
            Phase 1ではバックエンドなしで、業務導線・項目・注意表示・権限による見え方を確認します。
          </p>
        </div>
        <div className="mt-10 grid gap-3 text-sm text-slate-300 md:grid-cols-3">
          <SummaryPill label="対象" value="中小建設業者" />
          <SummaryPill label="構成" value="UIモック" />
          <SummaryPill label="ルーティング" value="Hash Router" />
        </div>
      </section>

      <section className="rounded-r-md bg-white p-6 shadow-sm md:p-8">
        <form className="grid gap-5" onSubmit={login}>
          <div>
            <p className="text-sm font-semibold text-sky-700">デモログイン</p>
            <h2 className="mt-2 text-2xl font-semibold text-slate-950">建設業務台帳</h2>
          </div>
          <label className="grid gap-2 text-sm font-medium text-slate-700">
            メールアドレス
            <input
              className="h-11 rounded-md border border-slate-300 px-3 text-slate-900 outline-none focus:border-sky-500 focus:ring-2 focus:ring-sky-100"
              type="email"
              defaultValue="owner@example.com"
            />
          </label>
          <label className="grid gap-2 text-sm font-medium text-slate-700">
            パスワード
            <input
              className="h-11 rounded-md border border-slate-300 px-3 text-slate-900 outline-none focus:border-sky-500 focus:ring-2 focus:ring-sky-100"
              type="password"
              defaultValue="mockpass"
            />
          </label>
          <label className="grid gap-2 text-sm font-medium text-slate-700">
            表示ロール
            <select
              className="h-11 rounded-md border border-slate-300 bg-white px-3 text-slate-900 outline-none focus:border-sky-500 focus:ring-2 focus:ring-sky-100"
              value={role}
              onChange={(event) => setRole(event.target.value as Role)}
            >
              {roles.map((item) => (
                <option key={item} value={item}>
                  {item}
                </option>
              ))}
            </select>
          </label>
          <button
            className="inline-flex h-11 items-center justify-center gap-2 rounded-md bg-sky-700 px-4 text-sm font-semibold text-white transition hover:bg-sky-800 focus:outline-none focus:ring-2 focus:ring-sky-300"
            type="button"
            onClick={completeLogin}
          >
            <LogIn size={18} aria-hidden="true" />
            ログイン
          </button>
        </form>

        <div className="mt-6 grid gap-2">
          <p className="text-xs font-semibold text-slate-500">クイック切替</p>
          <div className="grid gap-2 sm:grid-cols-2">
            {(['会社オーナー', '現場責任者', '経理', '協力会社'] as Role[]).map((item) => (
              <button
                key={item}
                className="h-10 rounded-md border border-slate-200 px-3 text-sm font-medium text-slate-700 transition hover:border-sky-300 hover:bg-sky-50"
                type="button"
                onClick={() => setRole(item)}
              >
                {item}
              </button>
            ))}
          </div>
        </div>
      </section>
    </main>
  )
}

function DashboardPage() {
  const { transactions } = useAppState()
  const activeSites = sites.filter((site) => site.status === '施工中')
  const waitingContract = transactions.filter((tx) => tx.status === '契約待ち')
  const waitingInvoice = invoices.filter((invoice) => ['未請求', '作成中'].includes(invoice.status))
  const waitingPayment = invoices.filter((invoice) => invoice.status === '入金待ち')
  const payable = transactions.filter((tx) => tx.direction === '発注' && tx.status !== '完了')

  return (
    <>
      <PageHeader
        label="Dashboard"
        title="会社全体の状況"
        description="現場、契約、請求、支払予定を一画面で確認します。"
        action={<LinkButton to="/transactions" icon={Plus} label="取引登録" />}
      />

      <div className="grid gap-3 md:grid-cols-5">
        <KpiCard label="進行中現場" value={`${activeSites.length}件`} tone="sky" />
        <KpiCard label="未契約案件" value={`${waitingContract.length}件`} tone="amber" />
        <KpiCard label="未請求" value={`${waitingInvoice.length}件`} tone="rose" />
        <KpiCard label="入金待ち" value={`${waitingPayment.length}件`} tone="emerald" />
        <KpiCard label="支払予定" value={`${payable.length}件`} tone="slate" />
      </div>

      <div className="grid gap-6 xl:grid-cols-[1fr_380px]">
        <Section title="本日の現場">
          <div className="grid gap-3 md:grid-cols-3">
            {sites.map((site) => (
              <Link
                key={site.id}
                to={`/sites/${site.id}`}
                className="group rounded-md border border-slate-200 bg-white p-4 transition hover:border-sky-300 hover:shadow-sm"
              >
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="font-semibold text-slate-950">{site.name}</p>
                    <p className="mt-1 text-sm text-slate-500">{site.address}</p>
                  </div>
                  <ChevronRight className="mt-1 text-slate-300 group-hover:text-sky-600" size={18} aria-hidden="true" />
                </div>
                <div className="mt-4 flex items-center gap-2 text-sm">
                  <StatusBadge label={site.status} />
                  <span className="text-slate-500">{site.headcountToday}人</span>
                </div>
              </Link>
            ))}
          </div>
        </Section>

        <Section title="注意事項">
          <div className="grid gap-3">
            {notices.map((notice) => (
              <NoticeCard key={notice.id} level={notice.level} title={notice.title} body={notice.body} action={notice.action} />
            ))}
          </div>
        </Section>
      </div>

      <Section title="最近の操作">
        <AuditLogList limit={5} />
      </Section>
    </>
  )
}

function SitesPage() {
  const [query, setQuery] = useState('')
  const visibleSites = sites.filter((site) => {
    const source = `${site.name} ${site.address} ${site.client} ${site.status}`
    return source.toLowerCase().includes(query.toLowerCase())
  })

  return (
    <>
      <PageHeader
        label="Sites"
        title="現場一覧"
        description="すべての業務データを現場へ紐付ける中心画面です。"
        action={<SearchBox value={query} onChange={setQuery} placeholder="現場名・所在地で検索" />}
      />

      <Section title="現場">
        <div className="overflow-x-auto">
          <table className="min-w-[1040px] w-full text-left text-sm">
            <thead className="border-b border-slate-200 text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-3 py-3">現場名</th>
                <th className="px-3 py-3">所在地</th>
                <th className="px-3 py-3">元請会社</th>
                <th className="px-3 py-3">工期</th>
                <th className="px-3 py-3">状態</th>
                <th className="px-3 py-3">自社区分</th>
                <th className="px-3 py-3">責任者</th>
                <th className="px-3 py-3">人数</th>
                <th className="px-3 py-3">契約金額</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {visibleSites.map((site) => (
                <tr key={site.id} className="bg-white align-top hover:bg-slate-50">
                  <td className="px-3 py-4">
                    <Link className="font-semibold text-sky-800 hover:text-sky-950" to={`/sites/${site.id}`}>
                      {site.name}
                    </Link>
                  </td>
                  <td className="px-3 py-4 text-slate-600">{site.address}</td>
                  <td className="px-3 py-4 text-slate-600">{companyName(site.primeCompanyId)}</td>
                  <td className="px-3 py-4 text-slate-600">
                    {formatDate(site.startDate)} - {formatDate(site.endDate)}
                  </td>
                  <td className="px-3 py-4">
                    <StatusBadge label={site.status} />
                  </td>
                  <td className="px-3 py-4 text-slate-600">{site.ownRole}</td>
                  <td className="px-3 py-4 text-slate-600">{employeeName(site.managerId)}</td>
                  <td className="px-3 py-4 text-slate-600">{site.headcountToday}人</td>
                  <td className="px-3 py-4 text-slate-600">{<Money amount={site.contractAmount} />}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>
    </>
  )
}

function SiteDetailPage() {
  const { siteId } = useParams()
  const site = sites.find((item) => item.id === siteId)
  const [tab, setTab] = useState('概要')

  if (!site) {
    return <NotFoundPage />
  }

  const tabs = ['概要', '参加会社', '契約', '資材', '人員', '日報', '請求', '書類', '履歴']

  return (
    <>
      <PageHeader
        label="Site Detail"
        title={site.name}
        description={`${site.address} / ${site.constructionType}`}
        action={<LinkButton to="/sites" icon={Building2} label="現場一覧" variant="secondary" />}
      />

      <div className="flex flex-wrap gap-2">
        {tabs.map((item) => (
          <button
            key={item}
            className={`h-10 rounded-md border px-4 text-sm font-medium ${
              tab === item
                ? 'border-sky-700 bg-sky-700 text-white'
                : 'border-slate-200 bg-white text-slate-700 hover:border-sky-300 hover:bg-sky-50'
            }`}
            type="button"
            onClick={() => setTab(item)}
          >
            {item}
          </button>
        ))}
      </div>

      {tab === '概要' ? <SiteOverview site={site} /> : null}
      {tab === '参加会社' ? <SiteCompanies site={site} /> : null}
      {tab === '契約' ? <SiteContracts site={site} /> : null}
      {tab === '資材' ? <SiteMaterials site={site} /> : null}
      {tab === '人員' ? <SiteMembers site={site} /> : null}
      {tab === '日報' ? <SiteReports site={site} /> : null}
      {tab === '請求' ? <SiteInvoices site={site} /> : null}
      {tab === '書類' ? <SiteDocuments site={site} /> : null}
      {tab === '履歴' ? <AuditLogList /> : null}
    </>
  )
}

function TransactionsPage() {
  const { transactions, addTransaction, addAuditLog } = useAppState()
  const [siteId, setSiteId] = useState(sites[0]?.id ?? '')
  const [partnerCompanyId, setPartnerCompanyId] = useState(companies[1]?.id ?? '')
  const [kind, setKind] = useState<TransactionKind>('人工・応援')
  const [direction, setDirection] = useState<'受注' | '発注'>('発注')
  const [amount, setAmount] = useState('480000')
  const [asConstruction, setAsConstruction] = useState(false)
  const [isModalOpen, setIsModalOpen] = useState(false)
  const [confirmed, setConfirmed] = useState(false)
  const [error, setError] = useState('')

  const registerTransaction = (confirmedException: boolean) => {
    const parsedAmount = Number(amount)
    const nextKind: TransactionKind = confirmedException ? '建設工事' : kind
    const transaction: Transaction = {
      id: `tx-${Date.now()}`,
      companyId: 'company-abc',
      siteId,
      number: `TX-${new Date().getFullYear()}-${String(transactions.length + 1).padStart(3, '0')}`,
      partnerCompanyId,
      direction,
      kind: nextKind,
      amount: parsedAmount,
      status: nextKind === '建設工事' ? '契約待ち' : '施工中',
      createdAt: mockToday,
      complianceNote:
        kind === '人工・応援'
          ? '人工・応援取引は、本システムでは標準では請負工事として扱いません。'
          : undefined,
      confirmedException,
    }

    addTransaction(transaction)
    addAuditLog({
      actor: 'デモユーザー',
      action: transaction.confirmedException ? '注意事項を確認して取引を登録' : '取引を登録',
      target: transaction.number,
    })
    setConfirmed(false)
    setAsConstruction(false)
    setIsModalOpen(false)
  }

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setError('')

    const parsedAmount = Number(amount)
    if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
      setError('金額は1円以上の数値で入力してください。')
      return
    }

    if (kind === '人工・応援' && asConstruction) {
      setIsModalOpen(true)
      return
    }

    registerTransaction(false)
  }

  return (
    <>
      <PageHeader
        label="Transactions"
        title="受発注管理"
        description="取引種類を分け、人工・応援を標準では建設工事として扱わない設計です。"
      />

      <div className="grid gap-6 xl:grid-cols-[1fr_420px]">
        <Section title="取引一覧">
          <div className="overflow-x-auto">
            <table className="min-w-[900px] w-full text-left text-sm">
              <thead className="border-b border-slate-200 text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-3 py-3">取引番号</th>
                  <th className="px-3 py-3">現場</th>
                  <th className="px-3 py-3">取引先</th>
                  <th className="px-3 py-3">受注/発注</th>
                  <th className="px-3 py-3">区分</th>
                  <th className="px-3 py-3">金額</th>
                  <th className="px-3 py-3">状態</th>
                  <th className="px-3 py-3">作成日</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {transactions.map((tx) => (
                  <tr key={tx.id} className="bg-white align-top hover:bg-slate-50">
                    <td className="px-3 py-4 font-semibold text-slate-950">{tx.number}</td>
                    <td className="px-3 py-4 text-slate-600">{siteName(tx.siteId)}</td>
                    <td className="px-3 py-4 text-slate-600">{companyName(tx.partnerCompanyId)}</td>
                    <td className="px-3 py-4 text-slate-600">{tx.direction}</td>
                    <td className="px-3 py-4">
                      <StatusBadge label={tx.kind} />
                      {tx.confirmedException ? (
                        <p className="mt-1 text-xs text-amber-700">確認履歴あり</p>
                      ) : null}
                    </td>
                    <td className="px-3 py-4 text-slate-600">
                      <Money amount={tx.amount} />
                    </td>
                    <td className="px-3 py-4">
                      <StatusBadge label={tx.status} />
                    </td>
                    <td className="px-3 py-4 text-slate-600">{formatDate(tx.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Section>

        <Section title="取引登録">
          <form className="grid gap-4" onSubmit={submit}>
            {error ? <FormAlert tone="error" message={error} /> : null}
            <label className="grid gap-2 text-sm font-medium text-slate-700">
              現場
              <select className="field" value={siteId} onChange={(event) => setSiteId(event.target.value)}>
                {sites.map((site) => (
                  <option key={site.id} value={site.id}>
                    {site.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="grid gap-2 text-sm font-medium text-slate-700">
              相手会社
              <select className="field" value={partnerCompanyId} onChange={(event) => setPartnerCompanyId(event.target.value)}>
                {companies.filter((company) => company.id !== 'company-abc').map((company) => (
                  <option key={company.id} value={company.id}>
                    {company.name}
                  </option>
                ))}
              </select>
            </label>
            <div className="grid grid-cols-2 gap-3">
              <label className="grid gap-2 text-sm font-medium text-slate-700">
                受注/発注
                <select className="field" value={direction} onChange={(event) => setDirection(event.target.value as '受注' | '発注')}>
                  <option>発注</option>
                  <option>受注</option>
                </select>
              </label>
              <label className="grid gap-2 text-sm font-medium text-slate-700">
                取引区分
                <select className="field" value={kind} onChange={(event) => setKind(event.target.value as TransactionKind)}>
                  {(['建設工事', '人工・応援', '資材', '機材・車両', '業務委託', 'その他'] as TransactionKind[]).map((item) => (
                    <option key={item}>{item}</option>
                  ))}
                </select>
              </label>
            </div>
            <label className="grid gap-2 text-sm font-medium text-slate-700">
              金額
              <input className="field" inputMode="numeric" value={amount} onChange={(event) => setAmount(event.target.value)} />
            </label>

            {kind === '人工・応援' ? (
              <div className="rounded-md border border-amber-200 bg-amber-50 p-4 text-sm text-amber-950">
                <div className="flex gap-2">
                  <AlertTriangle className="mt-0.5 shrink-0" size={18} aria-hidden="true" />
                  <div>
                    <p className="font-semibold">人工・応援取引の注意</p>
                    <p className="mt-1 leading-6">
                      本システムでは標準では請負工事として扱いません。実際の取引形態や指揮命令関係は利用者が確認します。
                    </p>
                  </div>
                </div>
                <label className="mt-3 flex items-start gap-2 text-sm font-medium">
                  <input
                    className="mt-1"
                    type="checkbox"
                    checked={asConstruction}
                    onChange={(event) => setAsConstruction(event.target.checked)}
                  />
                  建設工事として登録する
                </label>
              </div>
            ) : null}

            <button className="primary-button" type="submit">
              <Plus size={18} aria-hidden="true" />
              登録
            </button>
          </form>
        </Section>
      </div>

      {isModalOpen ? (
        <ConfirmModal
          title="標準ルートと異なる登録"
          onClose={() => setIsModalOpen(false)}
          onConfirm={() => registerTransaction(true)}
          isConfirmDisabled={!confirmed}
        >
          <p>通常、本システムでは人工・応援取引を請負工事として扱いません。</p>
          <p className="mt-2">取引実態をご確認の上、必要に応じて専門家等へご確認ください。</p>
          <label className="mt-4 flex items-start gap-2 text-sm font-medium text-slate-800">
            <input
              className="mt-1"
              type="checkbox"
              checked={confirmed}
              onChange={(event) => setConfirmed(event.target.checked)}
            />
            内容を確認しました
          </label>
        </ConfirmModal>
      ) : null}
    </>
  )
}

function EstimatesPage() {
  const [quantity, setQuantity] = useState('8')
  const [unitPrice, setUnitPrice] = useState('32000')
  const subtotal = Number(quantity || 0) * Number(unitPrice || 0) + 385000 + 42000
  const tax = Math.round(subtotal * 0.1)

  return (
    <>
      <PageHeader
        label="Estimates"
        title="見積"
        description="材料費・労務費・法定福利費などを分けて登録する画面です。"
      />

      <div className="grid gap-6 xl:grid-cols-[1fr_420px]">
        <Section title="見積一覧">
          <EstimateList data={estimates} />
        </Section>
        <Section title="見積作成">
          <div className="grid gap-4">
            <label className="grid gap-2 text-sm font-medium text-slate-700">
              件名
              <input className="field" defaultValue="東京物流センター 照明更新工事" />
            </label>
            <div className="grid grid-cols-2 gap-3">
              <label className="grid gap-2 text-sm font-medium text-slate-700">
                数量
                <input className="field" value={quantity} onChange={(event) => setQuantity(event.target.value)} />
              </label>
              <label className="grid gap-2 text-sm font-medium text-slate-700">
                単価
                <input className="field" value={unitPrice} onChange={(event) => setUnitPrice(event.target.value)} />
              </label>
            </div>
            <div className="rounded-md border border-slate-200 bg-slate-50 p-4 text-sm">
              <LineItem label="材料費" value={formatCurrency(385000)} />
              <LineItem label="労務費" value={formatCurrency(Number(quantity || 0) * Number(unitPrice || 0))} />
              <LineItem label="法定福利費" value={formatCurrency(42000)} />
              <LineItem label="消費税" value={formatCurrency(tax)} />
              <div className="mt-3 flex items-center justify-between border-t border-slate-200 pt-3 font-semibold text-slate-950">
                <span>合計</span>
                <span>{formatCurrency(subtotal + tax)}</span>
              </div>
            </div>
            <button className="primary-button" type="button">
              <Plus size={18} aria-hidden="true" />
              ダミー明細を確認
            </button>
          </div>
        </Section>
      </div>
    </>
  )
}

function ContractsPage() {
  return (
    <>
      <PageHeader
        label="Contracts"
        title="契約"
        description="締結後の内容は上書きせず、変更契約として履歴を積みます。"
      />

      <div className="grid gap-6 xl:grid-cols-[1fr_420px]">
        <Section title="契約一覧">
          <ContractList data={contracts} />
        </Section>
        <Section title="契約作成">
          <div className="grid gap-4">
            <label className="grid gap-2 text-sm font-medium text-slate-700">
              現場
              <select className="field" defaultValue="site-kawasaki">
                {sites.map((site) => (
                  <option key={site.id} value={site.id}>
                    {site.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="grid gap-2 text-sm font-medium text-slate-700">
              工事内容
              <textarea className="field min-h-24 py-3" defaultValue="電気設備工事 一式" />
            </label>
            <label className="grid gap-2 text-sm font-medium text-slate-700">
              支払条件
              <input className="field" defaultValue="月末締め翌月末払い" />
            </label>
            <NoticeCard
              level="INFO"
              title="契約書作成推奨"
              body="見積から契約へ進める導線を想定しています。Phase 1では帳票生成は行いません。"
              action="契約案を確認"
            />
          </div>
        </Section>
      </div>
    </>
  )
}

function MaterialsPage() {
  return (
    <>
      <PageHeader label="Materials" title="資材発注" description="資材発注を現場・仕入先・納品場所に紐付けます。" />
      <Section title="発注一覧">
        <div className="grid gap-3 md:grid-cols-2">
          {materialOrders.map((order) => (
            <RecordCard key={order.id} title={order.productName} meta={siteName(order.siteId)}>
              <LineItem label="仕入先" value={companyName(order.supplierCompanyId)} />
              <LineItem label="規格" value={order.specification} />
              <LineItem label="数量" value={`${order.quantity}${order.unit}`} />
              <LineItem label="金額" value={<Money amount={order.quantity * order.unitPrice} />} />
              <LineItem label="希望納期" value={formatDate(order.desiredDeliveryDate)} />
              <LineItem label="納品場所" value={order.deliveryPlace} />
            </RecordCard>
          ))}
        </div>
      </Section>
    </>
  )
}

function EmployeesPage() {
  return (
    <>
      <PageHeader
        label="Employees"
        title="人員管理"
        description="雇用区分、職種、資格、運転可否を管理します。"
      />
      <Section title="人員一覧">
        <div className="overflow-x-auto">
          <table className="min-w-[900px] w-full text-left text-sm">
            <thead className="border-b border-slate-200 text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-3 py-3">氏名</th>
                <th className="px-3 py-3">所属会社</th>
                <th className="px-3 py-3">雇用区分</th>
                <th className="px-3 py-3">職種</th>
                <th className="px-3 py-3">役職</th>
                <th className="px-3 py-3">入社日</th>
                <th className="px-3 py-3">運転</th>
                <th className="px-3 py-3">資格</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {employees.map((employee) => (
                <tr key={employee.id} className="bg-white align-top hover:bg-slate-50">
                  <td className="px-3 py-4 font-semibold text-slate-950">{employee.name}</td>
                  <td className="px-3 py-4 text-slate-600">{companyName(employee.companyId)}</td>
                  <td className="px-3 py-4 text-slate-600">{employee.employmentType}</td>
                  <td className="px-3 py-4 text-slate-600">{employee.trade}</td>
                  <td className="px-3 py-4 text-slate-600">{employee.position}</td>
                  <td className="px-3 py-4 text-slate-600">{formatDate(employee.joinedAt)}</td>
                  <td className="px-3 py-4 text-slate-600">{employee.canDrive ? '可' : '不可'}</td>
                  <td className="px-3 py-4 text-slate-600">{employee.qualifications.join(' / ')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>
    </>
  )
}

function SchedulePage() {
  return (
    <>
      <PageHeader
        label="Schedule"
        title="現場配置"
        description="日ごとの現場、人員、運転属性、車両を確認します。"
      />
      <Section title="配置カレンダー">
        <div className="grid gap-4 lg:grid-cols-3">
          {workSchedules.map((schedule) => (
            <RecordCard key={schedule.id} title={formatDate(schedule.date)} meta={siteName(schedule.siteId)}>
              <div className="grid gap-2">
                {schedule.employeeIds.map((employeeId) => {
                  const employee = employees.find((item) => item.id === employeeId)
                  return (
                    <div key={employeeId} className="rounded-md border border-slate-200 bg-slate-50 p-3">
                      <p className="font-semibold text-slate-950">{employee?.name ?? '不明'}</p>
                      <p className="mt-1 text-sm text-slate-600">
                        {employee?.position} / {employee?.canDrive ? '運転可' : '運転不可'}
                      </p>
                    </div>
                  )
                })}
              </div>
              <LineItem label="車両" value={schedule.vehicle} />
            </RecordCard>
          ))}
        </div>
      </Section>
    </>
  )
}

function DailyReportsPage() {
  return (
    <>
      <PageHeader label="Daily Reports" title="日報" description="施工数量、作業員、写真数を現場履歴として残します。" />
      <div className="grid gap-6 xl:grid-cols-[1fr_420px]">
        <Section title="日報一覧">
          <ReportList data={dailyReports} />
        </Section>
        <Section title="日報入力">
          <div className="grid gap-4">
            <label className="grid gap-2 text-sm font-medium text-slate-700">
              日付
              <input className="field" type="date" defaultValue={mockToday} />
            </label>
            <label className="grid gap-2 text-sm font-medium text-slate-700">
              現場
              <select className="field" defaultValue="site-yokohama">
                {sites.map((site) => (
                  <option key={site.id} value={site.id}>
                    {site.name}
                  </option>
                ))}
              </select>
            </label>
            <div className="grid grid-cols-2 gap-3">
              <label className="grid gap-2 text-sm font-medium text-slate-700">
                作業開始
                <input className="field" type="time" defaultValue="08:00" />
              </label>
              <label className="grid gap-2 text-sm font-medium text-slate-700">
                作業終了
                <input className="field" type="time" defaultValue="17:00" />
              </label>
            </div>
            <label className="grid gap-2 text-sm font-medium text-slate-700">
              作業内容
              <textarea className="field min-h-28 py-3" defaultValue="3階共用部 給排水配管更新" />
            </label>
            <button className="primary-button" type="button">
              <Plus size={18} aria-hidden="true" />
              入力内容を確認
            </button>
          </div>
        </Section>
      </div>
    </>
  )
}

function InvoicesPage() {
  return (
    <>
      <PageHeader label="Invoices" title="請求" description="請求番号、現場、取引先、支払期限、状態を確認します。" />
      <Section title="請求一覧">
        <InvoiceList data={invoices} />
      </Section>
    </>
  )
}

function DocumentsPage() {
  return (
    <>
      <PageHeader label="Documents" title="書類管理" description="Phase 1ではファイル実体を保持せず、ダミーPDF名を表示します。" />
      <Section title="書類一覧">
        <DocumentList data={documents} />
      </Section>
    </>
  )
}

function LicensesPage() {
  const fiscalSystem = 125480000
  const fiscalStatement = 125430000
  const difference = fiscalSystem - fiscalStatement

  return (
    <>
      <PageHeader
        label="Construction License"
        title="建設業許可"
        description="許可情報、工事履歴、経験履歴、決算変更届の確認用UIです。法的判断は表示しません。"
      />
      <div className="grid gap-6 xl:grid-cols-[1fr_420px]">
        <Section title="会社許可情報">
          <div className="grid gap-3 md:grid-cols-2">
            {licenses.map((license) => (
              <RecordCard key={license.id} title={license.licenseNo} meta={`${license.authority} / ${license.classType}`}>
                <LineItem label="許可業種" value={license.trades.join(' / ')} />
                <LineItem label="有効期限" value={formatDate(license.expiresAt)} />
              </RecordCard>
            ))}
          </div>
        </Section>

        <Section title="決算変更届">
          <div className="rounded-md border border-slate-200 bg-white p-4">
            <LineItem label="事業年度" value="2026年度" />
            <LineItem label="システム集計完成工事高" value={formatCurrency(fiscalSystem)} />
            <LineItem label="決算書完成工事高" value={formatCurrency(fiscalStatement)} />
            <LineItem label="差額" value={formatCurrency(difference)} />
            <FormAlert tone="warning" message="金額に差異があります。Phase 1では帳票生成は行いません。" />
          </div>
        </Section>
      </div>

      <Section title="工事履歴">
        <div className="grid gap-3 md:grid-cols-3">
          {sites.map((site) => (
            <RecordCard key={site.id} title={site.name} meta={site.constructionType}>
              <LineItem label="元請/下請" value={site.ownRole} />
              <LineItem label="契約金額" value={<Money amount={site.contractAmount} />} />
              <LineItem label="工期" value={`${formatDate(site.startDate)} - ${formatDate(site.endDate)}`} />
              <LineItem label="完成日" value={site.status === '完了' ? formatDate(site.endDate) : '未完成'} />
            </RecordCard>
          ))}
        </div>
      </Section>

      <Section title="人員経験履歴">
        <div className="grid gap-3 md:grid-cols-2">
          {experienceRecords.map((record) => (
            <RecordCard key={record.id} title={employeeName(record.employeeId)} meta={record.trade}>
              <LineItem label="在籍・参加期間" value={`${formatDate(record.from)} - ${formatDate(record.to)}`} />
              <LineItem label="参加現場" value={`${record.siteIds.length}件`} />
              <LineItem label="関連書類" value={`${record.documentIds.length}件`} />
              <FormAlert tone="info" message="経験年数は参考表示です。要件充足の法的判断は行いません。" />
            </RecordCard>
          ))}
        </div>
      </Section>
    </>
  )
}

function CompanyPage() {
  const company = companies[0]

  return (
    <>
      <PageHeader label="Company" title="会社情報" description="会社マスタの主要項目です。" />
      <Section title={company.name}>
        <div className="grid gap-3 md:grid-cols-2">
          <LineItem label="法人番号" value="1010000000000" />
          <LineItem label="屋号" value="ABC建設" />
          <LineItem label="代表者" value={company.representative} />
          <LineItem label="住所" value={company.address} />
          <LineItem label="電話番号" value={company.phone} />
          <LineItem label="メール" value={company.email} />
          <LineItem label="建設業許可番号" value={company.constructionLicenseNo ?? '未登録'} />
          <LineItem label="インボイス登録番号" value={company.invoiceNo ?? '未登録'} />
          <LineItem label="振込先" value={company.bankAccount ?? '未登録'} />
        </div>
      </Section>
    </>
  )
}

function SettingsPage() {
  const { role, auditLogs } = useAppState()
  const permissions = rolePermissions[role]

  return (
    <>
      <PageHeader label="Settings" title="ユーザー管理・設定" description="Phase 1ではロール切替による見え方の差を確認します。" />
      <div className="grid gap-6 xl:grid-cols-[420px_1fr]">
        <Section title="現在の権限">
          <div className="grid gap-2">
            {(['amounts', 'contracts', 'costs', 'invoices', 'employees', 'sites', 'licenses'] as PermissionKey[]).map((key) => (
              <div key={key} className="flex items-center justify-between rounded-md border border-slate-200 bg-white px-3 py-2 text-sm">
                <span>{permissionLabel(key)}</span>
                {permissions.includes(key) ? (
                  <CheckCircle2 className="text-emerald-600" size={18} aria-hidden="true" />
                ) : (
                  <EyeOff className="text-slate-400" size={18} aria-hidden="true" />
                )}
              </div>
            ))}
          </div>
        </Section>

        <Section title="ユーザー">
          <div className="grid gap-3 md:grid-cols-3">
            {users.map((user) => (
              <RecordCard key={user.id} title={user.name} meta={user.role}>
                <LineItem label="会社" value={companyName(user.companyId)} />
              </RecordCard>
            ))}
          </div>
        </Section>
      </div>

      <Section title="監査ログ">
        <AuditLogRows logs={auditLogs} />
      </Section>
    </>
  )
}

function SiteOverview({ site }: { site: Site }) {
  return (
    <Section title="基本情報">
      <div className="grid gap-4 md:grid-cols-2">
        <LineItem label="現場名" value={site.name} />
        <LineItem label="現場住所" value={site.address} />
        <LineItem label="発注者" value={site.client} />
        <LineItem label="元請会社" value={companyName(site.primeCompanyId)} />
        <LineItem label="工期" value={`${formatDate(site.startDate)} - ${formatDate(site.endDate)}`} />
        <LineItem label="工事内容" value={site.description} />
        <LineItem label="工事業種" value={site.constructionType} />
        <LineItem label="現場責任者" value={employeeName(site.managerId)} />
        <LineItem label="主任技術者" value={site.chiefEngineer} />
        <LineItem label="監理技術者" value={site.supervisingEngineer ?? '未設定'} />
        <LineItem label="備考" value={site.memo} />
      </div>
    </Section>
  )
}

function SiteCompanies({ site }: { site: Site }) {
  const related = siteCompanies.filter((item) => item.siteId === site.id)

  return (
    <Section title="参加会社">
      <div className="grid gap-3 md:grid-cols-2">
        {related.map((item) => (
          <RecordCard key={item.id} title={companyName(item.companyId)} meta={item.role}>
            <LineItem label="会社種別" value={companyType(item.companyId)} />
            <LineItem label="代表者" value={companyRepresentative(item.companyId)} />
          </RecordCard>
        ))}
      </div>
    </Section>
  )
}

function SiteContracts({ site }: { site: Site }) {
  return (
    <Section title="契約">
      <ContractList data={contracts.filter((contract) => contract.siteId === site.id)} />
    </Section>
  )
}

function SiteMaterials({ site }: { site: Site }) {
  return (
    <Section title="資材">
      <div className="grid gap-3 md:grid-cols-2">
        {materialOrders
          .filter((order) => order.siteId === site.id)
          .map((order) => (
            <RecordCard key={order.id} title={order.productName} meta={companyName(order.supplierCompanyId)}>
              <LineItem label="規格" value={order.specification} />
              <LineItem label="数量" value={`${order.quantity}${order.unit}`} />
              <LineItem label="希望納期" value={formatDate(order.desiredDeliveryDate)} />
            </RecordCard>
          ))}
      </div>
    </Section>
  )
}

function SiteMembers({ site }: { site: Site }) {
  const schedules = workSchedules.filter((schedule) => schedule.siteId === site.id)
  const employeeIds = Array.from(new Set(schedules.flatMap((schedule) => schedule.employeeIds)))

  return (
    <Section title="人員">
      <div className="grid gap-3 md:grid-cols-3">
        {employeeIds.map((employeeId) => {
          const employee = employees.find((item) => item.id === employeeId)
          return (
            <RecordCard key={employeeId} title={employee?.name ?? '不明'} meta={employee?.position ?? '未設定'}>
              <LineItem label="所属" value={employee ? companyName(employee.companyId) : '不明'} />
              <LineItem label="職種" value={employee?.trade ?? '不明'} />
              <LineItem label="運転可否" value={employee?.canDrive ? '可' : '不可'} />
            </RecordCard>
          )
        })}
      </div>
    </Section>
  )
}

function SiteReports({ site }: { site: Site }) {
  return (
    <Section title="日報">
      <ReportList data={dailyReports.filter((report) => report.siteId === site.id)} />
    </Section>
  )
}

function SiteInvoices({ site }: { site: Site }) {
  return (
    <Section title="請求">
      <InvoiceList data={invoices.filter((invoice) => invoice.siteId === site.id)} />
    </Section>
  )
}

function SiteDocuments({ site }: { site: Site }) {
  return (
    <Section title="書類">
      <DocumentList data={documents.filter((document) => document.siteId === site.id)} />
    </Section>
  )
}

function PageHeader({
  label,
  title,
  description,
  action,
}: {
  label: string
  title: string
  description: string
  action?: ReactNode
}) {
  return (
    <div className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
      <div>
        <p className="text-xs font-semibold uppercase tracking-wide text-sky-700">{label}</p>
        <h1 className="mt-1 text-2xl font-semibold tracking-normal text-slate-950 md:text-3xl">{title}</h1>
        <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-600">{description}</p>
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  )
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="grid gap-4">
      <h2 className="text-lg font-semibold tracking-normal text-slate-950">{title}</h2>
      {children}
    </section>
  )
}

function KpiCard({ label, value, tone }: { label: string; value: string; tone: 'sky' | 'amber' | 'rose' | 'emerald' | 'slate' }) {
  const classes = {
    sky: 'border-sky-200 bg-sky-50 text-sky-800',
    amber: 'border-amber-200 bg-amber-50 text-amber-800',
    rose: 'border-rose-200 bg-rose-50 text-rose-800',
    emerald: 'border-emerald-200 bg-emerald-50 text-emerald-800',
    slate: 'border-slate-200 bg-white text-slate-800',
  }

  return (
    <div className={`rounded-md border p-4 ${classes[tone]}`}>
      <p className="text-sm font-medium">{label}</p>
      <p className="mt-2 text-3xl font-semibold tracking-normal">{value}</p>
    </div>
  )
}

function StatusBadge({ label }: { label: string }) {
  const tone = statusTone(label)

  return <span className={`inline-flex min-h-7 items-center rounded-md border px-2.5 text-xs font-semibold ${tone}`}>{label}</span>
}

function NoticeCard({ level, title, body, action }: { level: NoticeLevel; title: string; body: string; action: string }) {
  const iconMap: Record<NoticeLevel, LucideIcon> = {
    INFO: Info,
    WARNING: AlertTriangle,
    CONFIRM: CheckCircle2,
  }
  const Icon = iconMap[level]
  const tone = {
    INFO: 'border-sky-200 bg-sky-50 text-sky-950',
    WARNING: 'border-amber-200 bg-amber-50 text-amber-950',
    CONFIRM: 'border-rose-200 bg-rose-50 text-rose-950',
  }[level]

  return (
    <div className={`rounded-md border p-4 ${tone}`}>
      <div className="flex gap-3">
        <Icon className="mt-0.5 shrink-0" size={18} aria-hidden="true" />
        <div>
          <p className="font-semibold">{title}</p>
          <p className="mt-1 text-sm leading-6 opacity-90">{body}</p>
          <p className="mt-2 text-sm font-semibold">{action}</p>
        </div>
      </div>
    </div>
  )
}

function RecordCard({ title, meta, children }: { title: string; meta: string; children: ReactNode }) {
  return (
    <article className="rounded-md border border-slate-200 bg-white p-4 shadow-sm">
      <p className="text-sm font-medium text-slate-500">{meta}</p>
      <h3 className="mt-1 text-base font-semibold tracking-normal text-slate-950">{title}</h3>
      <div className="mt-4 grid gap-2 text-sm">{children}</div>
    </article>
  )
}

function LinkButton({
  to,
  icon: Icon,
  label,
  variant = 'primary',
}: {
  to: string
  icon: LucideIcon
  label: string
  variant?: 'primary' | 'secondary'
}) {
  const classes =
    variant === 'primary'
      ? 'bg-sky-700 text-white hover:bg-sky-800'
      : 'border border-slate-200 bg-white text-slate-700 hover:border-sky-300 hover:bg-sky-50'

  return (
    <Link className={`inline-flex h-10 items-center justify-center gap-2 rounded-md px-4 text-sm font-semibold transition ${classes}`} to={to}>
      <Icon size={18} aria-hidden="true" />
      {label}
    </Link>
  )
}

function SearchBox({ value, onChange, placeholder }: { value: string; onChange: (value: string) => void; placeholder: string }) {
  return (
    <label className="relative block">
      <Search className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" size={18} aria-hidden="true" />
      <input
        className="h-10 w-full min-w-64 rounded-md border border-slate-300 bg-white pl-10 pr-3 text-sm text-slate-900 outline-none focus:border-sky-500 focus:ring-2 focus:ring-sky-100"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
      />
    </label>
  )
}

function Money({ amount }: { amount: number }) {
  const { role } = useAppState()
  const canView = rolePermissions[role].includes('amounts')

  if (!canView) {
    return <span className="inline-flex items-center gap-1 text-slate-500"><EyeOff size={14} aria-hidden="true" />非表示</span>
  }

  return <>{formatCurrency(amount)}</>
}

function LineItem({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex min-h-8 items-start justify-between gap-4 border-b border-slate-100 pb-2 last:border-b-0 last:pb-0">
      <span className="shrink-0 text-slate-500">{label}</span>
      <span className="text-right font-medium text-slate-800">{value}</span>
    </div>
  )
}

function FormAlert({ tone, message }: { tone: 'info' | 'warning' | 'error'; message: string }) {
  const toneClass = {
    info: 'border-sky-200 bg-sky-50 text-sky-900',
    warning: 'border-amber-200 bg-amber-50 text-amber-900',
    error: 'border-rose-200 bg-rose-50 text-rose-900',
  }[tone]

  return <p className={`rounded-md border px-3 py-2 text-sm leading-6 ${toneClass}`}>{message}</p>
}

function ConfirmModal({
  title,
  children,
  onClose,
  onConfirm,
  isConfirmDisabled,
}: {
  title: string
  children: ReactNode
  onClose: () => void
  onConfirm: () => void
  isConfirmDisabled: boolean
}) {
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-slate-950/40 p-4">
      <div className="w-full max-w-lg rounded-md bg-white p-5 shadow-xl">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-rose-700">CONFIRM</p>
            <h2 className="mt-1 text-xl font-semibold text-slate-950">{title}</h2>
          </div>
          <button
            className="inline-flex h-9 w-9 items-center justify-center rounded-md border border-slate-200 text-slate-600"
            type="button"
            onClick={onClose}
            aria-label="閉じる"
            title="閉じる"
          >
            <X size={18} aria-hidden="true" />
          </button>
        </div>
        <div className="mt-4 text-sm leading-6 text-slate-700">{children}</div>
        <div className="mt-5 flex flex-col gap-2 sm:flex-row sm:justify-end">
          <button className="secondary-button" type="button" onClick={onClose}>
            戻る
          </button>
          <button className="primary-button sm:w-auto" type="button" disabled={isConfirmDisabled} onClick={onConfirm}>
            このまま登録する
          </button>
        </div>
      </div>
    </div>
  )
}

function EstimateList({ data }: { data: Estimate[] }) {
  return (
    <div className="grid gap-3">
      {data.map((estimate) => {
        const subtotal = estimate.items.reduce((sum, item) => sum + item.quantity * item.unitPrice, 0)
        const tax = Math.round(subtotal * estimate.taxRate)

        return (
          <RecordCard key={estimate.id} title={estimate.subject} meta={estimate.number}>
            <LineItem label="現場" value={siteName(estimate.siteId)} />
            <LineItem label="相手会社" value={companyName(estimate.partnerCompanyId)} />
            <LineItem label="明細数" value={`${estimate.items.length}行`} />
            <LineItem label="合計" value={<Money amount={subtotal + tax} />} />
            <LineItem label="有効期限" value={formatDate(estimate.expiresAt)} />
          </RecordCard>
        )
      })}
    </div>
  )
}

function ContractList({ data }: { data: Contract[] }) {
  if (data.length === 0) {
    return <EmptyState message="この現場に紐付く契約はありません。" />
  }

  return (
    <div className="grid gap-3">
      {data.map((contract) => (
        <RecordCard key={contract.id} title={contract.content} meta={contract.number}>
          <LineItem label="現場" value={siteName(contract.siteId)} />
          <LineItem label="発注者" value={companyName(contract.buyerCompanyId)} />
          <LineItem label="受注者" value={companyName(contract.sellerCompanyId)} />
          <LineItem label="契約金額" value={<Money amount={contract.amount} />} />
          <LineItem label="工期" value={`${formatDate(contract.startDate)} - ${formatDate(contract.endDate)}`} />
          <LineItem label="状態" value={<StatusBadge label={contract.status} />} />
          <div className="mt-2 rounded-md border border-slate-200 bg-slate-50 p-3">
            <p className="text-sm font-semibold text-slate-950">変更履歴</p>
            <div className="mt-2 grid gap-2">
              {contract.revisions.map((revision) => (
                <div key={revision.id} className="text-sm text-slate-600">
                  {revision.title} / {formatDate(revision.changedAt)} / {formatCurrency(revision.amount)}
                </div>
              ))}
            </div>
          </div>
        </RecordCard>
      ))}
    </div>
  )
}

function ReportList({ data }: { data: DailyReport[] }) {
  if (data.length === 0) {
    return <EmptyState message="この条件の日報はありません。" />
  }

  return (
    <div className="grid gap-3">
      {data.map((report) => (
        <RecordCard key={report.id} title={report.workDescription} meta={`${formatDate(report.date)} / ${siteName(report.siteId)}`}>
          <LineItem label="天候" value={report.weather} />
          <LineItem label="時間" value={`${report.startTime} - ${report.endTime}`} />
          <LineItem label="作業人数" value={`${report.workerIds.length}人`} />
          <LineItem label="施工数量" value={report.quantity} />
          <LineItem label="写真" value={`${report.photoCount}枚`} />
          <LineItem label="備考" value={report.note} />
        </RecordCard>
      ))}
    </div>
  )
}

function InvoiceList({ data }: { data: Invoice[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="min-w-[780px] w-full text-left text-sm">
        <thead className="border-b border-slate-200 text-xs uppercase tracking-wide text-slate-500">
          <tr>
            <th className="px-3 py-3">請求番号</th>
            <th className="px-3 py-3">現場</th>
            <th className="px-3 py-3">取引先</th>
            <th className="px-3 py-3">請求日</th>
            <th className="px-3 py-3">請求金額</th>
            <th className="px-3 py-3">支払期限</th>
            <th className="px-3 py-3">状態</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {data.map((invoice) => (
            <tr key={invoice.id} className="bg-white align-top hover:bg-slate-50">
              <td className="px-3 py-4 font-semibold text-slate-950">{invoice.number}</td>
              <td className="px-3 py-4 text-slate-600">{siteName(invoice.siteId)}</td>
              <td className="px-3 py-4 text-slate-600">{companyName(invoice.partnerCompanyId)}</td>
              <td className="px-3 py-4 text-slate-600">{formatDate(invoice.issueDate)}</td>
              <td className="px-3 py-4 text-slate-600">
                <Money amount={invoice.amount} />
              </td>
              <td className="px-3 py-4 text-slate-600">{formatDate(invoice.dueDate)}</td>
              <td className="px-3 py-4">
                <StatusBadge label={invoice.status} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function DocumentList({ data }: { data: DocumentRecord[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="min-w-[860px] w-full text-left text-sm">
        <thead className="border-b border-slate-200 text-xs uppercase tracking-wide text-slate-500">
          <tr>
            <th className="px-3 py-3">分類</th>
            <th className="px-3 py-3">ファイル名</th>
            <th className="px-3 py-3">現場</th>
            <th className="px-3 py-3">証拠性</th>
            <th className="px-3 py-3">作成日</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {data.map((document) => (
            <tr key={document.id} className="bg-white align-top hover:bg-slate-50">
              <td className="px-3 py-4">
                <StatusBadge label={document.type} />
              </td>
              <td className="px-3 py-4 font-semibold text-slate-950">{document.fileName}</td>
              <td className="px-3 py-4 text-slate-600">{siteName(document.siteId)}</td>
              <td className="px-3 py-4">
                <StatusBadge label={document.evidenceLevel} />
              </td>
              <td className="px-3 py-4 text-slate-600">{formatDate(document.createdAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function AuditLogList({ limit }: { limit?: number }) {
  const { auditLogs } = useAppState()
  return <AuditLogRows logs={limit ? auditLogs.slice(0, limit) : auditLogs} />
}

function AuditLogRows({ logs }: { logs: AuditLog[] }) {
  return (
    <div className="grid gap-2">
      {logs.map((log) => (
        <div key={log.id} className="grid gap-2 rounded-md border border-slate-200 bg-white p-3 text-sm md:grid-cols-[160px_140px_1fr_180px]">
          <span className="text-slate-500">{log.at}</span>
          <span className="font-semibold text-slate-950">{log.actor}</span>
          <span className="text-slate-700">{log.action}</span>
          <span className="text-slate-500">{log.target}</span>
        </div>
      ))}
    </div>
  )
}

function EmptyState({ message }: { message: string }) {
  return (
    <div className="rounded-md border border-dashed border-slate-300 bg-white p-6 text-center text-sm text-slate-500">
      {message}
    </div>
  )
}

function SummaryPill({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-white/15 bg-white/5 px-4 py-3">
      <p className="text-xs text-slate-400">{label}</p>
      <p className="mt-1 font-semibold text-white">{value}</p>
    </div>
  )
}

function NotFoundPage() {
  return (
    <main className="grid min-h-screen place-items-center bg-slate-100 p-6">
      <div className="max-w-md rounded-md bg-white p-6 text-center shadow-sm">
        <p className="text-sm font-semibold text-sky-700">404</p>
        <h1 className="mt-2 text-2xl font-semibold text-slate-950">ページが見つかりません</h1>
        <p className="mt-2 text-sm text-slate-600">指定された画面はモックに存在しません。</p>
        <LinkButton to="/dashboard" icon={Home} label="ダッシュボード" />
      </div>
    </main>
  )
}

function companyName(id: string) {
  return companies.find((company) => company.id === id)?.name ?? '不明な会社'
}

function companyType(id: string) {
  return companies.find((company) => company.id === id)?.type ?? '不明'
}

function companyRepresentative(id: string) {
  return companies.find((company) => company.id === id)?.representative ?? '不明'
}

function siteName(id: string) {
  return sites.find((site) => site.id === id)?.name ?? '不明な現場'
}

function employeeName(id: string) {
  return employees.find((employee) => employee.id === id)?.name ?? '不明な人員'
}

function formatDate(value: string) {
  const date = new Date(`${value}T00:00:00+09:00`)

  if (Number.isNaN(date.getTime())) {
    return value
  }

  return new Intl.DateTimeFormat('ja-JP', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    timeZone: 'Asia/Tokyo',
  }).format(date)
}

function formatCurrency(value: number) {
  return new Intl.NumberFormat('ja-JP', {
    style: 'currency',
    currency: 'JPY',
    maximumFractionDigits: 0,
  }).format(value)
}

function statusTone(label: string) {
  if (['施工中', '契約済', '締結済', '入金済', '確定済', '建設工事'].includes(label)) {
    return 'border-emerald-200 bg-emerald-50 text-emerald-800'
  }

  if (['準備中', '見積中', '作成中', '発注予定', '相手確認中', '相互確認済', 'INFO'].includes(label)) {
    return 'border-sky-200 bg-sky-50 text-sky-800'
  }

  if (['契約待ち', '入金待ち', '一部入金', '人工・応援', '自己入力'].includes(label)) {
    return 'border-amber-200 bg-amber-50 text-amber-800'
  }

  if (['保留', '中止', '未請求', 'CONFIRM'].includes(label)) {
    return 'border-rose-200 bg-rose-50 text-rose-800'
  }

  return 'border-slate-200 bg-slate-50 text-slate-700'
}

function permissionLabel(key: PermissionKey) {
  const labels: Record<PermissionKey, string> = {
    amounts: '金額',
    contracts: '契約',
    costs: '原価',
    invoices: '請求',
    employees: '人員',
    sites: '現場',
    licenses: '建設業許可情報',
  }

  return labels[key]
}

export default App
