import { useCallback, useEffect, useRef, useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import { AlertCircle, ArrowLeft, ArrowRight, Building2, CalendarDays, Check, ChevronLeft, ChevronRight, ClipboardList, History, LoaderCircle, LogOut, MapPin, Pencil, Plus, RefreshCw, Save, Search, X } from 'lucide-react'
import { api, ApiError, errorMessage } from './api'
import type { AuditEvent, Company, Job, JobInput, Session } from './api'
import ClassificationPanel from './ClassificationPanel'
import WorkflowPanel from './WorkflowPanel'
import './product-navigation.css'

type DirtyHandler = (dirty: boolean) => void
type ExpireHandler = () => void
const ROLE_LABEL = { owner: '管理者', manager: '担当者', viewer: '閲覧者' }
const EMPTY_INPUT: JobInput = { name: '', customerName: '', siteAddress: '', workDescription: '', plannedStart: null, plannedEnd: null }
const FIELD_NAMES: Record<keyof JobInput, string> = { name: '工事名', customerName: '発注者', siteAddress: '所在地', workDescription: '施工内容', plannedStart: '開始予定日', plannedEnd: '終了予定日' }
const TEXT_LIMITS = { name: 120, customerName: 120, siteAddress: 250, workDescription: 2000 }
type FieldErrors = Partial<Record<keyof JobInput, string>>

function useScope() {
  const scope = useRef<AbortController | null>(null)
  useEffect(() => {
    const controller = new AbortController()
    scope.current = controller
    return () => controller.abort()
  }, [])
  return scope
}
function validate(input: JobInput): FieldErrors {
  const errors: FieldErrors = {}
  for (const key of Object.keys(TEXT_LIMITS) as (keyof typeof TEXT_LIMITS)[]) {
    if (!input[key].trim()) errors[key] = `${FIELD_NAMES[key]}を入力してください。`
    else if (input[key].length > TEXT_LIMITS[key]) errors[key] = `${TEXT_LIMITS[key]}文字以内で入力してください。`
  }
  for (const key of ['plannedStart', 'plannedEnd'] as const) {
    const date = input[key]
    if (date && (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date)) errors[key] = '有効な日付を入力してください。'
  }
  if (input.plannedStart && input.plannedEnd && input.plannedStart > input.plannedEnd) errors.plannedEnd = '終了予定日は開始予定日以降にしてください。'
  return errors
}
function toInput(job: Job): JobInput {
  return { name: job.name, customerName: job.customerName, siteAddress: job.siteAddress, workDescription: job.workDescription, plannedStart: job.plannedStart, plannedEnd: job.plannedEnd }
}
function dateLabel(value: string | null, time = false) {
  if (!value) return '未設定'
  const date = new Date(value.length === 10 ? `${value}T00:00:00` : value)
  if (!Number.isFinite(date.getTime())) return '日時不明'
  return new Intl.DateTimeFormat('ja-JP', { year: 'numeric', month: '2-digit', day: '2-digit', ...(time ? { hour: '2-digit', minute: '2-digit' } as const : {}) }).format(date)
}
function Loading({ children = '読み込み中' }: { children?: ReactNode }) {
  return <div className="p-loading" role="status"><LoaderCircle className="p-spin" aria-hidden="true" size={19} />{children}</div>
}
function Alert({ children }: { children: ReactNode }) {
  return <div className="p-alert" role="alert"><AlertCircle size={18} aria-hidden="true" /><div>{children}</div></div>
}
function IconButton({ label, children, onClick, disabled = false }: { label: string; children: ReactNode; onClick: () => void; disabled?: boolean }) {
  return <button type="button" className="p-icon-button" title={label} aria-label={label} disabled={disabled} onClick={onClick}>{children}</button>
}
function Brand() {
  return <div className="p-brand"><span className="p-brand-mark"><ClipboardList size={23} aria-hidden="true" /></span><span>工事台帳</span></div>
}

export default function ProductApp() {
  const [status, setStatus] = useState<'checking' | 'login' | 'ready' | 'error' | 'logging-out' | 'logout-error'>('checking')
  const [session, setSession] = useState<Session | null>(null)
  const [companyId, setCompanyId] = useState<string | null>(null)
  const [notice, setNotice] = useState('')
  const authRequest = useRef<AbortController | null>(null)
  const dirty = useRef(false)
  const setDirty = useCallback<DirtyHandler>(value => { dirty.current = value }, [])
  const beginAuth = useCallback(() => {
    authRequest.current?.abort()
    const controller = new AbortController()
    authRequest.current = controller
    return controller.signal
  }, [])
  const acceptSession = useCallback((next: Session) => {
    setSession(next)
    setCompanyId(next.companies.length === 1 ? next.companies[0].id : null)
    setNotice('')
    setStatus('ready')
  }, [])
  const expire = useCallback(() => {
    authRequest.current?.abort()
    dirty.current = false
    setSession(null)
    setCompanyId(null)
    setNotice('認証の有効期限が切れました。再度ログインしてください。')
    setStatus('login')
  }, [])
  const loadSession = useCallback(async () => {
    const signal = beginAuth()
    try {
      const next = await api.me(signal)
      if (!signal.aborted) acceptSession(next)
    } catch (error) {
      if (signal.aborted) return
      if (error instanceof ApiError && error.status === 401) { setNotice(''); setStatus('login') }
      else { setNotice(errorMessage(error)); setStatus('error') }
    }
  }, [acceptSession, beginAuth])
  useEffect(() => {
    const signal = beginAuth()
    void api.me(signal).then(next => {
      if (!signal.aborted) acceptSession(next)
    }).catch(error => {
      if (signal.aborted) return
      if (error instanceof ApiError && error.status === 401) { setNotice(''); setStatus('login') }
      else { setNotice(errorMessage(error)); setStatus('error') }
    })
    return () => authRequest.current?.abort()
  }, [beginAuth, acceptSession])
  useEffect(() => {
    const preventLoss = (event: BeforeUnloadEvent) => {
      if (dirty.current) { event.preventDefault(); event.returnValue = '' }
    }
    window.addEventListener('beforeunload', preventLoss)
    return () => window.removeEventListener('beforeunload', preventLoss)
  }, [])
  const canLeave = () => !dirty.current || window.confirm('画面上の入力を破棄して移動しますか？ 送信済みの場合、処理結果は工事一覧で確認してください。')
  const logout = async () => {
    if (!canLeave()) return
    const signal = beginAuth()
    dirty.current = false
    setSession(null)
    setCompanyId(null)
    setNotice('')
    setStatus('logging-out')
    try {
      await api.signOut(signal)
      if (!signal.aborted) setStatus('login')
    } catch (error) {
      if (!signal.aborted) { setNotice(errorMessage(error)); setStatus('logout-error') }
    }
  }
  const company = session?.companies.find(c => c.id === companyId)
  return <div className="product-app">
    <header className="p-header"><div className="p-header-inner"><Brand />{status === 'ready' && session && <div className="p-account">
      <span className="p-user-name">{session.user.name}</span>
      <IconButton label="ログアウト" onClick={() => void logout()}><LogOut size={19} aria-hidden="true" /></IconButton>
    </div>}</div></header>
    {status === 'checking' && <main className="p-auth"><Loading>認証を確認しています</Loading></main>}
    {status === 'logging-out' && <main className="p-auth"><Loading>ログアウト中</Loading></main>}
    {(status === 'error' || status === 'logout-error') && <main className="p-auth"><Alert>{notice}</Alert><button className="p-button" onClick={() => { if (status === 'logout-error') void logout(); else { setStatus('checking'); void loadSession() } }}><RefreshCw size={17} aria-hidden="true" />再試行</button></main>}
    {status === 'login' && <Login notice={notice} beginAuth={beginAuth} onSession={acceptSession} />}
    {status === 'ready' && session && <>
      {company ? <>
        <div className="p-company-bar"><div className="p-company-inner"><div className="p-company-label"><Building2 size={18} aria-hidden="true" /><strong>{company.name}</strong><span className="p-role">{ROLE_LABEL[company.role]}</span></div>
          {session.companies.length > 1 && <button className="p-text-button" onClick={() => { if (canLeave()) { dirty.current = false; setCompanyId(null) } }}>会社を切り替え<ChevronRight size={16} aria-hidden="true" /></button>}
        </div></div>
        <Workspace key={company.id} company={company} userId={session.user.id} onExpire={expire} onDirty={setDirty} canLeave={canLeave} />
      </> : <main className="p-company-picker p-enter"><h1>会社を選択</h1>{session.companies.length === 0 ? <div className="p-empty"><Building2 size={30} aria-hidden="true" /><h2>所属する会社がありません</h2><p>所属先の管理者に確認してください。</p></div> : <div className="p-company-options">{session.companies.map(c => <button key={c.id} className="p-company-option" onClick={() => setCompanyId(c.id)}><Building2 size={23} aria-hidden="true" /><span><strong>{c.name}</strong><small>{ROLE_LABEL[c.role]}</small></span><ChevronRight size={19} aria-hidden="true" /></button>)}</div>}</main>}
    </>}
  </div>
}

function Login({ notice, beginAuth, onSession }: { notice: string; beginAuth: () => AbortSignal; onSession: (session: Session) => void }) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const locked = useRef(false)
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (locked.current) return
    locked.current = true
    const signal = beginAuth()
    setBusy(true); setError('')
    try {
      await api.signIn(email.trim(), password, signal)
      const session = await api.me(signal)
      if (!signal.aborted) { setPassword(''); onSession(session) }
    } catch (error) {
      if (!signal.aborted) setError(error instanceof ApiError && (error.status === 401 || error.status === 400) ? 'メールアドレスまたはパスワードを確認してください。' : errorMessage(error))
    } finally {
      locked.current = false
      if (!signal.aborted) { setPassword(''); setBusy(false) }
    }
  }
  return <main className="p-auth p-enter"><div className="p-auth-heading"><ClipboardList size={30} aria-hidden="true" /><h1>工事台帳にログイン</h1></div>
    {notice && <Alert>{notice}</Alert>}{error && <Alert>{error}</Alert>}
    <form onSubmit={submit} className="p-form"><fieldset disabled={busy}><label className="p-field"><span>メールアドレス</span><input name="email" type="email" autoComplete="username" required maxLength={254} value={email} onChange={e => setEmail(e.target.value)} /></label>
      <label className="p-field"><span>パスワード</span><input name="password" type="password" autoComplete="current-password" required value={password} onChange={e => setPassword(e.target.value)} /></label>
      <button className="p-button p-primary p-full" type="submit">{busy ? <LoaderCircle className="p-spin" size={18} aria-hidden="true" /> : <ArrowRight size={18} aria-hidden="true" />}ログイン</button>
    </fieldset></form>
  </main>
}

