import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { AlertCircle, ArrowRight, Check, ChevronDown, Download, History, LoaderCircle, RefreshCw, Save, Upload } from 'lucide-react'
import { api, ApiError, errorMessage } from './api'
import type { Company, Job } from './api'
import { classificationApi } from './classification-api'
import type { ClassificationView } from './classification-model'
import { EstimatesContractsSection, BillingSection } from './CommercialSection'
import { SiteWorkSection } from './SiteWorkSection'
import { DeliverablesSection } from './DeliverablesSection'
import { workflowApi } from './workflow-api'
import { emptyWorkflow } from './workflow-model'
import type { ReviewRecord, StoredFile, WorkflowAudit, WorkflowData, WorkflowSectionProps, WorkflowView } from './workflow-model'
import './workflow.css'

const SECTIONS = ['確認記録', '見積・契約', '工程・写真', '成果・掲示', '請求・支払']
const DATA_LABELS: Record<string, string> = { reviews: '確認記録', estimates: '見積', contracts: '契約書案', contractEvents: '交付・承諾等', tasks: '工程', photos: '写真', notices: 'お知らせ', reports: '写真台帳', invoices: '請求', payments: '入出金', milestones: '完成・引渡し等', laborInsurance: '労災保険', title: '名称', description: '内容', status: '状態', note: '記録内容', notes: '備考', recipient: '宛先', issuer: '発行者', amountYen: '金額', paidOn: '入出金日', eventDate: '実施日', dueOn: '契約期日', issuedOn: '文書日付', startsOn: '開始日', endsOn: '終了日', reviewedOn: '確認日', conclusion: '確認結果', items: '明細', terms: '契約条件', counterparty: '相手方', quantity: '数量', unit: '単位', unitPrice: '単価', taxRate: '税率', rounding: '端数処理', phase: '撮影区分', caption: '説明', capturedAt: '撮影日時', method: '方法', reference: '参照番号', bank: '口座', registrationNumber: '登録番号', kind: '種類', type: '記録種別', evidenceIds: '資料', classificationVersion: '分類版', jobVersion: '工事版', effectiveDate: '効力日', changeReason: '変更理由', scope: '施工範囲', exclusions: '含まない工事', startDate: '着工日', endDate: '完成日', handoverDate: '引渡日', workingHours: '施工時間', nonWorkingDays: '施工しない日', paymentTerms: '支払条件', inspectionTerms: '検査・引渡し', changeTerms: '変更方法', priceChangeTerms: '価格変動', suppliedTerms: '支給品', thirdPartyDamageTerms: '第三者損害', forceMajeureTerms: '不可抗力', delayTerms: '履行遅滞', defectTerms: '契約不適合', disputeTerms: '紛争解決', riskNotice: '事前通知事項', principalName: '元請名', insuranceNumber: '保険番号', arrangement: '保険の扱い', name: '工事名', siteAddress: '所在地', customerName: '発注者', workDescription: '施工内容', plannedStart: '開始予定', plannedEnd: '終了予定', partyRole: '当社の立場', recipientAddress: '宛先住所', issuerAddress: '発行者住所', validUntil: '有効期限', contactName: '連絡先', contactPhone: '電話', message: '掲示内容', impacts: '影響', timeFrom: '開始時間', timeTo: '終了時間', company: '担当業者', source: '撮影方法', number: '請求番号', direction: '入出金区分' }
const VALUE_LABELS: Record<string, string> = { draft: '下書き', issued: '発行済み', confirmed: '確認記録あり', not_applicable: '対象外として記録', needs_action: '要対応', planned: '予定', active: '施工中', done: '実施済み', before: '施工前', during: '施工中', after: '完成', receiving: '受注', ordering: '発注', receivable: '入金', payable: '支払', payment: '実績', reversal: '取消記録', unknown: '未確認', blanket: '一括', individual: '単独', delivered: '交付・送付', accepted: '承諾を記録', change_requested: '変更依頼', cancelled: '取消・解除', completion_notice: '完成通知', inspection: '検査', handover_offer: '引渡申出', handover: '引渡し', upstream_receipt: '上位入金', floor: '切捨て', round: '四捨五入', ceil: '切上げ', initial: '当初', change: '変更', material: '材料費', labor: '労務費', welfare: '法定福利費', safety: '安全衛生経費', retirement: '建退共掛金等', other: 'その他' }
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` }
const alert = (message: string) => <p className="w-alert" role="alert"><AlertCircle size={17} aria-hidden="true" />{message}</p>

function Snapshot({ data, files }: { data: WorkflowData; files: StoredFile[] }) {
  const render = (value: unknown, key = ''): React.ReactNode => {
    if (value === null || value === '') return '未設定'
    if (typeof value === 'string') return VALUE_LABELS[value] ?? value
    if (typeof value === 'number') return String(value)
    if (Array.isArray(value)) return key === 'evidenceIds' ? value.map(id => files.find(file => file.id === id)?.name ?? '資料IDを照合').join('、') || 'なし' : <ol>{value.map((item, index) => <li key={index}>{render(item)}</li>)}</ol>
    if (value && typeof value === 'object') return <dl>{Object.entries(value).filter(([field]) => !['id', 'fileId', 'estimateId', 'contractId', 'invoiceId', 'originalContractId', 'reversesId', 'issueId', 'issuedBy', 'schemaVersion'].includes(field)).map(([field, entry]) => <div key={field}><dt>{DATA_LABELS[field] ?? field}</dt><dd>{render(entry, field)}</dd></div>)}</dl>
    return String(value)
  }
  return <div className="w-snapshot">{Object.entries(data).filter(([key]) => key !== 'schemaVersion').map(([key, value]) => <details key={key}><summary>{DATA_LABELS[key]}{Array.isArray(value) ? ` ${value.length}件` : ''}</summary>{render(value)}</details>)}</div>
}

export default function WorkflowPanel({ company, userId, job, onJob, onExpire, onDirty, onOpenClassification }: { company: Company; userId: string; job: Job; onJob: (job: Job) => void; onExpire: () => void; onDirty: (dirty: boolean) => void; onOpenClassification: () => void }) {
  const [view, setView] = useState<WorkflowView | null>(null)
  const [draft, setDraft] = useState<WorkflowData>(emptyWorkflow)
  const [basisJob, setBasisJob] = useState(job)
  const [classification, setClassification] = useState<ClassificationView | null>(null)
  const [files, setFiles] = useState<StoredFile[]>([])
  const [section, setSection] = useState(0)
  const [busy, setBusy] = useState(false)
  const [transient, setTransient] = useState(false)
  const [blocked, setBlocked] = useState(false)
  const [current, setCurrent] = useState<WorkflowView | null>(null)
  const [sent, setSent] = useState<WorkflowData | null>(null)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const [retry, setRetry] = useState(0)
  const [history, setHistory] = useState(false)
  const [formEpoch, setFormEpoch] = useState(0)
  const scope = useRef<AbortController | null>(null)
  const locked = useRef(false)
  const state = useRef({ view, draft, transient })
  const readOnly = company.role === 'viewer'
  const changed = !!view && !equal(draft, view.data)
  const transientDirty = useCallback((value: boolean) => setTransient(value), [])
  useLayoutEffect(() => { state.current = { view, draft, transient } }, [view, draft, transient])
  useEffect(() => { onDirty(!readOnly && (changed || transient || busy || blocked)); return () => onDirty(false) }, [changed, transient, busy, blocked, readOnly, onDirty])
  useEffect(() => {
    const controller = new AbortController(); scope.current = controller
    void Promise.all([workflowApi.get(company.id, job.id, controller.signal), api.get(company.id, job.id, controller.signal), classificationApi.get(company.id, job.id, controller.signal), workflowApi.files(company.id, job.id, controller.signal)]).then(([next, currentJob, cv, stored]) => {
      if (controller.signal.aborted) return
      if (next.jobVersion !== currentJob.version || next.classificationVersion !== (cv.record?.version ?? null)) throw new Error('記録の版が変わりました。再読込してください。')
      setView(next); setDraft(next.data); setBasisJob(currentJob); onJob(currentJob); setClassification(cv); setFiles(stored)
    }).catch(reason => { if (!controller.signal.aborted) { if (reason instanceof ApiError && reason.status === 401) onExpire(); else setError(errorMessage(reason)) } })
    return () => controller.abort()
  }, [company.id, job.id, retry, onExpire, onJob])
  const handleError = (reason: unknown) => { if (reason instanceof ApiError && reason.status === 401) onExpire(); else setError(errorMessage(reason)) }
  const save = async (data: WorkflowData): Promise<boolean> => {
    const basis = state.current.view
    if (!basis || readOnly || locked.current || blocked || !scope.current) return false
    setSent(structuredClone(data)); setMessage(''); setError(''); setBusy(true); locked.current = true
    const signal = scope.current.signal
    try {
      const next = await workflowApi.put(company.id, job.id, { version: basis.version, jobVersion: basis.jobVersion, classificationVersion: basis.classificationVersion, data }, signal)
      if (signal.aborted) return false
      setView(next); setDraft(next.data); setCurrent(null); setMessage('業務記録を保存しました。'); return true
    } catch (reason) {
      if (!signal.aborted) {
        if (!(reason instanceof ApiError) || [0, 409, 500, 502, 503, 504].includes(reason.status)) { setDraft(data); setBlocked(true) }
        handleError(reason)
      }
      return false
    } finally { if (!signal.aborted) { locked.current = false; setBusy(false) } }
  }
  const reloadCurrent = async () => {
    if (locked.current || !scope.current) return
    locked.current = true; setBusy(true); setError('')
    const signal = scope.current.signal
    try {
      const [next, currentJob, cv, stored] = await Promise.all([workflowApi.get(company.id, job.id, signal), api.get(company.id, job.id, signal), classificationApi.get(company.id, job.id, signal), workflowApi.files(company.id, job.id, signal)])
      if (signal.aborted) return
      if (next.jobVersion !== currentJob.version || next.classificationVersion !== (cv.record?.version ?? null)) throw new Error('確認中に別の更新がありました。再試行してください。')
      setCurrent(next); setBasisJob(currentJob); onJob(currentJob); setClassification(cv); setFiles(stored)
    } catch (reason) { if (!signal.aborted) handleError(reason) }
    finally { if (!signal.aborted) { locked.current = false; setBusy(false) } }
  }
  const upload: WorkflowSectionProps['onUpload'] = async (blob, name, kind, id = crypto.randomUUID()) => {
    if (readOnly || !scope.current) throw new Error('保存権限を確認してください。')
    try {
      const stored = await workflowApi.upload(company.id, job.id, blob, name, kind, id, scope.current.signal)
      if (scope.current.signal.aborted) throw new Error('画面が切り替わりました。保存内容を再確認してください。')
      setFiles(previous => previous.some(file => file.id === stored.id) ? previous : [...previous, stored]); return stored
    } catch (reason) { if (reason instanceof ApiError && reason.status === 401) onExpire(); throw reason }
  }
  const photo: WorkflowSectionProps['onPhoto'] = async record => {
    if (readOnly || !scope.current || locked.current) return false
    locked.current = true; setBusy(true)
    const signal = scope.current.signal
    try {
      const next = await workflowApi.photo(company.id, job.id, record, signal)
      if (signal.aborted) return false
      const latest = state.current
      if (latest.view && (!equal(latest.view.data, latest.draft) || latest.transient)) {
        setCurrent(next); setBlocked(true); setMessage('写真はサーバーへ保存しました。入力中の記録を保存する前に、現在の記録と照合してください。')
      } else { setView(next); setDraft(next.data); setMessage('写真をサーバーに保存しました。') }
      return true
    } catch (reason) { if (!signal.aborted) handleError(reason); return false }
    finally { if (!signal.aborted) { locked.current = false; setBusy(false) } }
  }
  if (!view) return <div className="w-workflow">{error ? <>{alert(error)}<button className="p-button" onClick={() => { setError(''); setRetry(n => n + 1) }}><RefreshCw size={17} />再試行</button></> : <p className="p-loading" role="status"><LoaderCircle className="p-spin" size={18} />業務記録を読み込み中</p>}</div>
  const props: WorkflowSectionProps = { job: basisJob, companyName: company.name, data: draft, files, readOnly: readOnly || blocked, busy, userId, onChange: data => { setDraft(data); setMessage('') }, onSave: save, onUpload: upload, onPhoto: photo, fileUrl: id => workflowApi.fileUrl(company.id, job.id, id), onTransientDirty: transientDirty }
  const switchSection = (index: number) => {
    if (busy) return
    if (transient && !window.confirm('追加前の入力を破棄して移動しますか？')) return
    setTransient(false); setSection(index)
  }
  const discardForCurrent = () => {
    if (!current || !window.confirm('保持した入力を破棄し、現在の保存内容を表示しますか？')) return
    setView(current); setDraft(current.data); setCurrent(null); setBlocked(false); setTransient(false); setError(''); setFormEpoch(value => value + 1); setMessage('現在の保存内容を表示しました。')
  }
  return <div className="w-workflow">
    <div className="w-heading"><h2>工事を進める</h2><span className="p-muted p-small">{view.version ? `記録 版 ${view.version}` : '業務記録は未保存'}</span></div>
    {message && <p className="p-success" role="status"><Check size={17} />{message}</p>}{error && alert(error)}
    {blocked && <section className="w-conflict" aria-label="業務記録の照合"><h3>保存結果・現在の記録を確認してください</h3><p>入力は保持しています。自動では再送しません。</p><button className="p-button" disabled={busy} onClick={() => void reloadCurrent()}><RefreshCw size={17} />現在の業務記録を確認</button>
      {current && <><p>現在の記録 版 {current.version}</p><div className="w-compare"><section><h4>編集開始時</h4><Snapshot data={view.data} files={files} /></section><section><h4>直前の送信内容</h4><Snapshot data={sent ?? draft} files={files} /></section><section><h4>現在の保存内容</h4><Snapshot data={current.data} files={files} /></section><section><h4>保持している入力</h4><Snapshot data={draft} files={files} /></section></div>
        <div className="w-actions"><button className="p-button" disabled={busy} onClick={() => { setView(current); setCurrent(null); setBlocked(false); setError(''); setMessage('比較した版を選びました。保持した入力を見直して保存してください。') }}><Check size={17} />比較して、保持した入力を見直す</button><button className="p-button" disabled={busy} onClick={discardForCurrent}>入力を破棄して現在の内容を表示</button></div>
      </>}
    </section>}
    <nav className="w-steps" aria-label="工事の進め方">{SECTIONS.map((label, index) => <button key={label} type="button" aria-current={section === index ? 'step' : undefined} disabled={busy} onClick={() => switchSection(index)}><span>{index + 1}</span>{label}</button>)}</nav>
    <div key={formEpoch}>{section === 0 ? <ReviewSection props={props} classification={classification} onOpenClassification={onOpenClassification} /> : section === 1 ? <EstimatesContractsSection {...props} /> : section === 2 ? <SiteWorkSection {...props} /> : section === 3 ? <DeliverablesSection {...props} /> : <BillingSection {...props} />}</div>
    {!readOnly && <div className="w-save-bar"><span className="p-muted p-small">{changed ? '未保存の変更があります' : '保存した内容を表示中'}</span><button type="button" className="p-button p-primary" disabled={busy || blocked || !changed} onClick={() => void save(draft)}>{busy ? <LoaderCircle className="p-spin" size={17} /> : <Save size={17} />}業務記録を保存</button></div>}
    <FileLibrary props={props} />
    {!readOnly && <section className="w-history"><button className="p-text-button" type="button" aria-expanded={history} onClick={() => setHistory(value => !value)}><History size={17} />業務記録の変更履歴<ChevronDown size={15} /></button>{history && <WorkflowHistory key={view.version} companyId={company.id} jobId={job.id} files={files} onExpire={onExpire} />}</section>}
  </div>
}

function FileLibrary({ props }: { props: WorkflowSectionProps }) {
  const [error, setError] = useState(''), [uploading, setUploading] = useState(false), [limit, setLimit] = useState(20)
  const locked = useRef(false)
  const upload = async (file?: File) => {
    if (!file || locked.current || props.readOnly || props.busy) return
    locked.current = true; setUploading(true); setError('')
    try { await props.onUpload(file, file.name, 'evidence') } catch (reason) { setError(errorMessage(reason)) }
    finally { locked.current = false; setUploading(false) }
  }
  return <details className="w-files"><summary>この工事の資料 {props.files.length}件</summary>{!props.readOnly && <label className="w-upload"><Upload size={16} />資料を追加<input type="file" accept="application/pdf,image/jpeg,image/png,image/webp" disabled={props.busy || uploading} onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; void upload(file) }} /></label>}{uploading && <p role="status">資料を保存中</p>}{error && alert(error)}<ul>{props.files.slice(0, limit).map(file => <li key={file.id}><a href={props.fileUrl(file.id)} target="_blank" rel="noreferrer" download><Download size={15} />{file.name}</a><span>{Math.ceil(file.size / 1024)} KB</span></li>)}</ul>{props.files.length > limit && <button className="p-text-button" onClick={() => setLimit(value => value + 20)}>以前の資料を表示</button>}</details>
}

function ReviewSection({ props, classification, onOpenClassification }: { props: WorkflowSectionProps; classification: ClassificationView | null; onOpenClassification: () => void }) {
  const [selected, setSelected] = useState(''), [conclusion, setConclusion] = useState<ReviewRecord['conclusion']>('needs_action'), [date, setDate] = useState(today), [note, setNote] = useState(''), [evidenceIds, setEvidenceIds] = useState<string[]>([]), [error, setError] = useState(''), [uploading, setUploading] = useState(false)
  const transient = (action: () => void) => { action(); props.onTransientDirty?.(true) }
  const issues = classification?.issues.filter(issue => issue.kind === 'review' || issue.kind === 'out_of_scope') ?? []
  const record = classification?.record
  const attemptId = useRef<string | null>(null)
  const latest = (issueId: string) => props.data.reviews.filter(review => review.issueId === issueId && review.classificationVersion === record?.version && review.jobVersion === props.job.version).at(-1)
  const add = async () => {
    if (!record || props.busy || props.readOnly) return
    if (!selected || !date || !note.trim() || conclusion !== 'needs_action' && !evidenceIds.length) { setError('確認事項、日付、記録内容、確認の根拠資料を入力してください。'); return }
    if (attemptId.current && props.data.reviews.some(review => review.id === attemptId.current)) {
      setError('直前の確認記録は保持されています。業務記録の保存内容を確認してください。'); return
    }
    attemptId.current ??= crypto.randomUUID()
    const review: ReviewRecord = { id: attemptId.current, issueId: selected, classificationVersion: record.version, jobVersion: props.job.version, conclusion, reviewedOn: date, evidenceIds, note }
    const ok = await props.onSave({ ...props.data, reviews: [...props.data.reviews, review] })
    if (ok) { attemptId.current = null; setSelected(''); setNote(''); setEvidenceIds([]); setError(''); props.onTransientDirty?.(false) }
  }
  return <section className="w-reviews"><h3>資料の確認記録</h3><div className="w-actions"><button className="p-button" type="button" disabled={props.busy} onClick={onOpenClassification}><ArrowRight size={17} />工事条件の回答を見る</button></div>{!record ? <p>先に工事条件を保存してください。</p> : <>
    {!!classification?.staleReasons.length && alert('工事条件の前提が更新されています。工事条件を見直してください。')}
    <ul className="w-issue-list">{issues.map(issue => { const review = latest(issue.id); return <li key={issue.id}><div><strong>{issue.title}</strong><span className="p-muted p-small">{review ? `${VALUE_LABELS[review.conclusion]} / ${review.reviewedOn}` : '確認記録なし'}</span></div>{!props.readOnly && <button type="button" className="p-text-button" disabled={props.busy} onClick={() => { if (note && !window.confirm('追加前の確認内容を破棄しますか？')) return; setSelected(issue.id); setNote(''); setEvidenceIds([]); props.onTransientDirty?.(false) }}>記録する</button>}</li> })}</ul>
    {selected && !props.readOnly && <fieldset disabled={props.busy || uploading}><legend>確認結果を記録</legend><div className="w-form-grid"><label>確認日<input aria-label="確認記録の日付" type="date" value={date} onChange={event => transient(() => setDate(event.target.value))} /></label><label>確認結果<select value={conclusion} onChange={event => transient(() => setConclusion(event.target.value as ReviewRecord['conclusion']))}><option value="needs_action">要対応</option><option value="confirmed">確認記録あり</option><option value="not_applicable">対象外として記録</option></select></label><label className="w-wide">記録内容<textarea maxLength={2000} value={note} onChange={event => transient(() => setNote(event.target.value))} /></label><label className="w-wide">根拠資料を追加<input type="file" accept="application/pdf,image/jpeg,image/png,image/webp" onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; if (!file) return; setUploading(true); void props.onUpload(file, file.name, 'evidence').then(stored => { setEvidenceIds(previous => [...new Set([...previous, stored.id])]); props.onTransientDirty?.(true) }).catch(reason => setError(errorMessage(reason))).finally(() => setUploading(false)) }} /></label></div><div className="w-evidence-list">{props.files.map(file => <label key={file.id}><input type="checkbox" checked={evidenceIds.includes(file.id)} onChange={event => transient(() => setEvidenceIds(previous => event.target.checked ? [...previous, file.id] : previous.filter(id => id !== file.id)))} />{file.name}</label>)}</div>{error && alert(error)}<button className="p-button p-primary" type="button" onClick={() => void add()}><Save size={17} />確認結果を保存</button></fieldset>}
    <details><summary>これまでの確認記録 {props.data.reviews.length}件</summary><ul className="w-issue-list">{[...props.data.reviews].reverse().map(review => <li key={review.id}><div><strong>{issues.find(issue => issue.id === review.issueId)?.title ?? '以前の確認事項'}</strong><p>{review.reviewedOn} / {VALUE_LABELS[review.conclusion]} / 分類版 {review.classificationVersion}・工事版 {review.jobVersion}</p><p>{review.note}</p><div className="w-file-links">{review.evidenceIds.map(id => <a key={id} href={props.fileUrl(id)} target="_blank" rel="noreferrer">{props.files.find(file => file.id === id)?.name ?? '根拠資料'}</a>)}</div></div></li>)}</ul></details>
  </>}</section>
}

function WorkflowHistory({ companyId, jobId, files, onExpire }: { companyId: string; jobId: string; files: StoredFile[]; onExpire: () => void }) {
  const [events, setEvents] = useState<WorkflowAudit[]>([]), [request, setRequest] = useState<{ cursor: string | null; attempt: number }>({ cursor: null, attempt: 0 }), [cursor, setCursor] = useState<string | null>(null), [busy, setBusy] = useState(true), [error, setError] = useState('')
  useEffect(() => {
    const controller = new AbortController()
    void workflowApi.audit(companyId, jobId, request.cursor, controller.signal).then(page => {
      if (controller.signal.aborted) return
      setEvents(old => request.cursor === null ? page.events : [...old, ...page.events.filter(event => !old.some(value => value.id === event.id))]); setCursor(page.nextCursor)
    }).catch(reason => { if (!controller.signal.aborted) { if (reason instanceof ApiError && reason.status === 401) onExpire(); else setError(errorMessage(reason)) } }).finally(() => { if (!controller.signal.aborted) setBusy(false) })
    return () => controller.abort()
  }, [companyId, jobId, request, onExpire])
  const load = (value: string | null) => { if (!busy) { setError(''); setBusy(true); setRequest(previous => ({ cursor: value, attempt: previous.attempt + 1 })) } }
  return <div><ol className="w-audit-list">{events.map(event => <li key={event.id}><details><summary>版 {event.version} / {event.actorName} / {new Date(event.occurredAt).toLocaleString('ja-JP')}</summary>{event.beforeData && <><h4>変更前</h4><Snapshot data={event.beforeData} files={files} /></>}<h4>保存内容</h4><Snapshot data={event.afterData} files={files} /></details></li>)}</ol>{error && <>{alert(error)}<button className="p-button" disabled={busy} onClick={() => load(request.cursor)}>履歴の取得を再試行</button></>}{busy ? <p role="status">履歴を読み込み中</p> : cursor && !error ? <button className="p-button" onClick={() => load(cursor)}>以前の業務履歴を表示</button> : !error && <p className="p-muted p-small">最初の業務履歴まで表示しました。</p>}</div>
}
