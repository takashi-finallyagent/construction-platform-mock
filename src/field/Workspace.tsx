import { useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router'
import { ArrowDownToLine, ArrowLeft, ArrowRight, Building2, CalendarDays, Camera as CameraIcon, Check, CheckCircle2, ChevronRight, Clock3, FileText, FolderOpen, Image as ImageIcon, LoaderCircle, Megaphone, Plus, Search, ShieldCheck, X } from 'lucide-react'
import { useField } from './FieldProvider'
import { Camera, useBlobUrl } from './Camera'
import { dayText, downloadBlob, filename, albumPdf, noticeDefaults, noticePdf, noticePreamble, noticeHasImpacts, impactTexts, paperPdf, schedulePdf, type NoticeInput, type PaperLine } from './pdf'
import { sites as legacySites } from '../data/mock/domain'
import { formatDay, formatTime, localDate, paperLabels, phaseLabels, shiftDate, stageLabels, uid, type FieldJob, type FieldPhoto, type IssuedDocument, type PaperKind, type PhotoPhase, type WorkTask } from './model'
import { saveError } from './storage'
import { ComplianceSummary } from './CompliancePage'
import { PaymentAlerts, PaymentSummary } from './PaymentPage'
import { readiness } from './compliance'
import './field.css'

function Title({ label, title, meta, action }: { label: string; title: string; meta?: string; action?: ReactNode }) {
  return <header className="field-heading"><div><p className="field-eyebrow">{label}</p><h1>{title}</h1>{meta && <p className="field-meta">{meta}</p>}</div>{action}</header>
}
function Empty({ text, children }: { text: string; children?: ReactNode }) {
  return <div className="field-empty"><FolderOpen size={32} /><p>{text}</p>{children}</div>
}
function Loading() { return <div className="field-empty" role="status"><LoaderCircle className="spin" />保存した工事を開いています</div> }
function ErrorMessage({ text }: { text: string }) { return text ? <p className="field-error" role="alert">{text}</p> : null }
function JobLink({ job, compact = false }: { job: FieldJob; compact?: boolean }) {
  const { photos } = useField()
  return <Link className={`job-list-item ${compact ? 'compact' : ''}`} to={`/sites/${job.id}`}>
    <div className="job-symbol"><Building2 size={23} /></div>
    <div className="job-list-copy"><span className="field-meta">{job.building}</span><strong>{job.name}</strong><span className="field-meta">{dayText(job.start, job.end)} · 写真 {photos.filter((p) => p.jobId === job.id).length}枚</span></div>
    <span className={`stage-badge stage-${job.stage}`}>{stageLabels[job.stage]}</span><ChevronRight size={18} />
  </Link>
}

export function FieldHomePage() {
  const { jobs, photos, ready, error } = useField()
  if (!ready) return <Loading />
  const active = jobs.filter((job) => job.stage < 3)
  const current = active[0]
  const jobPhotos = photos.filter((p) => p.jobId === current?.id)
  return <div className="field-page">
    <Title label="ホーム" title="今日の工事" meta={formatDay(localDate())} action={<Link className="field-button secondary" to="/sites?new=1"><Plus size={18} />工事を登録</Link>} />
    <ErrorMessage text={error} />
    {current ? <div className="today-layout">
      <section className="current-job">
        <div className="current-job-top"><span className="working-label"><span />{stageLabels[current.stage]}</span>{(current.id === 'sample-door' || legacySites.some((site) => site.id === current.id)) && <span className="sample-tag">サンプル工事</span>}</div>
        <p className="current-building">{current.building}</p><h2>{current.name}</h2>
        <div className="current-job-meta"><span><CalendarDays size={17} />{dayText(current.start, current.end)}</span><span><Building2 size={17} />{current.part}</span></div>
        <div className="photo-readiness">{(['before', 'during', 'after'] as PhotoPhase[]).map((phase) => <span key={phase} className={jobPhotos.some((p) => p.phase === phase) ? 'has-photo' : ''}><CheckCircle2 size={16} />{phaseLabels[phase]} {jobPhotos.filter((p) => p.phase === phase).length}枚</span>)}</div>
        <div className="current-job-actions"><Link className="field-button camera-primary" to={`/sites/${current.id}/photos?capture=${jobPhotos.some((p) => p.phase === 'before') ? 'during' : 'before'}`}><CameraIcon size={23} />写真を撮る</Link><Link className="field-button secondary" to={`/sites/${current.id}`}>工事を開く<ArrowRight size={18} /></Link></div>
      </section>
      <section className="today-agenda"><div className="field-section-heading"><h2>作業の予定</h2><Link to={`/sites/${current.id}/timeline`} title="工程表を開く" aria-label="工程表を開く"><ArrowRight size={19} /></Link></div>
        {current.tasks.slice(0, 4).map((task) => <div className={`agenda-row ${task.status === '完了' ? 'done' : ''}`} key={task.id}><div className="agenda-time">{task.startTime}<span>{task.endTime}</span></div><div className="agenda-marker">{task.status === '完了' ? <Check size={14} /> : <span />}</div><div><strong>{task.name}</strong><p>{task.company}</p><span className="field-meta">{task.status}</span></div></div>)}
      </section>
    </div> : <Empty text="進行中の工事はありません"><Link className="field-button" to="/sites?new=1"><Plus size={18} />工事を登録</Link></Empty>}
    <PaymentAlerts jobs={jobs} />
    <section><div className="field-section-heading"><h2>工事一覧</h2><Link to="/sites">すべて見る<ChevronRight size={17} /></Link></div><div className="job-list">{jobs.filter((job) => job.id !== current?.id).slice(0, 3).map((job) => <JobLink key={job.id} job={job} compact />)}</div></section>
    <div className="field-home-foot"><span><ShieldCheck size={17} />この端末に保存</span><span>サーバー共有なし</span><Link to="/documents">保存した書類<ArrowRight size={16} /></Link></div>
  </div>
}

export function FieldJobsPage() {
  const { jobs, ready, error } = useField()
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState('active')
  const [params, setParams] = useSearchParams()
  if (!ready) return <Loading />
  const filtered = jobs.filter((job) => (filter === 'all' || (filter === 'active' ? job.stage < 3 : job.stage === 3)) && `${job.name} ${job.building} ${job.part}`.includes(query))
  return <div className="field-page"><Title label="工事" title="工事を探す" action={<button className="field-button" onClick={() => setParams({ new: '1' })}><Plus size={19} />工事を登録</button>} /><ErrorMessage text={error} />
    <div className="field-search-row"><label className="field-search"><Search size={20} /><input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="建物名・工事名・部屋で検索" aria-label="工事を検索" /></label><div className="field-segment">{[['active', '進行中'], ['finished', '完了'], ['all', 'すべて']].map(([value, label]) => <button key={value} aria-pressed={filter === value} onClick={() => setFilter(value)}>{label}</button>)}</div></div>
    <div className="job-list">{filtered.map((job) => <JobLink key={job.id} job={job} />)}{!filtered.length && <Empty text="該当する工事はありません" />}</div>
    {params.has('new') && <NewJob onClose={() => setParams({})} />}
  </div>
}

function NewJob({ onClose }: { onClose: () => void }) {
  const { updateJob } = useField()
  const navigate = useNavigate()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError('')
    const form = new FormData(event.currentTarget)
    const start = String(form.get('start')); const end = String(form.get('end'))
    if (start > end) { setError('完了予定日は開始日以降にしてください。'); setBusy(false); return }
    const job: FieldJob = { id: uid(), name: String(form.get('name')).trim(), building: String(form.get('building')).trim(), part: String(form.get('part')).trim(), client: String(form.get('client')).trim(), company: 'ABC建設株式会社', contact: '045-000-1000', start, end, stage: 0, tasks: [] }
    if (!job.name || !job.building || !job.part || !job.client) { setError('空欄の項目を入力してください。'); setBusy(false); return }
    try { await updateJob(job); navigate(`/sites/${job.id}`) } catch (reason) { setError(saveError(reason)) } finally { setBusy(false) }
  }
  return createPortal(<div className="field-modal-backdrop"><section className="field-modal" role="dialog" aria-modal="true" aria-labelledby="new-job-title"><div className="field-section-heading"><h2 id="new-job-title">工事を登録</h2><button className="field-icon-button" onClick={onClose} disabled={busy} title="閉じる" aria-label="閉じる"><X /></button></div><form className="field-form" onSubmit={(event) => void submit(event)}><ErrorMessage text={error} />
    <label>建物名<input name="building" required maxLength={40} placeholder="例：サンプルマンション" autoFocus /></label>
    <label>工事名<input name="name" required maxLength={40} placeholder="例：201号室 玄関ドア修繕" /></label>
    <label>部屋・部位<input name="part" required maxLength={40} placeholder="例：201号室 / 玄関ドア" /></label>
    <label>提出先<input name="client" required maxLength={40} placeholder="例：管理会社名" /></label>
    <div className="field-form-pair"><label>開始日<input name="start" type="date" defaultValue={localDate()} required /></label><label>完了予定日<input name="end" type="date" defaultValue={localDate()} required /></label></div>
    <button className="field-button" disabled={busy}>{busy ? <LoaderCircle className="spin" size={18} /> : <Check size={18} />}登録して開く</button>
  </form></section></div>, document.body)
}