type View = { kind: 'list' } | { kind: 'new' } | { kind: 'detail'; id: string }
function Workspace({ company, userId, onExpire, onDirty, canLeave }: { company: Company; userId: string; onExpire: ExpireHandler; onDirty: DirtyHandler; canLeave: () => boolean }) {
  const [view, setView] = useState<View>({ kind: 'list' })
  const [offset, setOffset] = useState(0)
  const [message, setMessage] = useState('')
  const navigate = (next: View) => { if (canLeave()) { onDirty(false); setMessage(''); setView(next) } }
  const saved = (job: Job, created: boolean) => { onDirty(false); setMessage(created ? '工事を登録しました。' : '変更を保存しました。'); setView({ kind: 'detail', id: job.id }) }
  return <main className="p-main">
    {message && <div className="p-success" role="status"><Check size={18} aria-hidden="true" />{message}<IconButton label="通知を閉じる" onClick={() => setMessage('')}><X size={16} aria-hidden="true" /></IconButton></div>}
    {view.kind === 'list' && <JobList key={offset} company={company} offset={offset} setOffset={setOffset} onExpire={onExpire} onOpen={id => navigate({ kind: 'detail', id })} onCreate={() => navigate({ kind: 'new' })} />}
    {view.kind === 'new' && company.role !== 'viewer' && <JobEditor company={company} onExpire={onExpire} onDirty={onDirty} onCancel={() => navigate({ kind: 'list' })} onSaved={job => saved(job, true)} />}
    {view.kind === 'detail' && <JobDetail key={view.id} company={company} userId={userId} jobId={view.id} onExpire={onExpire} onDirty={onDirty} canLeave={canLeave} onBack={() => navigate({ kind: 'list' })} onSaved={job => saved(job, false)} />}
  </main>
}

function JobList({ company, offset, setOffset, onExpire, onOpen, onCreate }: { company: Company; offset: number; setOffset: (offset: number) => void; onExpire: ExpireHandler; onOpen: (id: string) => void; onCreate: () => void }) {
  const [data, setData] = useState<{ jobs: Job[]; total: number } | null>(null)
  const [error, setError] = useState('')
  const [query, setQuery] = useState('')
  const [retry, setRetry] = useState(0)
  useEffect(() => {
    const controller = new AbortController()
    void api.list(company.id, offset, controller.signal).then(next => {
      if (controller.signal.aborted) return
      if (offset > 0 && offset >= next.total) { setOffset(Math.max(0, Math.ceil(next.total / 50) - 1) * 50); return }
      setData(next)
    }).catch(error => {
      if (controller.signal.aborted) return
      if (error instanceof ApiError && error.status === 401) onExpire()
      else setError(errorMessage(error))
    })
    return () => controller.abort()
  }, [company.id, offset, retry, onExpire, setOffset])
  const reload = () => { setData(null); setError(''); setQuery(''); setRetry(v => v + 1) }
  const needle = query.trim().toLocaleLowerCase('ja-JP')
  const filtered = data?.jobs.filter(job => [job.name, job.customerName, job.siteAddress].some(value => value.toLocaleLowerCase('ja-JP').includes(needle))) ?? []
  return <section className="p-enter" aria-labelledby="p-list-title"><div className="p-page-heading"><div><span className="p-eyebrow">工事管理</span><h1 id="p-list-title">工事一覧 <span className="p-count">{data ? `${data.total}件` : ''}</span></h1></div>{company.role !== 'viewer' && <button className="p-button p-primary" onClick={onCreate}><Plus size={18} aria-hidden="true" />工事を登録</button>}</div>
    <div className="p-list-tools"><label className="p-search"><Search size={18} aria-hidden="true" /><input aria-label="このページ内を検索" type="search" placeholder="工事名・発注者・所在地" value={query} onChange={e => setQuery(e.target.value)} disabled={!data} /></label><span className="p-muted p-small">このページの取得済み工事のみ検索</span><IconButton label="一覧を再読み込み" onClick={reload} disabled={!data && !error}><RefreshCw size={18} aria-hidden="true" /></IconButton></div>
    {error ? <div className="p-load-error"><Alert>{error}</Alert><button className="p-button" onClick={reload}><RefreshCw size={17} aria-hidden="true" />再試行</button></div> : !data ? <Loading /> : <>
      {filtered.length ? <div className="p-job-list"><div className="p-job-columns" aria-hidden="true"><span>工事名・所在地</span><span>発注者</span><span>予定期間</span><span /></div>{filtered.map(job => <button className="p-job-row" key={job.id} onClick={() => onOpen(job.id)}><span className="p-job-main"><strong>{job.name}</strong><span className="p-job-address"><MapPin size={14} aria-hidden="true" />{job.siteAddress}</span></span><span className="p-job-customer">{job.customerName}</span><span className="p-job-dates"><CalendarDays size={15} aria-hidden="true" /><span>{dateLabel(job.plannedStart)}<span className="p-date-divider">〜</span>{dateLabel(job.plannedEnd)}</span></span><ChevronRight className="p-row-arrow" size={18} aria-hidden="true" /></button>)}</div> : <div className="p-empty"><ClipboardList size={32} aria-hidden="true" /><h2>{needle ? '一致する工事がありません' : '工事が登録されていません'}</h2>{needle && <button className="p-text-button" onClick={() => setQuery('')}>検索を解除</button>}</div>}
      <div className="p-pagination"><span className="p-muted p-small">{data.total ? `${offset + 1}〜${Math.min(offset + data.jobs.length, data.total)} / ${data.total}件` : '0件'}{needle && `（一致 ${filtered.length}件）`}</span><div><IconButton label="前のページ" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 50))}><ChevronLeft size={19} aria-hidden="true" /></IconButton><span className="p-page-number">{Math.floor(offset / 50) + 1} / {Math.max(1, Math.ceil(data.total / 50))}</span><IconButton label="次のページ" disabled={offset + 50 >= data.total} onClick={() => setOffset(offset + 50)}><ChevronRight size={19} aria-hidden="true" /></IconButton></div></div>
    </>}
  </section>
}