function useJob() {
  const { siteId } = useParams()
  const state = useField()
  return { ...state, job: state.jobs.find((job) => job.id === siteId) }
}
function JobNav({ job, active }: { job: FieldJob; active: string }) {
  return <nav className="job-nav" aria-label="工事内の画面">{[['進める', ''], ['工程表', '/timeline'], ['写真・記録', '/photos']].map(([label, suffix]) => <Link key={label} className={active === label ? 'active' : ''} aria-current={active === label ? 'page' : undefined} to={`/sites/${job.id}${suffix}`}>{label}</Link>)}</nav>
}
function JobTitle({ job, action }: { job: FieldJob; action?: ReactNode }) {
  return <><Link className="field-back" to="/sites"><ArrowLeft size={16} />工事一覧</Link><Title label={job.building} title={job.name} meta={`${job.part} · ${dayText(job.start, job.end)}`} action={action} /></>
}

export function FieldJobPage() {
  const { job, ready, error: initialError, photos, documents, updateJob } = useJob()
  const [params, setParams] = useSearchParams()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  if (!ready) return <Loading />
  if (!job) return <Empty text={initialError || '工事が見つかりません'} />
  const parsed = Number(params.get('step') ?? job.stage)
  const step = Number.isInteger(parsed) && parsed >= 0 && parsed <= 3 ? parsed : job.stage
  const jobPhotos = photos.filter((p) => p.jobId === job.id)
  const jobDocuments = documents.filter((doc) => doc.jobId === job.id)
  const compliance = readiness(job, Math.min(3, job.stage + 1), localDate())
  async function advance() {
    if (!job || busy) return
    setBusy(true); setError('')
    try { const next = Math.min(3, job.stage + 1); await updateJob({ ...job, stage: next }); setParams({ step: String(next) }) } catch (reason) { setError(saveError(reason)) } finally { setBusy(false) }
  }
  const headings = ['見積と工事条件を準備', '着工前の準備', '現場の作業を記録', '報告と請求をまとめる']
  return <div className="field-page"><JobTitle job={job} /><JobNav job={job} active="進める" />
    {job.stage < 2 && <ComplianceSummary job={job} />}
    <nav className="workflow-steps" aria-label="工事の段階">{stageLabels.map((label, index) => <button key={label} className={`${index === step ? 'selected' : ''} ${index < job.stage ? 'completed' : ''}`} aria-current={step === index ? 'step' : undefined} onClick={() => setParams({ step: String(index) })}><span>{index < job.stage ? <Check size={17} /> : index + 1}</span><strong>{label}</strong>{index === job.stage && <small>現在</small>}</button>)}</nav>
    <section className="work-stage"><div className="field-section-heading"><div><p className="field-eyebrow">今すること</p><h2>{headings[step]}</h2></div><span className="stage-counter">{step + 1} / 4</span></div>
      {step === 0 && <div className="action-list"><Action to={`/sites/${job.id}/paperwork?kind=estimate`} icon={<FileText />} title="見積書を作る" detail={`${job.client} 宛て`} /><Action to={`/sites/${job.id}/paperwork?kind=order`} icon={<FileText />} title="注文書・請書を作る" detail="工事条件・明細" /><Action to={`/sites/${job.id}/photos?capture=before`} icon={<CameraIcon />} title="現地・施工前の写真を撮る" detail={job.part} /></div>}
      {step === 1 && <div className="action-list"><Action to={`/sites/${job.id}/timeline`} icon={<CalendarDays />} title="工程を決める" detail={`${job.tasks.length}工程`} /><Action to={`/sites/${job.id}/notice`} icon={<Megaphone />} title="工事のお知らせを作る" detail="工事日時・注意事項・連絡先" /><Action to={`/sites/${job.id}/paperwork?kind=receipt`} icon={<FileText />} title="注文請書を確認する" detail={job.client} /></div>}
      {step === 2 && <><div className="phase-capture-grid">{(['before', 'during', 'after'] as PhotoPhase[]).map((phase) => <Link className={`phase-capture ${phase}`} key={phase} to={`/sites/${job.id}/photos?capture=${phase}`}><span><CameraIcon size={27} /><strong>{phaseLabels[phase]}を撮る</strong></span><small>{jobPhotos.filter((p) => p.phase === phase).length}枚保存済み<ArrowRight size={18} /></small></Link>)}</div><div className="action-list"><Action to={`/sites/${job.id}/photos`} icon={<ImageIcon />} title="保存した写真・台帳" detail={`${jobPhotos.length}枚 / この端末`} /><Action to={`/sites/${job.id}/timeline`} icon={<CalendarDays />} title="工程の進み具合を確認" detail={`${job.tasks.filter((task) => task.status === '完了').length} / ${job.tasks.length}工程完了`} /></div></>}
      {step === 3 && <div className="action-list"><Action to={`/sites/${job.id}/photos`} icon={<ImageIcon />} title="写真台帳・完了報告書を作る" detail={`${jobPhotos.length}枚保存済み`} /><Action to={`/sites/${job.id}/paperwork?kind=invoice`} icon={<FileText />} title="請求書を作る" detail={job.client} /><Action to="/documents?tab=issued" icon={<FolderOpen />} title="発行した書類を確認" detail={`${jobDocuments.length}件`} /></div>}
    </section>{job.stage >= 2 && <ComplianceSummary job={job} />}<ErrorMessage text={error} />
    {job.stage < 3 && <div className="stage-advance"><span>現在：{stageLabels[job.stage]}</span><button className="field-button secondary" disabled={busy || !compliance.canAdvance} onClick={() => void advance()}>{busy ? <LoaderCircle className="spin" size={17} /> : <Check size={17} />}{stageLabels[job.stage + 1]}へ進む</button></div>}
    <PaymentSummary job={job} />
    <details className="field-records"><summary>工事の基本情報・これまでの記録</summary><JobBasics job={job} /><LegacyLinks job={job} /></details>
  </div>
}
function Action({ to, icon, title, detail }: { to: string; icon: ReactNode; title: string; detail: string }) {
  return <Link className="work-action" to={to}><span className="work-action-icon">{icon}</span><span><strong>{title}</strong><small>{detail}</small></span><ChevronRight size={20} /></Link>
}
function JobBasics({ job }: { job: FieldJob }) {
  const { updateJob } = useField()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [done, setDone] = useState(false)
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (busy) return
    setBusy(true); setError(''); setDone(false)
    const data = new FormData(event.currentTarget)
    const next = { ...job, ...Object.fromEntries(['building', 'name', 'part', 'client', 'company', 'contact', 'start', 'end'].map((key) => [key, String(data.get(key)).trim()])) } as FieldJob
    try {
      if (!next.name || !next.building || !next.part || !next.client || !next.company || !next.contact) throw new Error('空欄の項目を入力してください。')
      if (next.start > next.end) throw new Error('完了予定日は開始日以降にしてください。')
      await updateJob(next); setDone(true)
    } catch (reason) { setError(saveError(reason)) } finally { setBusy(false) }
  }
  return <form className="field-form job-basics" onSubmit={(event) => void submit(event)} onChange={() => setDone(false)}>
    {([['building', '建物名'], ['name', '工事名'], ['part', '部屋・部位'], ['client', '提出先'], ['company', '施工会社'], ['contact', '問い合わせ先']] as const).map(([key, label]) => <label key={key}>{label}<input name={key} required maxLength={40} defaultValue={job[key]} /></label>)}
    <div className="field-form-pair"><label>開始日<input name="start" type="date" required defaultValue={job.start} /></label><label>完了予定日<input name="end" type="date" required defaultValue={job.end} /></label></div>
    <ErrorMessage text={error} />{done && <p className="field-success" role="status">基本情報をこの端末に保存しました</p>}
    <button className="field-button secondary" disabled={busy}><Check size={18} />基本情報を保存</button>
  </form>
}
function LegacyLinks({ job }: { job: FieldJob }) {
  return <div className="legacy-links"><Link to="/transactions">受発注</Link><Link to="/contracts">契約</Link><Link to="/materials">資材</Link><Link to="/employees">人員</Link><Link to="/schedule">人員配置</Link><Link to="/daily-reports">日報</Link><Link to="/invoices">従来の請求一覧</Link><Link to="/labor-insurance">労働保険</Link><Link to="/licenses">建設業許可</Link><Link to="/legacy-documents">従来の書類一覧</Link>{legacySites.some((site) => site.id === job.id) && <Link to={`/sites/${job.id}/legacy`}>従来の現場詳細</Link>}</div>
}