function InputFields({ input, errors, onChange, fields, disabled }: { input: JobInput; errors: FieldErrors; onChange: (key: keyof JobInput, value: string) => void; fields: (keyof JobInput)[]; disabled?: boolean }) {
  return <fieldset disabled={disabled} className="p-fields">{fields.map(key => {
    const isDate = key === 'plannedStart' || key === 'plannedEnd'
    const id = `p-field-${key}`
    const common = { id, name: key, value: input[key] ?? '', 'aria-invalid': !!errors[key], 'aria-describedby': errors[key] ? `${id}-error` : undefined, onChange: (event: { target: { value: string } }) => onChange(key, event.target.value) }
    return <div className={`p-field ${key === 'workDescription' ? 'p-wide' : ''}`} key={key}><label htmlFor={id}>{FIELD_NAMES[key]}<span className={isDate ? 'p-optional' : 'p-required'}>{isDate ? '任意' : '必須'}</span></label>{key === 'workDescription' ? <textarea {...common} rows={6} maxLength={2000} required /> : <input {...common} type={isDate ? 'date' : 'text'} required={!isDate} maxLength={isDate ? undefined : TEXT_LIMITS[key]} min={key === 'plannedEnd' ? input.plannedStart ?? undefined : undefined} max={isDate ? '9999-12-31' : undefined} />}{!isDate && <span className="p-character-count">{input[key]?.length ?? 0} / {TEXT_LIMITS[key]}</span>}{errors[key] && <span className="p-field-error" id={`${id}-error`}>{errors[key]}</span>}</div>
  })}</fieldset>
}

function JobEditor({ company, initial, onExpire, onDirty, onCancel, onSaved }: { company: Company; initial?: Job; onExpire: ExpireHandler; onDirty: DirtyHandler; onCancel: () => void; onSaved: (job: Job) => void }) {
  const [input, setInput] = useState<JobInput>(() => initial ? toInput(initial) : { ...EMPTY_INPUT })
  const [step, setStep] = useState(0)
  const [errors, setErrors] = useState<FieldErrors>({})
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [conflict, setConflict] = useState(false)
  const [outcomeUnknown, setOutcomeUnknown] = useState(false)
  const [sentInput, setSentInput] = useState<JobInput | null>(null)
  const [current, setCurrent] = useState<Job | null>(null)
  const [checkError, setCheckError] = useState('')
  const [denied, setDenied] = useState(false)
  const [base, setBase] = useState(initial)
  const [reloading, setReloading] = useState(false)
  const attempt = useRef<{ key: string; body: string } | null>(null)
  const locked = useRef(false)
  const scope = useScope()
  const changed = JSON.stringify(input) !== JSON.stringify(base ? toInput(base) : EMPTY_INPUT)
  useEffect(() => { onDirty(changed || busy || outcomeUnknown || conflict); return () => onDirty(false) }, [changed, busy, outcomeUnknown, conflict, onDirty])
  const change = (key: keyof JobInput, value: string) => {
    attempt.current = null
    setInput(prev => ({ ...prev, [key]: key === 'plannedStart' || key === 'plannedEnd' ? value || null : value }))
    setErrors(prev => ({ ...prev, [key]: undefined }))
    setError('')
  }
  const stepFields: (keyof JobInput)[][] = [['name', 'customerName'], ['siteAddress', 'workDescription'], ['plannedStart', 'plannedEnd']]
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (locked.current || denied || conflict || company.role === 'viewer') return
    const allErrors = validate(input)
    const fields = initial || step === 2 ? Object.keys(FIELD_NAMES) as (keyof JobInput)[] : stepFields[step]
    const relevant = Object.fromEntries(fields.filter(key => allErrors[key]).map(key => [key, allErrors[key]]))
    setErrors(relevant)
    if (Object.keys(relevant).length) {
      if (!initial) setStep(stepFields.findIndex(group => group.some(key => relevant[key])))
      requestAnimationFrame(() => document.querySelector<HTMLElement>('.product-app [aria-invalid="true"]')?.focus())
      return
    }
    if (!initial && step < 2) { setStep(step + 1); return }
    const signal = scope.current!.signal
    locked.current = true
    setBusy(true); setError('')
    try {
      let job: Job
      if (base) {
        setSentInput({ ...input }); setCurrent(null); setCheckError('')
        job = await api.update(company.id, base.id, input, base.version, signal)
      }
      else {
        const body = JSON.stringify(input)
        if (!attempt.current || attempt.current.body !== body) attempt.current = { key: crypto.randomUUID(), body }
        job = await api.create(company.id, input, attempt.current.key, signal)
      }
      if (!signal.aborted) { onDirty(false); onSaved(job) }
    } catch (error) {
      if (signal.aborted) return
      if (error instanceof ApiError && error.status === 401) { onExpire(); return }
      if (error instanceof ApiError && error.status === 403) setDenied(true)
      if (error instanceof ApiError && error.status === 409 && base) setConflict(true)
      if (base && (!(error instanceof ApiError) || error.status === 0 || error.status >= 500)) setOutcomeUnknown(true)
      setError(errorMessage(error))
    } finally {
      locked.current = false
      if (!signal.aborted) setBusy(false)
    }
  }
  const reload = async () => {
    if (!base || locked.current || !window.confirm('入力内容を破棄して最新データを読み込みますか？')) return
    const signal = scope.current!.signal
    locked.current = true; setReloading(true)
    try {
      const latest = await api.get(company.id, base.id, signal)
      if (signal.aborted) return
      setBase(latest); setInput(toInput(latest)); setConflict(false); setOutcomeUnknown(false); setSentInput(null); setCurrent(null); setCheckError(''); setError(''); setErrors({}); attempt.current = null; onDirty(false)
    } catch (error) {
      if (signal.aborted) return
      if (error instanceof ApiError && error.status === 401) onExpire()
      else setError(errorMessage(error))
    } finally { locked.current = false; if (!signal.aborted) setReloading(false) }
  }
  const checkCurrent = async () => {
    if (!base || locked.current) return
    const signal = scope.current!.signal
    locked.current = true; setReloading(true); setCheckError(''); setCurrent(null)
    try {
      const latest = await api.get(company.id, base.id, signal)
      if (!signal.aborted) setCurrent(latest)
    } catch (error) {
      if (signal.aborted) return
      if (error instanceof ApiError && error.status === 401) onExpire()
      else setCheckError(errorMessage(error))
    } finally { locked.current = false; if (!signal.aborted) setReloading(false) }
  }
  const currentMatches = current && (Object.keys(FIELD_NAMES) as (keyof JobInput)[]).every(key => current[key] === input[key])
  const comparisonFields = current ? (Object.keys(FIELD_NAMES) as (keyof JobInput)[]).filter(key => base?.[key] !== current[key] || sentInput?.[key] !== current[key] || input[key] !== current[key]) : []
  const showValue = (value: string | null | undefined) => value ?? '未設定'
  return <section className="p-editor p-enter" aria-labelledby="p-editor-title"><button className="p-back" onClick={onCancel}><ArrowLeft size={17} aria-hidden="true" />{initial ? '工事詳細に戻る' : '工事一覧に戻る'}</button><div className="p-page-heading"><div><span className="p-eyebrow">{initial ? '工事情報' : '新規工事'}</span><h1 id="p-editor-title">{initial ? '基本情報を編集' : '工事を登録'}</h1></div></div>
    {!initial && <ol className="p-steps">{['工事・発注者', '所在地・施工内容', '予定日'].map((label, index) => <li key={label} className={index === step ? 'is-current' : index < step ? 'is-complete' : ''} aria-current={index === step ? 'step' : undefined}><span>{index < step ? <Check size={15} aria-hidden="true" /> : index + 1}</span><strong>{label}</strong></li>)}</ol>}
    {error && !conflict && !outcomeUnknown && <Alert>{error}{!denied && <p>入力内容は保持されています。</p>}</Alert>}
    {(conflict || outcomeUnknown) && <Alert><strong>{outcomeUnknown ? '更新結果は不明です' : '保存内容が更新されています'}</strong><p>入力内容は保持されています。</p><p>{outcomeUnknown ? '前回の送信が保存された可能性があります。現在の保存内容を確認してください。' : '現在の保存内容を確認するまで保存できません。'}</p><div className="p-recovery-actions"><button type="button" className="p-button" onClick={() => void checkCurrent()} disabled={reloading || busy || denied}><RefreshCw size={17} className={reloading ? 'p-spin' : undefined} aria-hidden="true" />現在の保存内容を確認</button><button type="button" className="p-button" onClick={() => void reload()} disabled={reloading || busy || denied}>入力を破棄して最新データを再読込</button></div>{checkError && <p>{checkError}</p>}{error && <p>{error}</p>}</Alert>}
    {current && <section className="p-comparison" aria-label="保存内容との比較"><h2>現在の保存内容（版 {current.version}）</h2><p role="status">{currentMatches ? '現在の保存内容は入力と一致しています。' : '現在の保存内容と入力に差分があります。'}</p>{outcomeUnknown && <p className="p-muted p-small">前回の送信が実行されたかどうかは、この照合だけでは確定できません。</p>}<dl>{comparisonFields.map(key => <div key={key}><dt>{FIELD_NAMES[key]}</dt><dd><span>編集開始時</span><p>{showValue(base?.[key])}</p><span>直前の送信内容</span><p>{showValue(sentInput?.[key])}</p><span>現在の保存内容</span><p>{showValue(current[key])}</p><span>保持している入力</span><p>{showValue(input[key])}</p></dd></div>)}</dl><button type="button" className="p-button" disabled={reloading || busy || denied} onClick={() => { setBase(current); setCurrent(null); setConflict(false); setOutcomeUnknown(false); setError(''); setCheckError('') }}><Check size={17} aria-hidden="true" />確認した版を基に編集を続ける</button></section>}
    <form onSubmit={submit} noValidate className="p-form"><InputFields input={input} errors={errors} onChange={change} fields={initial ? Object.keys(FIELD_NAMES) as (keyof JobInput)[] : stepFields[step]} disabled={busy || reloading || denied} />
      <div className="p-form-actions"><button type="button" className="p-button" onClick={() => !initial && step > 0 ? setStep(step - 1) : onCancel()} disabled={busy || reloading}><ArrowLeft size={17} aria-hidden="true" />{!initial && step > 0 ? '戻る' : 'キャンセル'}</button><button type="submit" className="p-button p-primary" disabled={busy || reloading || denied || conflict || (!!initial && !changed)}>{busy ? <LoaderCircle size={17} className="p-spin" aria-hidden="true" /> : !initial && step < 2 ? <ArrowRight size={17} aria-hidden="true" /> : <Save size={17} aria-hidden="true" />}{busy ? '保存中' : !initial && step < 2 ? '次へ' : initial ? '変更を保存' : '登録する'}</button></div>
    </form>
  </section>
}