export function FieldPhotosPage() {
  const { job, photos, documents, ready, error: initialError, issueDocument } = useJob()
  const [params, setParams] = useSearchParams()
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [filter, setFilter] = useState('all')
  if (!ready) return <Loading />
  if (!job) return <Empty text={initialError || '工事が見つかりません'} />
  const jobPhotos = photos.filter((p) => p.jobId === job.id).sort((a, b) => a.savedAt.localeCompare(b.savedAt))
  const capture = params.get('capture')
  const phase = capture === 'before' || capture === 'during' || capture === 'after' ? capture : null
  async function exportAlbum() {
    if (!job || busy) return
    setBusy(true); setError('')
    try {
      const blob = await albumPdf(job, jobPhotos)
      const name = filename(job, '写真台帳')
      await issueDocument({ id: uid(), jobId: job.id, title: '工事報告書・写真台帳', kind: 'album', createdAt: new Date().toISOString(), filename: name, blob })
      downloadBlob(blob, name)
    } catch (reason) { setError(saveError(reason)) } finally { setBusy(false) }
  }
  return <div className="field-page"><JobTitle job={job} action={<button className="field-button secondary" onClick={() => void exportAlbum()} disabled={busy || !jobPhotos.length}>{busy ? <LoaderCircle className="spin" size={18} /> : <ArrowDownToLine size={18} />}台帳PDF</button>} /><JobNav job={job} active="写真・記録" />
    <div className="photo-toolbar"><div><h2>工事写真 <span>{jobPhotos.length}枚</span></h2><span className="local-badge"><ShieldCheck size={15} />この端末に保存</span></div><div className="photo-capture-buttons">{(['before', 'during', 'after'] as PhotoPhase[]).map((value) => <button className={`field-button ${value === 'during' ? '' : 'secondary'}`} key={value} onClick={() => setParams({ capture: value })}><CameraIcon size={19} />{phaseLabels[value]}を撮る</button>)}</div></div>
    <ErrorMessage text={error} /><p className="storage-scope">保存した端末のブラウザでのみ閲覧できます。ブラウザのデータを削除すると写真も削除されます。</p>
    <div className="field-segment photo-filter">{[['all', 'すべて'], ...Object.entries(phaseLabels)].map(([value, label]) => <button key={value} aria-pressed={filter === value} onClick={() => setFilter(value)}>{label}</button>)}</div>
    {!jobPhotos.length ? <Empty text="この工事の写真はまだありません"><button className="field-button camera-primary" onClick={() => setParams({ capture: 'before' })}><CameraIcon size={22} />施工前を撮る</button></Empty> : <div className="photo-grid">{jobPhotos.filter((photo) => filter === 'all' || photo.phase === filter).map((photo) => <PhotoCard key={photo.id} photo={photo} />)}{!jobPhotos.some((photo) => filter === 'all' || photo.phase === filter) && <Empty text="この段階の写真はまだありません" />}</div>}
    <section><div className="field-section-heading"><h2>この工事の発行書類</h2><Link to={`/sites/${job.id}/notice`}>お知らせ作成<ChevronRight size={17} /></Link></div><DocumentRows docs={documents.filter((doc) => doc.jobId === job.id)} /></section>
    <details className="field-records"><summary>その他の記録</summary><LegacyLinks job={job} /></details>
    {phase && createPortal(<Camera job={job} phase={phase} onClose={() => setParams({})} />, document.body)}
  </div>
}
function PhotoCard({ photo }: { photo: FieldPhoto }) {
  const { addPhoto } = useField()
  const src = useBlobUrl(photo.blob)
  const [caption, setCaption] = useState(photo.caption)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [zoom, setZoom] = useState(false)
  return <article className="photo-card"><button className="photo-image" onClick={() => setZoom(true)} aria-label={`${phaseLabels[photo.phase]}の写真を拡大`}><img src={src} alt={`${photo.part} ${photo.caption}`} loading="lazy" /></button><div className="photo-card-content"><div className="field-section-heading"><strong className={`photo-phase ${photo.phase}`}>{phaseLabels[photo.phase]}</strong><span className="saved-mark"><CheckCircle2 size={14} />端末保存済み</span></div><p>{photo.part}</p><small>{photo.takenAt ? formatTime(photo.takenAt) : '撮影日時：未確認'} / 登録 {formatTime(photo.savedAt)}</small><details><summary>説明・元の写真</summary><form onSubmit={async (event) => { event.preventDefault(); setBusy(true); setError(''); try { await addPhoto({ ...photo, caption: caption.trim() }); } catch (reason) { setError(saveError(reason)) } finally { setBusy(false) } }}><label>説明<input value={caption} maxLength={80} onChange={(e) => setCaption(e.target.value)} /></label><ErrorMessage text={error} /><button className="field-button secondary" disabled={busy}><Check size={16} />説明を保存</button></form><button className="field-text-button" onClick={() => downloadBlob(photo.blob, `${photo.id}.${photo.blob.type === 'image/png' ? 'png' : 'jpg'}`)}><ArrowDownToLine size={16} />元の写真を保存</button></details></div>
    {zoom && createPortal(<div className="photo-zoom" role="dialog" aria-modal="true" aria-label="写真の拡大"><button className="capture-icon" onClick={() => setZoom(false)} title="閉じる" aria-label="閉じる"><X /></button><img src={src} alt={photo.caption} /><p>{photo.part} / {phaseLabels[photo.phase]}</p></div>, document.body)}
  </article>
}

export function FieldTimelinePage() {
  const { job, ready, error: initialError, updateJob, issueDocument } = useJob()
  const [editing, setEditing] = useState<WorkTask | 'new' | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [view, setView] = useState('list')
  const [week, setWeek] = useState(localDate())
  if (!ready) return <Loading />
  if (!job) return <Empty text={initialError || '工事が見つかりません'} />
  const days = Array.from({ length: 7 }, (_, i) => shiftDate(week, i))
  async function exportSchedule() {
    if (!job || busy) return
    setBusy(true); setError('')
    try { const blob = await schedulePdf(job); const name = filename(job, '工程表'); await issueDocument({ id: uid(), jobId: job.id, title: '工事工程表', kind: 'schedule', filename: name, createdAt: new Date().toISOString(), blob }); downloadBlob(blob, name) } catch (reason) { setError(saveError(reason)) } finally { setBusy(false) }
  }
  return <div className="field-page"><JobTitle job={job} action={<button className="field-button secondary" disabled={busy || !job.tasks.length} onClick={() => void exportSchedule()}><ArrowDownToLine size={18} />工程表PDF</button>} /><JobNav job={job} active="工程表" />
    <div className="timeline-toolbar"><div className="field-segment"><button aria-pressed={view === 'list'} onClick={() => setView('list')}>作業一覧</button><button aria-pressed={view === 'week'} onClick={() => setView('week')}>週の工程表</button></div><button className="field-button" onClick={() => setEditing('new')}><Plus size={19} />工程を追加</button></div><ErrorMessage text={error} />
    {view === 'list' ? <div className="task-list">{job.tasks.map((task, index) => <article className={`task-row ${task.status === '完了' ? 'done' : ''}`} key={task.id}><span className="task-index">{String(index + 1).padStart(2, '0')}</span><div className="task-main"><strong>{task.name}</strong><p><CalendarDays size={15} />{dayText(task.start, task.end)}<Clock3 size={15} />{task.startTime}–{task.endTime}</p><small>{task.company}</small></div><select aria-label={`${task.name}の状態`} value={task.status} disabled={busy} onChange={async (event) => { const status = event.target.value as WorkTask['status']; setBusy(true); setError(''); try { await updateJob({ ...job, tasks: job.tasks.map((t) => t.id === task.id ? { ...t, status } : t) }) } catch (reason) { setError(saveError(reason)) } finally { setBusy(false) } }}><option>未着手</option><option>作業中</option><option>完了</option></select><button className="field-text-button" onClick={() => setEditing(task)}>編集</button></article>)}{!job.tasks.length && <Empty text="工程はまだ登録されていません" />}</div>
      : <><div className="week-switch"><button className="field-icon-button" onClick={() => setWeek(shiftDate(week, -7))} aria-label="前の週" title="前の週"><ArrowLeft size={18} /></button><strong>{formatDay(week)} ～ {formatDay(days[6])}</strong><button className="field-icon-button" onClick={() => setWeek(shiftDate(week, 7))} aria-label="次の週" title="次の週"><ArrowRight size={18} /></button></div><div className="gantt-scroll"><div className="gantt"><div className="gantt-head"><span>工程</span>{days.map((day) => <span key={day} className={day === localDate() ? 'today' : ''}>{formatDay(day)}</span>)}</div>{job.tasks.map((task) => <div className="gantt-row" key={task.id}><button onClick={() => setEditing(task)}>{task.name}<small>{task.company}</small></button>{days.map((day) => <span key={day} className={day >= task.start && day <= task.end ? `gantt-active ${task.status === '完了' ? 'done' : ''}` : ''}>{day === task.start ? task.startTime : ''}</span>)}</div>)}</div></div></>}
    {editing && <TaskEditor job={job} task={editing === 'new' ? undefined : editing} onClose={() => setEditing(null)} />}
  </div>
}
function TaskEditor({ job, task, onClose }: { job: FieldJob; task?: WorkTask; onClose: () => void }) {
  const { updateJob } = useField()
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError(''); setBusy(true)
    const data = new FormData(event.currentTarget)
    const next: WorkTask = { id: task?.id ?? uid(), name: String(data.get('name')).trim(), company: String(data.get('company')).trim(), start: String(data.get('start')), end: String(data.get('end')), startTime: String(data.get('startTime')), endTime: String(data.get('endTime')), status: task?.status ?? '未着手' }
    if (!next.name || !next.company) { setError('作業名と担当業者を入力してください。'); setBusy(false); return }
    if (next.start > next.end || (next.start === next.end && next.startTime >= next.endTime)) { setError('終了は開始より後にしてください。夜間作業は終了日を翌日にしてください。'); setBusy(false); return }
    try { await updateJob({ ...job, tasks: task ? job.tasks.map((item) => item.id === task.id ? next : item) : [...job.tasks, next] }); onClose() } catch (reason) { setError(saveError(reason)) } finally { setBusy(false) }
  }
  return createPortal(<div className="field-modal-backdrop"><section className="field-modal" role="dialog" aria-modal="true" aria-labelledby="task-editor-title"><div className="field-section-heading"><h2 id="task-editor-title">{task ? '工程を編集' : '工程を追加'}</h2><button className="field-icon-button" onClick={onClose} disabled={busy} aria-label="閉じる" title="閉じる"><X /></button></div><form className="field-form" onSubmit={(event) => void submit(event)}><ErrorMessage text={error} /><label>作業名<input required name="name" defaultValue={task?.name} maxLength={40} autoFocus /></label><label>担当業者<input name="company" required defaultValue={task?.company ?? job.company} maxLength={32} /></label><div className="field-form-pair"><label>開始日<input name="start" type="date" defaultValue={task?.start ?? localDate()} required /></label><label>終了日<input name="end" type="date" defaultValue={task?.end ?? localDate()} required /></label></div><div className="field-form-pair"><label>開始時刻<input name="startTime" type="time" defaultValue={task?.startTime ?? '09:00'} required /></label><label>終了時刻<input name="endTime" type="time" defaultValue={task?.endTime ?? '17:00'} required /></label></div><button className="field-button" disabled={busy}><Check size={18} />工程を保存</button></form></section></div>, document.body)
}