function JobDetail({ company, userId, jobId, onExpire, onDirty, canLeave, onBack, onSaved }: { company: Company; userId: string; jobId: string; onExpire: ExpireHandler; onDirty: DirtyHandler; canLeave: () => boolean; onBack: () => void; onSaved: (job: Job) => void }) {
  const [job, setJob] = useState<Job | null>(null)
  const [error, setError] = useState('')
  const [retry, setRetry] = useState(0)
  const [editing, setEditing] = useState(false)
  const [tab, setTab] = useState<'info' | 'audit' | 'classification' | 'workflow'>('info')
  const [auditVersion, setAuditVersion] = useState(0)
  useEffect(() => {
    const controller = new AbortController()
    void api.get(company.id, jobId, controller.signal).then(next => { if (!controller.signal.aborted) setJob(next) }).catch(error => {
      if (controller.signal.aborted) return
      if (error instanceof ApiError && error.status === 401) onExpire()
      else setError(errorMessage(error))
    })
    return () => controller.abort()
  }, [company.id, jobId, retry, onExpire])
  const reload = () => { setJob(null); setError(''); setRetry(v => v + 1) }
  const cancelEdit = () => {
    if (window.confirm('編集を終了しますか？ 画面上の入力内容は破棄されます。')) { onDirty(false); setEditing(false); reload() }
  }
  const tabs = company.role === 'viewer' ? ['info', 'classification', 'workflow'] as const : ['info', 'classification', 'workflow', 'audit'] as const
  const changeTab = (next: typeof tab) => {
    if (next === tab) return true
    if (!canLeave()) return false
    onDirty(false); setTab(next); return true
  }
  if (editing && job && company.role !== 'viewer') return <JobEditor company={company} initial={job} onExpire={onExpire} onDirty={onDirty} onCancel={cancelEdit} onSaved={next => { setJob(next); setEditing(false); setAuditVersion(v => v + 1); onSaved(next) }} />
  return <section className="p-enter"><button className="p-back" onClick={onBack}><ArrowLeft size={17} aria-hidden="true" />工事一覧に戻る</button>{error ? <div className="p-load-error"><Alert>{error}</Alert><button className="p-button" onClick={reload}><RefreshCw size={17} aria-hidden="true" />再試行</button></div> : !job ? <Loading /> : <>
    <div className="p-page-heading p-detail-heading"><div><span className="p-eyebrow">工事詳細</span><h1>{job.name}</h1><p className="p-location"><MapPin size={16} aria-hidden="true" />{job.siteAddress}</p></div>{company.role !== 'viewer' && <button className="p-button" onClick={() => { if (canLeave()) { onDirty(false); setEditing(true) } }}><Pencil size={17} aria-hidden="true" />編集</button>}</div>
    <div className="p-tabs" role="tablist" aria-label="工事情報">{tabs.map(key => <button key={key} id={`p-tab-${key}`} role="tab" aria-selected={tab === key} aria-controls={`p-${key}-panel`} tabIndex={tab === key ? 0 : -1} onClick={() => changeTab(key)} onKeyDown={e => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return
      e.preventDefault()
      const index = tabs.findIndex(t => t === key)
      const next = tabs[e.key === 'Home' ? 0 : e.key === 'End' ? tabs.length - 1 : (index + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length]
      if (changeTab(next)) document.getElementById(`p-tab-${next}`)?.focus()
    }}>{key === 'audit' ? <History size={17} aria-hidden="true" /> : <ClipboardList size={17} aria-hidden="true" />}{key === 'info' ? '基本情報' : key === 'audit' ? '変更履歴' : key === 'workflow' ? '工事を進める' : '契約前の確認'}</button>)}</div>
    {tab === 'info' ? <div role="tabpanel" id="p-info-panel" aria-labelledby="p-tab-info" tabIndex={0}>
      <section className="p-next-work" aria-label={company.role === 'viewer' ? '工事の確認事項' : '次の作業'}>
        <div><span className="p-eyebrow">{company.role === 'viewer' ? '保存した回答' : '次の作業'}</span><h2>契約前の確認</h2></div>
        <div className="p-next-work-actions"><button type="button" className="p-button p-primary" onClick={() => { if (changeTab('classification')) document.getElementById('p-tab-classification')?.focus() }}><ArrowRight size={18} aria-hidden="true" />{company.role === 'viewer' ? '確認事項を見る' : '契約前の確認へ進む'}</button><button type="button" className="p-button" onClick={() => { if (changeTab('workflow')) document.getElementById('p-tab-workflow')?.focus() }}><ArrowRight size={18} aria-hidden="true" />見積・施工・請求へ</button></div>
      </section>
      <dl className="p-detail-grid">{(Object.keys(FIELD_NAMES) as (keyof JobInput)[]).map(key => <div className={key === 'workDescription' ? 'p-wide' : ''} key={key}><dt>{FIELD_NAMES[key]}</dt><dd>{key === 'plannedStart' || key === 'plannedEnd' ? dateLabel(job[key]) : job[key]}</dd></div>)}</dl><div className="p-record-meta"><span>登録 {dateLabel(job.createdAt, true)}</span><span>最終更新 {dateLabel(job.updatedAt, true)}</span><span>版 {job.version}</span></div>
    </div> : tab === 'classification' ? <div role="tabpanel" id="p-classification-panel" aria-labelledby="p-tab-classification" tabIndex={0}><ClassificationPanel company={company} jobId={job.id} onExpire={onExpire} onDirty={onDirty} onBackToJob={() => { if (changeTab('info')) document.getElementById('p-tab-info')?.focus() }} onNext={() => { if (changeTab('workflow')) document.getElementById('p-tab-workflow')?.focus() }} /></div> : tab === 'workflow' ? <div role="tabpanel" id="p-workflow-panel" aria-labelledby="p-tab-workflow" tabIndex={0}><WorkflowPanel company={company} userId={userId} job={job} onJob={setJob} onExpire={onExpire} onDirty={onDirty} onOpenClassification={() => { if (changeTab('classification')) document.getElementById('p-tab-classification')?.focus() }} /></div> : company.role !== 'viewer' && <div role="tabpanel" id="p-audit-panel" aria-labelledby="p-tab-audit" tabIndex={0}><Audit key={auditVersion} companyId={company.id} jobId={job.id} onExpire={onExpire} /></div>}
  </>}</section>
}