const impactLabels: Record<string, string> = { noise: '騒音・振動', water: '断水', power: '停電', access: '通行・駐車の制限', elevator: 'エレベーター制限', dust: '粉じん・臭気', presence: '入室・立会い' }
export function FieldNoticePage() {
  const { job, ready, error } = useJob()
  if (!ready) return <Loading />
  if (!job) return <Empty text={error || '工事が見つかりません'} />
  return <NoticeEditor key={job.id} job={job} />
}
function NoticeEditor({ job }: { job: FieldJob }) {
  const { issueDocument, updateJob } = useField()
  const [input, setInput] = useState<NoticeInput>(() => job.noticeDraft ?? noticeDefaults(job))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [done, setDone] = useState(false)
  const change = (key: keyof NoticeInput, value: string) => { setInput((current) => ({ ...current, [key]: value, ...(key === 'title' ? { extra: value === '工事のお知らせ' ? noticeDefaults(job).extra : '' } : {}) })); setDone(false) }
  const extraLabel = input.title.includes('日程変更') ? '変更前の日程・変更理由' : input.title.includes('延期') ? '延期理由・変更後の日程（未定の場合は未定）' : input.title.includes('中止') ? '中止理由・連絡事項' : '追記事項'
  async function issue(event: FormEvent) {
    event.preventDefault(); if (busy) return
    setBusy(true); setError(''); setDone(false)
    try {
      if (input.start > input.end || (input.start === input.end && input.startTime >= input.endTime)) throw new Error('終了は開始より後にしてください。')
      const blob = await noticePdf(job, input); const name = filename(job, input.title)
      await updateJob({ ...job, noticeDraft: input })
      await issueDocument({ id: uid(), jobId: job.id, title: input.title, kind: 'notice', filename: name, createdAt: new Date().toISOString(), blob })
      downloadBlob(blob, name); setDone(true)
    } catch (reason) { setError(saveError(reason)) } finally { setBusy(false) }
  }
  return <div className="field-page"><JobTitle job={job} /><Link className="field-back" to={`/sites/${job.id}?step=1`}><ArrowLeft size={16} />着工準備</Link><Title label="掲示・配布" title="工事のお知らせ" />
    <div className="notice-layout"><form className="field-form" onSubmit={(event) => void issue(event)}>
      <label>お知らせの種類<select value={input.title} onChange={(e) => change('title', e.target.value)}><option>工事のお知らせ</option><option>工事日程変更のお知らせ</option><option>工事延期のお知らせ</option><option>工事中止のお知らせ</option><option>工事完了のお知らせ</option></select></label>
      <label>宛先<input required value={input.recipient} maxLength={55} onChange={(e) => change('recipient', e.target.value)} /></label>
      <label>作業内容<input required value={input.work} maxLength={55} onChange={(e) => change('work', e.target.value)} /></label>
      <div className="field-form-pair"><label>開始日<input required type="date" value={input.start} onChange={(e) => change('start', e.target.value)} /></label><label>終了日<input required type="date" value={input.end} onChange={(e) => change('end', e.target.value)} /></label></div>
      <div className="field-form-pair"><label>開始時刻<input required type="time" value={input.startTime} onChange={(e) => change('startTime', e.target.value)} /></label><label>終了時刻<input required type="time" value={input.endTime} onChange={(e) => change('endTime', e.target.value)} /></label></div>
      {noticeHasImpacts(input.title) && <fieldset className="impact-options"><legend>住民への影響</legend>{Object.entries(impactLabels).map(([key, label]) => <label key={key}><input type="checkbox" checked={input.impacts.includes(key)} onChange={() => { setDone(false); setInput((value) => ({ ...value, impacts: value.impacts.includes(key) ? value.impacts.filter((v) => v !== key) : [...value.impacts, key] })) }} />{label}</label>)}</fieldset>}
      <label>{extraLabel}<textarea aria-label={extraLabel} required={['日程変更', '延期', '中止'].some((word) => input.title.includes(word))} value={input.extra} maxLength={220} rows={3} onChange={(e) => change('extra', e.target.value)} /></label>
      <ErrorMessage text={error} />{done && <p className="field-success" role="status"><CheckCircle2 size={18} />発行したPDFをこの端末に保存しました</p>}
      <button className="field-button" disabled={busy}>{busy ? <LoaderCircle className="spin" size={19} /> : <ArrowDownToLine size={19} />}PDFを発行・ダウンロード</button>
    </form>
      <section className="notice-preview" aria-label="お知らせのプレビュー"><p className="preview-date">{localDate()}</p><h2>{input.title}</h2><h3>{input.recipient}</h3><p>{noticePreamble(input.title)}</p><dl><div><dt>場所</dt><dd>{job.building} / {job.part}</dd></div><div><dt>内容</dt><dd>{input.work}</dd></div><div><dt>{input.title.includes('中止') || input.title.includes('延期') ? '当初の日時' : input.title.includes('完了') ? '実施日時' : '日時'}</dt><dd>{input.start} ～ {input.end}<br />{input.startTime} ～ {input.endTime}</dd></div></dl>{noticeHasImpacts(input.title) && input.impacts.map((key) => <p key={key} className="notice-impact">{impactTexts[key]}</p>)}<p className="notice-extra">{input.extra}</p><footer>{job.company}<br />お問い合わせ：{job.contact}</footer></section>
    </div>
  </div>
}

export function FieldPaperPage() {
  const { job, ready, error } = useJob()
  const [params] = useSearchParams()
  if (!ready) return <Loading />
  if (!job) return <Empty text={error || '工事が見つかりません'} />
  const raw = params.get('kind')
  const kind: PaperKind = raw === 'order' || raw === 'receipt' || raw === 'invoice' ? raw : 'estimate'
  return <PaperEditor key={job.id} job={job} kind={kind} />
}
function PaperEditor({ job, kind }: { job: FieldJob; kind: PaperKind }) {
  const { issueDocument, updateJob } = useField()
  const [lines, setLines] = useState<PaperLine[]>(job.paperLines ?? [{ name: job.name, quantity: 1, unit: '式', unitPrice: 0, amount: 45000 }])
  const [dueDate, setDueDate] = useState(job.paperDueDate ?? shiftDate(localDate(), 30))
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState(false)
  useEffect(() => setDone(false), [kind])
  const total = lines.reduce((sum, row) => { const amount = row.amount ?? Math.round(row.quantity * row.unitPrice); return sum + (Number.isFinite(amount) ? amount : 0) }, 0)
  const update = (index: number, patch: Partial<PaperLine>) => { setDone(false); setLines((current) => current.map((line, i) => i === index ? { ...line, ...patch } : line)) }
  async function submit(event: FormEvent) {
    event.preventDefault(); if (busy) return
    setBusy(true); setError(''); setDone(false)
    try {
      if (lines.some((line) => !line.name.trim() || !line.unit.trim() || !Number.isFinite(line.quantity) || line.quantity <= 0 || !Number.isFinite(line.amount ?? line.unitPrice) || (line.amount ?? line.unitPrice) < 0) || total <= 0) throw new Error('名称・数量・単位・金額を確認してください。合計は1円以上です。')
      const title = `${paperLabels[kind]}${kind === 'order' || kind === 'receipt' ? '（契約未成立の下書き）' : ''}`
      const blob = await paperPdf(job, kind, lines, dueDate); const name = filename(job, title)
      await updateJob({ ...job, paperLines: lines, paperDueDate: dueDate })
      await issueDocument({ id: uid(), jobId: job.id, title, kind, filename: name, blob, createdAt: new Date().toISOString() }); downloadBlob(blob, name); setDone(true)
    } catch (reason) { setError(saveError(reason)) } finally { setBusy(false) }
  }
  return <div className="field-page"><JobTitle job={job} /><Title label="帳票作成" title={paperLabels[kind]} /><div className="field-segment paper-kind">{Object.entries(paperLabels).map(([value, label]) => <Link className={kind === value ? 'selected' : ''} key={value} to={`/sites/${job.id}/paperwork?kind=${value}`}>{label}</Link>)}</div><form className="field-form paper-editor" onSubmit={(event) => void submit(event)}><p className="field-meta">宛先：{job.client} / 発行日：{localDate()}</p>{lines.map((line, index) => <div className="paper-line" key={index}><div className="field-form-pair"><label>明細 {index + 1}<input required maxLength={40} value={line.name} onChange={(e) => update(index, { name: e.target.value })} /></label><label>金額の入力方法<select value={line.amount === null ? 'unit' : 'fixed'} onChange={(e) => update(index, e.target.value === 'fixed' ? { amount: Math.round(line.quantity * line.unitPrice) } : { amount: null, unitPrice: line.quantity > 0 ? (line.amount ?? line.unitPrice) / line.quantity : 0 })}><option value="fixed">一式金額</option><option value="unit">数量 × 単価</option></select></label></div><div className="paper-numbers"><label>数量<input type="number" min="0.01" step="0.01" required value={Number.isFinite(line.quantity) ? line.quantity : ''} onChange={(e) => update(index, { quantity: e.target.valueAsNumber })} /></label><label>単位<input required maxLength={6} value={line.unit} onChange={(e) => update(index, { unit: e.target.value })} /></label><label>{line.amount === null ? '単価（円）' : '金額（円）'}<input type="number" min="0" step="1" required value={Number.isFinite(line.amount ?? line.unitPrice) ? line.amount ?? line.unitPrice : ''} onChange={(e) => update(index, line.amount === null ? { unitPrice: e.target.valueAsNumber } : { amount: e.target.valueAsNumber })} /></label><button type="button" className="field-icon-button" disabled={lines.length === 1} onClick={() => { setDone(false); setLines((current) => current.filter((_, i) => i !== index)) }} aria-label={`明細${index + 1}を削除`} title="明細を削除"><X size={18} /></button></div></div>)}<button type="button" className="field-text-button" disabled={lines.length >= 6} onClick={() => { setDone(false); setLines((current) => [...current, { name: '', quantity: 1, unit: '式', unitPrice: 0, amount: null }]) }}><Plus size={17} />明細を追加</button><div className="paper-totals"><span>小計 ¥{total.toLocaleString('ja-JP')} / 消費税10% ¥{Math.round(total * 0.1).toLocaleString('ja-JP')}</span><strong>合計 ¥{(total + Math.round(total * 0.1)).toLocaleString('ja-JP')}</strong></div><label className="paper-due">{kind === 'estimate' ? '有効期限' : '支払期限'}<input type="date" required value={dueDate} onChange={(e) => { setDueDate(e.target.value); setDone(false) }} /></label><ErrorMessage text={error} />{done && <p className="field-success" role="status"><CheckCircle2 size={18} />発行したPDFをこの端末に保存しました</p>}<button className="field-button" disabled={busy}>{busy ? <LoaderCircle className="spin" size={19} /> : <ArrowDownToLine size={19} />}PDFを発行・ダウンロード</button></form></div>
}