function Audit({ companyId, jobId, onExpire }: { companyId: string; jobId: string; onExpire: ExpireHandler }) {
  const [events, setEvents] = useState<AuditEvent[] | null>(null)
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [request, setRequest] = useState<{ cursor: string | null; attempt: number }>({ cursor: null, attempt: 0 })
  const locked = useRef(false)
  useEffect(() => {
    const controller = new AbortController()
    locked.current = true
    void api.audit(companyId, jobId, controller.signal, request.cursor).then(result => {
      if (controller.signal.aborted) return
      setEvents(previous => {
        if (request.cursor === null) return result.events
        const seen = new Set(previous?.map(event => event.id))
        return [...previous ?? [], ...result.events.filter(event => !seen.has(event.id))]
      })
      setNextCursor(result.nextCursor)
    }).catch(error => {
      if (controller.signal.aborted) return
      if (error instanceof ApiError && error.status === 401) onExpire()
      else setError(errorMessage(error))
    }).finally(() => {
      if (!controller.signal.aborted) { locked.current = false; setLoading(false) }
    })
    return () => controller.abort()
  }, [companyId, jobId, request, onExpire])
  const load = (cursor: string | null) => {
    if (locked.current) return
    locked.current = true; setLoading(true); setError('')
    setRequest(previous => ({ cursor, attempt: previous.attempt + 1 }))
  }
  const failure = error && <div className="p-load-error"><Alert>{error}{events && <p>取得済みの履歴は保持されています。</p>}</Alert><button className="p-button" onClick={() => load(request.cursor)} disabled={loading}><RefreshCw size={17} aria-hidden="true" />履歴の取得を再試行</button></div>
  if (!events) return <>{failure || <Loading />}</>
  if (!events.length) return <div className="p-empty"><History size={30} aria-hidden="true" /><h2>変更履歴はありません</h2></div>
  const actionLabels: Record<string, string> = { create: '工事を登録', update: '基本情報を更新', 'job.created': '工事を登録', 'job.updated': '基本情報を更新' }
  const valueLabel = (value: unknown, key: keyof JobInput) => {
    if (value === null || value === undefined || value === '') return '未設定'
    if (typeof value !== 'string') return '記録形式を確認できません'
    return key === 'plannedStart' || key === 'plannedEnd' ? dateLabel(value) : value
  }
  return <><p className="p-muted p-small p-audit-scope">{events.length}件表示</p><ol className="p-audit-list">{events.map(event => {
    const changed = (Object.keys(FIELD_NAMES) as (keyof JobInput)[]).filter(key => event.beforeData?.[key] !== event.afterData?.[key])
    return <li className="p-audit-event" key={event.id}><div className="p-audit-heading"><span className="p-audit-marker"><History size={17} aria-hidden="true" /></span><div><strong>{actionLabels[event.action] ?? event.action}</strong><span>{event.actorName}{event.requestId.startsWith('legacy:') && <span className="p-audit-legacy">名前は移行時点（当時の名前は不明）</span>}<span className="p-audit-date">{dateLabel(event.occurredAt, true)}</span><span>版 {event.targetVersion}</span></span></div></div>{changed.length > 0 && <details className="p-audit-changes"><summary>変更内容（{changed.length}項目）</summary><dl>{changed.map(key => <div key={key}><dt>{FIELD_NAMES[key]}</dt><dd>{event.beforeData && <><span className="p-muted">変更前</span><p>{valueLabel(event.beforeData[key], key)}</p></>}<span className="p-muted">{event.beforeData ? '変更後' : '登録内容'}</span><p>{valueLabel(event.afterData?.[key], key)}</p></dd></div>)}</dl></details>}</li>
  })}</ol>{failure}<div className="p-audit-pagination">{loading ? <Loading>以前の履歴を読み込み中</Loading> : !error && (nextCursor !== null ? <button className="p-button" onClick={() => load(nextCursor)}><History size={17} aria-hidden="true" />以前の履歴を表示</button> : <p className="p-muted p-small" role="status">最初の履歴まで表示しました。</p>)}</div></>
}