function DocumentRows({ docs }: { docs: IssuedDocument[] }) {
  const [query, setQuery] = useState('')
  const filtered = docs.filter((doc) => `${doc.title} ${doc.filename}`.includes(query))
  if (!docs.length) return <Empty text="発行した書類はまだありません" />
  return <><label className="field-search document-search"><Search size={18} /><input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="書類名で検索" aria-label="発行書類を検索" /></label><div className="document-list">{filtered.map((doc) => <div className="document-row" key={doc.id}><FileText size={23} /><div><strong>{doc.title}</strong><small>{doc.filename}</small><small>{formatTime(doc.createdAt)} / 発行時点の内容</small></div><button className="field-icon-button" onClick={() => downloadBlob(doc.blob, doc.filename)} title="PDFをダウンロード" aria-label={`${doc.title}をダウンロード`}><ArrowDownToLine size={20} /></button></div>)}{!filtered.length && <Empty text="該当する書類はありません" />}</div></>
}
export function FieldDocumentsPage() {
  const { jobs, documents, ready, error } = useField()
  const [params, setParams] = useSearchParams()
  const [selected, setSelected] = useState('')
  const [templateError, setTemplateError] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => { if (!selected && jobs.length) setSelected(jobs[0].id) }, [jobs, selected])
  if (!ready) return <Loading />
  const issued = params.get('tab') === 'issued'
  const job = jobs.find((item) => item.id === selected)
  const templates = ['工事のお知らせ', '工事日程変更のお知らせ', '工事延期のお知らせ']
  async function downloadTemplate(title: string) {
    if (busy) return
    setBusy(true); setTemplateError('')
    try {
      const blankJob: FieldJob = { id: 'template', name: '＿＿＿＿工事', building: '＿＿＿＿', part: '＿＿＿＿', client: '', company: '施工会社：＿＿＿＿', contact: '担当者・電話：＿＿＿＿', stage: 0, start: '2000-01-01', end: '2000-01-01', tasks: [] }
      const input = { ...noticeDefaults(blankJob), title, recipient: '居住者・ご近隣の皆様へ', start: '＿＿年＿＿月＿＿日', end: '＿＿年＿＿月＿＿日', startTime: '＿＿:＿＿', endTime: '＿＿:＿＿', impacts: [], extra: '住民への影響・注意事項：＿＿＿＿＿＿＿＿＿＿＿＿' }
      downloadBlob(await noticePdf(blankJob, input), `${title}_共通ひな形.pdf`)
    } catch (reason) { setTemplateError(saveError(reason)) } finally { setBusy(false) }
  }
  return <div className="field-page"><Title label="書類" title="書類を作る・探す" /><ErrorMessage text={error} /><div className="field-segment"><button aria-pressed={!issued} onClick={() => setParams({})}>作成する</button><button aria-pressed={issued} onClick={() => setParams({ tab: 'issued' })}>発行済み {documents.length}件</button></div>
    {issued ? <DocumentRows docs={documents} /> : <><section className="document-create"><div className="field-section-heading"><h2>工事から作成</h2></div><label className="job-select-label">工事<select value={selected} onChange={(event) => setSelected(event.target.value)} aria-label="書類を作成する工事">{jobs.map((value) => <option key={value.id} value={value.id}>{value.building} / {value.name}</option>)}</select></label>{job && <div className="document-actions"><Action to={`/sites/${job.id}/notice`} icon={<Megaphone />} title="お知らせ・掲示物" detail="工事情報から作成" /><Action to={`/sites/${job.id}/photos`} icon={<ImageIcon />} title="写真台帳・工事報告書" detail="保存した写真から作成" /><Action to={`/sites/${job.id}/paperwork?kind=estimate`} icon={<FileText />} title="見積・注文・請求" detail="工事情報と明細から作成" /><Action to={`/sites/${job.id}/timeline`} icon={<CalendarDays />} title="工事工程表" detail="作業の予定と実績" /></div>}</section>
      <section><div className="field-section-heading"><h2>全業者共通のひな形</h2></div><ErrorMessage text={templateError} /><div className="template-list">{templates.map((title) => <button key={title} disabled={busy} onClick={() => void downloadTemplate(title)}><FileText size={21} /><span>{title}<small>未記入 / A4 PDF</small></span><ArrowDownToLine size={19} /></button>)}</div></section></>}
    <details className="field-records"><summary>従来の書類・管理台帳</summary><div className="legacy-links"><Link to="/legacy-documents">従来の書類一覧</Link><Link to="/estimates">従来の見積一覧</Link><Link to="/contracts">契約</Link><Link to="/labor-insurance">労働保険</Link><Link to="/licenses">建設業許可</Link><Link to="/company">会社情報</Link><Link to="/settings">設定・ユーザー・監査履歴</Link><Link to="/legacy-dashboard">従来のダッシュボード</Link></div></details>
  </div>
}
