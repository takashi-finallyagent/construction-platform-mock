import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Camera, ChevronLeft, ChevronRight, Download, Plus, RefreshCw, Save, Trash2, Upload, X } from 'lucide-react'
import type { LaborInsurance, ScheduleTask, SitePhoto, WorkflowSectionProps } from './workflow-model'
import { documentPdf, downloadDocument } from './workflow-documents'
import { photoOutbox, scopeKey } from './photo-outbox'
import type { OutboxItem, PhotoOutbox } from './photo-outbox'
import './site-work.css'

const PHASES: Record<SitePhoto['phase'], string> = { before: '施工前', during: '施工中', after: '完成' }
const STATUSES: Record<ScheduleTask['status'], string> = { planned: '予定', active: '進行中', done: '完了' }
const message = (error: unknown) => error instanceof Error ? error.message : '処理に失敗しました。再試行してください。'
const localDate = (date = new Date()) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
const dateValid = (value: string) => /^[12]\d{3}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T12:00:00Z`)) && new Date(`${value}T12:00:00Z`).toISOString().slice(0, 10) === value
const addDays = (value: string, days: number) => { const date = new Date(`${value}T12:00:00`); date.setDate(date.getDate() + days); return localDate(date) }
function monday(value: string) { const day = new Date(`${value}T12:00:00`).getDay(); return addDays(value, -(day === 0 ? 6 : day - 1)) }

function Field({ label, value, onChange, type = 'text', max = 200, multiline = false, required = false }: { label: string; value: string; onChange: (value: string) => void; type?: string; max?: number; multiline?: boolean; required?: boolean }) {
  const id = useId()
  return <label className={`ws-field${multiline ? ' ws-wide' : ''}`} htmlFor={id}><span id={`${id}-label`}>{label}</span>{multiline ? <textarea id={id} aria-labelledby={`${id}-label`} value={value} rows={3} maxLength={max} required={required} onChange={event => onChange(event.target.value)} /> : <input id={id} aria-labelledby={`${id}-label`} type={type} value={value} maxLength={max} required={required} min={type === 'date' ? '1000-01-01' : undefined} max={type === 'date' ? '2999-12-31' : undefined} onChange={event => onChange(event.target.value)} />}</label>
}

function PendingRow({ item, outbox, disabled, retry, run }: { item: OutboxItem; outbox: PhotoOutbox; disabled: boolean; retry: () => Promise<void>; run: (action: () => Promise<void>) => void }) {
  return <li className="ws-pending-row" data-testid="photo-outbox-item" data-photo-id={item.photo.id} data-durable={item.durable}>
    <PendingPreview key={item.converted ? item.name : 'original'} blob={item.blob} phase={item.photo.phase} />
    <div><strong>{PHASES[item.photo.phase]}{item.converted ? '・JPEG変換済み' : ''}</strong><p role="status" data-testid="photo-storage-status">{item.acknowledged ? 'サーバーに保存済み・端末コピー削除待ち' : item.sending ? 'サーバーに送信中' : item.durable ? '端末に保管・送信待ち' : '端末未保管・この画面に一時保持'}</p>{item.error && <p className="ws-error" role="alert">{item.error}</p>}<div className="ws-actions">
      <button type="button" onClick={() => downloadDocument(item.originalBlob ?? item.blob, item.originalName ?? item.name)}><Download size={15} aria-hidden="true" />原本をダウンロード</button>
      {!item.durable && !item.acknowledged && <button type="button" disabled={disabled || item.sending} onClick={() => run(() => outbox.retryStorage(item.key))}>端末保管を再試行</button>}
      <button type="button" disabled={disabled || item.sending || (!item.ready && !item.acknowledged)} onClick={() => run(retry)}><RefreshCw size={15} aria-hidden="true" />{item.acknowledged ? '端末コピー削除を再試行' : '再送信'}</button>
      {!item.ready && !item.acknowledged && <button type="button" disabled={disabled || item.sending} onClick={() => run(async () => {
        downloadDocument(item.originalBlob ?? item.blob, item.originalName ?? item.name)
        if (!window.confirm('原本のダウンロードを確認してください。JPEG変換した写真を送信します。送信成功後、端末内の送信待ちコピーは削除されます。')) return
        await outbox.prepare(item.key, true); await retry()
      })}>原本保存後、JPEGに変換して再送信</button>}
      <button type="button" disabled={disabled || item.sending} onClick={() => { if (window.confirm('この送信待ち写真を端末から破棄します。必要な原本は先にダウンロードしてください。')) run(() => outbox.discard(item.key)) }}><Trash2 size={15} aria-hidden="true" />破棄</button>
    </div></div>
  </li>
}

function PendingPreview({ blob, phase }: { blob: Blob; phase: SitePhoto['phase'] }) {
  const image = useRef<HTMLImageElement>(null)
  useEffect(() => {
    const url = URL.createObjectURL(blob), element = image.current
    if (element) element.src = url
    return () => { if (element?.src === url) element.removeAttribute('src'); URL.revokeObjectURL(url) }
  }, [blob])
  return <img ref={image} alt={`${PHASES[phase]}・送信待ち`} />
}

function CameraDialog({ phase, jobName, disabled, hasUnstored, onPhase, onCapture, onCapturing, onClose }: { phase: SitePhoto['phase']; jobName: string; disabled: boolean; hasUnstored: boolean; onPhase: (phase: SitePhoto['phase']) => void; onCapture: (blob: Blob, name: string, source: SitePhoto['source'], capturedAt: string | null, phase: SitePhoto['phase']) => Promise<void>; onCapturing: (value: boolean) => void; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null)
  const video = useRef<HTMLVideoElement>(null)
  const stream = useRef<MediaStream | null>(null)
  const alive = useRef(true)
  const captureLock = useRef(false)
  const [capturing, setCapturing] = useState(false)
  const [ready, setReady] = useState(false)
  const [error, setError] = useState('')
  const titleId = useId(), inputId = useId()
  const current = useRef({ disabled, onCapture, onCapturing })
  useLayoutEffect(() => { current.current = { disabled, onCapture, onCapturing } }, [disabled, onCapture, onCapturing])
  useEffect(() => {
    alive.current = true
    const returnTo = document.activeElement instanceof HTMLElement ? document.activeElement : null
    dialog.current?.showModal()
    let cancelled = false
    const open = async () => {
      try {
        if (!navigator.mediaDevices?.getUserMedia) throw new Error('カメラを直接起動できません。「端末のカメラで撮影」を使用してください。')
        const result = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false })
        if (cancelled) { result.getTracks().forEach(track => track.stop()); return }
        stream.current = result
        if (video.current) { video.current.srcObject = result; await video.current.play() }
      } catch (err) { if (!cancelled) setError(message(err)) }
    }
    void open()
    return () => { cancelled = true; alive.current = false; stream.current?.getTracks().forEach(track => track.stop()); stream.current = null; returnTo?.focus() }
  }, [])
  const close = () => {
    if (captureLock.current) { setError('写真の端末保管が終わるまでお待ちください。'); return }
    if (hasUnstored && !window.confirm('端末に保管できていない写真があります。カメラを閉じた後も、この現場画面で原本保存・再送信を続けてください。')) return
    onClose()
  }
  const take = async (nativeFile?: File) => {
    if (captureLock.current || current.current.disabled) return
    captureLock.current = true; setCapturing(true); setError(''); current.current.onCapturing(true)
    const selectedPhase = phase
    try {
      let blob: Blob, capturedAt: string | null, source: SitePhoto['source'], name: string
      if (nativeFile) { blob = nativeFile; capturedAt = null; source = 'device-camera'; name = nativeFile.name || 'device-camera-photo' }
      else {
        const element = video.current
        if (!element?.videoWidth || !element.videoHeight) throw new Error('カメラ映像の準備ができていません。')
        capturedAt = new Date().toISOString(); source = 'camera'; name = `site-${capturedAt.replace(/[:.]/g, '-')}.jpg`
        const scale = Math.min(1, 3840 / Math.max(element.videoWidth, element.videoHeight))
        const canvas = document.createElement('canvas')
        canvas.width = Math.max(1, Math.floor(element.videoWidth * scale)); canvas.height = Math.max(1, Math.floor(element.videoHeight * scale))
        try {
          const ctx = canvas.getContext('2d')
          if (!ctx) throw new Error('写真を取り込めませんでした。端末のカメラで撮影してください。')
          ctx.drawImage(element, 0, 0, canvas.width, canvas.height)
          blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(result => result ? resolve(result) : reject(new Error('写真のJPEG変換に失敗しました。')), 'image/jpeg', 0.92))
        } finally { canvas.width = 0; canvas.height = 0 }
      }
      await current.current.onCapture(blob, name, source, capturedAt, selectedPhase)
    } catch (err) { if (alive.current) setError(message(err)) }
    finally { captureLock.current = false; if (alive.current) { setCapturing(false); current.current.onCapturing(false) } }
  }
  return <dialog ref={dialog} className="ws-camera" data-testid="site-camera-dialog" aria-labelledby={titleId} onCancel={event => { event.preventDefault(); close() }}><div className="w-site">
    <header className="ws-heading"><div><h3 id={titleId}>現場写真を撮影</h3><p>{jobName}・{PHASES[phase]}</p></div><button type="button" aria-label="カメラを閉じる" disabled={capturing} onClick={close}><X size={20} /></button></header>
    <video ref={video} autoPlay playsInline muted onLoadedData={() => setReady(true)} aria-label="背面カメラ映像" data-testid="site-camera-video" />
    <fieldset disabled={disabled || capturing}><legend>撮影工程</legend><div className="ws-actions">{Object.entries(PHASES).map(([key, label]) => <button type="button" key={key} aria-pressed={phase === key} onClick={() => onPhase(key as SitePhoto['phase'])}>{label}</button>)}</div></fieldset>
    {error && <p role="alert" className="ws-error">{error}</p>}
    <div className="ws-actions"><button type="button" className="ws-primary" data-testid="site-camera-capture" disabled={disabled || capturing || !ready} onClick={() => void take()}><Camera size={20} aria-hidden="true" />{capturing ? '写真を保管中…' : '撮影して保存・続けて撮影'}</button><label className={`ws-file-button${disabled || capturing ? ' ws-disabled' : ''}`} htmlFor={inputId}><Camera size={18} aria-hidden="true" />端末のカメラで撮影<input id={inputId} data-testid="site-native-camera" type="file" accept="image/*" capture="environment" disabled={disabled || capturing} onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; if (file) void take(file) }} /></label></div>
    <p className="ws-muted">端末カメラからの写真は撮影日時未確認として登録します。</p>
  </div></dialog>
}

export function SiteWorkSection(props: WorkflowSectionProps) {
  return <SiteWork key={scopeKey({ userId: props.userId, companyId: props.job.companyId, jobId: props.job.id })} {...props} />
}

function SiteWork(props: WorkflowSectionProps) {
  const latest = useRef(props)
  useLayoutEffect(() => { latest.current = props }, [props])
  const outbox = useMemo(() => photoOutbox({ userId: props.userId, companyId: props.job.companyId, jobId: props.job.id }), [props.userId, props.job.companyId, props.job.id])
  const [pending, setPending] = useState(() => outbox.snapshot())
  const [storageError, setStorageError] = useState(outbox.storageError)
  const [lastSaved, setLastSaved] = useState(outbox.lastSaved)
  const [camera, setCamera] = useState(false)
  const [phase, setPhase] = useState<SitePhoto['phase']>('before')
  const [filter, setFilter] = useState<SitePhoto['phase'] | 'all'>('all')
  const [week, setWeek] = useState(() => monday(dateValid(props.job.plannedStart ?? '') ? props.job.plannedStart! : localDate()))
  const [working, setWorking] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const operation = useRef(false)
  const alive = useRef(true)
  const capturePending = useRef(false)
  const [capturing, setCapturing] = useState(false)
  const disabled = props.readOnly || props.busy || working
  const hasUnstored = pending.some(item => !item.durable && !item.acknowledged)
  const scope = outbox.scope
  const validScope = () => alive.current && latest.current.userId === scope.userId && latest.current.job.companyId === scope.companyId && latest.current.job.id === scope.jobId
  const flush = (retry = false) => {
    const p = latest.current
    return outbox.flush({
      canSend: () => validScope() && !latest.current.readOnly && !latest.current.busy && navigator.onLine,
      upload: p.onUpload, append: p.onPhoto,
    }, retry)
  }
  const flushRef = useRef(flush)
  useLayoutEffect(() => { flushRef.current = flush })
  useEffect(() => {
    alive.current = true
    const activeScope = () => alive.current && latest.current.userId === outbox.scope.userId && latest.current.job.companyId === outbox.scope.companyId && latest.current.job.id === outbox.scope.jobId
    const sync = () => { setPending(outbox.snapshot().map(item => ({ ...item }))); setStorageError(outbox.storageError); setLastSaved(outbox.lastSaved) }
    const unsubscribe = outbox.subscribe(sync)
    void outbox.restore().then(async () => {
      for (const item of outbox.snapshot()) if (!item.ready && activeScope() && !latest.current.readOnly) await outbox.prepare(item.key)
      if (activeScope()) await flushRef.current()
    }).catch(err => { if (activeScope()) setError(message(err)) })
    const online = () => { void flushRef.current(true).catch(err => { if (activeScope()) setError(message(err)) }) }
    window.addEventListener('online', online)
    return () => { alive.current = false; unsubscribe(); window.removeEventListener('online', online) }
  }, [outbox])
  useEffect(() => {
    latest.current.onTransientDirty?.(hasUnstored || capturing)
    const guard = (event: BeforeUnloadEvent) => { if (hasUnstored || capturing) { event.preventDefault(); event.returnValue = '' } }
    window.addEventListener('beforeunload', guard)
    return () => window.removeEventListener('beforeunload', guard)
  }, [hasUnstored, capturing, props.onTransientDirty])
  useEffect(() => { if (!capturing && !props.busy && !props.readOnly) void flushRef.current().catch(err => setError(message(err))) }, [capturing, props.busy, props.readOnly])
  const run = async (action: () => Promise<void>, mutation = true) => {
    if (operation.current || (mutation && (latest.current.readOnly || latest.current.busy))) return
    operation.current = true; setWorking(true); setError(''); setNotice('')
    try { await action() } catch (err) { if (validScope()) setError(message(err)) }
    finally { operation.current = false; if (validScope()) setWorking(false) }
  }
  const changeTask = (id: string, patch: Partial<ScheduleTask>) => {
    const p = latest.current
    if (!disabled) p.onChange({ ...p.data, tasks: p.data.tasks.map(task => task.id === id ? { ...task, ...patch } : task) })
  }
  const insurance = (patch: Partial<LaborInsurance>) => {
    const p = latest.current
    if (!disabled) p.onChange({ ...p.data, laborInsurance: { ...p.data.laborInsurance, ...patch } })
  }
  const save = () => run(async () => {
    const p = latest.current
    for (const task of p.data.tasks) if (!task.title.trim() || !dateValid(task.startsOn) || !dateValid(task.endsOn) || task.endsOn < task.startsOn) throw new Error('各工程の名称・開始日・終了日を確認してください。終了日は開始日以降です。')
    const insurance = p.data.laborInsurance
    if ((insurance.startsOn && !dateValid(insurance.startsOn)) || (insurance.endsOn && !dateValid(insurance.endsOn)) || (insurance.startsOn && insurance.endsOn && insurance.endsOn < insurance.startsOn)) throw new Error('労災保険の記録期間を確認してください。')
    if (!await p.onSave(p.data)) throw new Error('保存できませんでした。入力内容と競合の表示を確認し、再試行してください。')
    if (validScope()) setNotice('現場の記録を保存しました。')
  })
  const capture = async (blob: Blob, name: string, source: SitePhoto['source'], capturedAt: string | null, selectedPhase: SitePhoto['phase']) => {
    // Permission is checked at shutter time. A later busy/conflict state must not drop an already captured Blob.
    if (!validScope() || capturePending.current) throw new Error('撮影を保存できる状態ではありません。')
    capturePending.current = true; setCapturing(true); latest.current.onTransientDirty?.(true)
    try {
      const key = await outbox.enqueue(blob, name, selectedPhase, source, capturedAt)
      await outbox.prepare(key)
    } finally { capturePending.current = false; if (validScope()) setCapturing(false) }
  }
  const exportSchedule = () => run(async () => {
    const p = latest.current
    const rows: [string, string][] = [...p.data.tasks].sort((a, b) => a.startsOn.localeCompare(b.startsOn)).map(task => [task.title || '名称未入力', `${task.startsOn || '未定'} ～ ${task.endsOn || '未定'}\n担当会社：${task.company || '未入力'}\n状態：${STATUSES[task.status]}\n${task.note}`])
    const blob = await documentPdf('工事工程表', p.job, rows.length ? rows : [['工程', '登録なし']], `${p.companyName} / 入力された工程記録`)
    downloadDocument(blob, `${p.job.name}-工程表.pdf`)
  }, false)
  const days = Array.from({ length: 7 }, (_, index) => addDays(week, index))
  const gallery = props.data.photos.filter(photo => filter === 'all' || photo.phase === filter)
  const evidenceId = useId()
  return <section className="w-site" aria-label="現場管理" data-testid="site-work-section">
    <header className="ws-heading"><div><h2>現場管理</h2><p>{props.job.name}</p></div><div className="ws-actions"><button type="button" disabled={disabled} onClick={() => setCamera(true)} data-testid="site-open-camera" className="ws-primary"><Camera size={18} aria-hidden="true" />写真を撮る</button><button type="button" disabled={disabled || capturing} onClick={() => void save()} data-testid="site-save"><Save size={17} aria-hidden="true" />変更を保存</button></div></header>
    {props.readOnly && <p className="ws-muted">閲覧のみ</p>}{error && <p role="alert" className="ws-error">{error}</p>}{notice && <p role="status" className="ws-success">{notice}</p>}
    {(!props.readOnly || pending.length > 0) && <div className="ws-outbox" data-testid="photo-outbox" aria-label="写真の送信待ち">
      <div className="ws-heading"><h3>写真の送信待ち <span>{pending.length}</span></h3><button type="button" disabled={disabled || !pending.length} onClick={() => void run(() => flush(true))} data-testid="photo-outbox-retry"><RefreshCw size={15} aria-hidden="true" />再送信</button></div>
      {storageError && <p role="alert" className="ws-error">端末保管を読み込めませんでした。{storageError}<button type="button" disabled={disabled} onClick={() => void run(() => outbox.restore())}>読み込みを再試行</button></p>}
      {lastSaved && <p role="status" className="ws-success" data-testid="photo-server-saved" data-photo-id={lastSaved}>サーバーに保存済み</p>}
      {pending.length > 0 && <ul className="ws-pending-list">{pending.map(item => <PendingRow key={item.key} item={item} outbox={outbox} disabled={disabled || capturing} retry={() => flush(true)} run={action => void run(action)} />)}</ul>}
    </div>}
    <div className="ws-section"><div className="ws-heading"><h3>工程表</h3><div className="ws-actions"><button type="button" disabled={working} onClick={() => void exportSchedule()} data-testid="schedule-pdf"><Download size={16} aria-hidden="true" />工程表PDF</button><button type="button" disabled={disabled || props.data.tasks.length >= 200} onClick={() => { const p = latest.current; p.onChange({ ...p.data, tasks: [...p.data.tasks, { id: crypto.randomUUID(), title: '', company: p.companyName, startsOn: localDate(), endsOn: localDate(), status: 'planned', note: '' }] }) }} data-testid="schedule-add"><Plus size={16} aria-hidden="true" />工程を追加</button></div></div>
      <div className="ws-week-toolbar"><button type="button" aria-label="前の週" onClick={() => setWeek(addDays(week, -7))}><ChevronLeft size={17} /></button><span>{days[0]} ～ {days[6]}</span><button type="button" aria-label="次の週" onClick={() => setWeek(addDays(week, 7))}><ChevronRight size={17} /></button><button type="button" onClick={() => setWeek(monday(localDate()))}>今週</button></div>
      <div className="ws-week" role="table" aria-label="週間工程表" data-testid="schedule-week-grid"><div className="ws-week-row" role="row"><span role="columnheader">工程 / 担当会社</span>{days.map(day => <span role="columnheader" key={day}>{Number(day.slice(5, 7))}/{Number(day.slice(8))}<small>{new Date(`${day}T12:00:00`).toLocaleDateString('ja-JP', { weekday: 'short' })}</small></span>)}</div>{props.data.tasks.filter(task => task.startsOn <= days[6] && task.endsOn >= days[0]).map(task => <div className="ws-week-row" role="row" key={task.id}><span role="rowheader"><strong>{task.title || '名称未入力'}</strong><small>{task.company}・{STATUSES[task.status]}</small></span>{days.map(day => <span role="cell" key={day} aria-label={`${day} ${task.startsOn <= day && task.endsOn >= day ? STATUSES[task.status] : '予定なし'}`}><i className={task.startsOn <= day && task.endsOn >= day ? `ws-track ws-${task.status}` : ''} /></span>)}</div>)}</div>
      {props.data.tasks.length === 0 && <p className="ws-empty">工程は登録されていません。</p>}
      <div className="ws-task-list">{props.data.tasks.map((task, index) => <fieldset key={task.id} disabled={disabled} className="ws-task" data-testid="schedule-task"><legend>工程 {index + 1}・{STATUSES[task.status]}</legend><div className="ws-grid"><Field label="工程名" value={task.title} required onChange={title => changeTask(task.id, { title })} /><Field label="担当会社" value={task.company} onChange={company => changeTask(task.id, { company })} /><Field label="開始日" type="date" value={task.startsOn} required onChange={startsOn => changeTask(task.id, { startsOn })} /><Field label="終了日" type="date" value={task.endsOn} required onChange={endsOn => changeTask(task.id, { endsOn })} /><label className="ws-field"><span>工程の状態</span><select value={task.status} onChange={event => changeTask(task.id, { status: event.target.value as ScheduleTask['status'] })}>{Object.entries(STATUSES).map(([value, text]) => <option key={value} value={value}>{text}</option>)}</select></label><Field label="工程の備考" value={task.note} max={2000} multiline onChange={note => changeTask(task.id, { note })} /></div><button type="button" aria-label={`工程${index + 1}を削除`} onClick={() => { if (window.confirm('この工程を削除します。保存すると確定します。')) { const p = latest.current; p.onChange({ ...p.data, tasks: p.data.tasks.filter(row => row.id !== task.id) }) } }}><Trash2 size={15} aria-hidden="true" />工程を削除</button></fieldset>)}</div>
    </div>
    <div className="ws-section"><div className="ws-heading"><h3>現場写真 <span>{props.data.photos.length}</span></h3><label className="ws-inline"><span>写真の工程で絞り込み</span><select aria-label="写真の工程で絞り込み" value={filter} onChange={event => setFilter(event.target.value as typeof filter)}><option value="all">すべて</option>{Object.entries(PHASES).map(([value, text]) => <option key={value} value={value}>{text}</option>)}</select></label></div>
      {gallery.length === 0 && <p className="ws-empty">該当する写真はありません。</p>}<div className="ws-photo-grid">{gallery.map(photo => <figure key={photo.id} data-testid="site-photo" data-photo-id={photo.id}><a href={props.fileUrl(photo.fileId)} target="_blank" rel="noreferrer"><img src={props.fileUrl(photo.fileId)} loading="lazy" alt={photo.caption || `${PHASES[photo.phase]}の現場写真`} /></a><figcaption><strong>{PHASES[photo.phase]}</strong><small>{photo.capturedAt ? new Date(photo.capturedAt).toLocaleString('ja-JP') : '撮影日時：未確認'}</small><fieldset disabled={disabled}><legend className="ws-sr">写真の記録</legend><label className="ws-field"><span>写真の工程</span><select value={photo.phase} onChange={event => { const p = latest.current; p.onChange({ ...p.data, photos: p.data.photos.map(row => row.id === photo.id ? { ...row, phase: event.target.value as SitePhoto['phase'] } : row) }) }}>{Object.entries(PHASES).map(([value, text]) => <option key={value} value={value}>{text}</option>)}</select></label><Field label="写真の説明" value={photo.caption} max={1000} multiline onChange={caption => { const p = latest.current; p.onChange({ ...p.data, photos: p.data.photos.map(row => row.id === photo.id ? { ...row, caption } : row) }) }} /></fieldset><a href={props.fileUrl(photo.fileId)} download><Download size={15} aria-hidden="true" />原本をダウンロード</a></figcaption></figure>)}</div>
    </div>
    <details className="ws-section" data-testid="site-labor-insurance"><summary>現場の労災保険</summary><p className="ws-muted">この現場の手配内容を手入力で記録します。法的な適用判定は行いません。</p><fieldset disabled={disabled}><legend className="ws-sr">現場の労災保険の記録</legend><div className="ws-grid"><label className="ws-field"><span>手配区分</span><select value={props.data.laborInsurance.arrangement} onChange={event => insurance({ arrangement: event.target.value as LaborInsurance['arrangement'] })}><option value="unknown">未確認</option><option value="blanket">一括有期事業として手配</option><option value="individual">単独有期事業として手配</option></select></label><Field label="手配元・元請名" value={props.data.laborInsurance.principalName} onChange={principalName => insurance({ principalName })} /><Field label="労働保険番号" value={props.data.laborInsurance.insuranceNumber} max={100} onChange={insuranceNumber => insurance({ insuranceNumber })} /><Field label="保険期間の開始日" type="date" value={props.data.laborInsurance.startsOn ?? ''} onChange={startsOn => insurance({ startsOn: startsOn || null })} /><Field label="保険期間の終了日" type="date" value={props.data.laborInsurance.endsOn ?? ''} onChange={endsOn => insurance({ endsOn: endsOn || null })} /><Field label="労災保険の備考" value={props.data.laborInsurance.note} max={2000} multiline onChange={note => insurance({ note })} /></div>
      <label className="ws-file-button" htmlFor={evidenceId}><Upload size={16} aria-hidden="true" />証拠資料を追加<input id={evidenceId} type="file" accept="application/pdf,image/jpeg,image/png" onChange={event => {
        const file = event.target.files?.[0]; event.target.value = ''
        if (file) void run(async () => {
          if (!['application/pdf', 'image/jpeg', 'image/png'].includes(file.type) || !file.size || file.size > 10 * 1024 * 1024) throw new Error('証拠資料は10 MiB以下のPDF・JPEG・PNGを選択してください。')
          const stored = await latest.current.onUpload(file, file.name, 'evidence')
          if (!validScope() || latest.current.readOnly) return
          const p = latest.current
          p.onChange({ ...p.data, laborInsurance: { ...p.data.laborInsurance, evidenceIds: [...new Set([...p.data.laborInsurance.evidenceIds, stored.id])] } })
          setNotice('証拠資料を追加しました。「変更を保存」で現場の記録を確定してください。')
        })
      }} /></label><div className="ws-evidence">{props.files.filter(file => file.kind === 'evidence' && file.companyId === props.job.companyId && file.jobId === props.job.id).map(file => <label key={file.id}><input type="checkbox" checked={props.data.laborInsurance.evidenceIds.includes(file.id)} onChange={event => insurance({ evidenceIds: event.target.checked ? [...props.data.laborInsurance.evidenceIds, file.id] : props.data.laborInsurance.evidenceIds.filter(id => id !== file.id) })} />{file.name}</label>)}</div></fieldset><div className="ws-actions">{props.data.laborInsurance.evidenceIds.map(id => <a key={id} href={props.fileUrl(id)} download>{props.files.find(file => file.id === id)?.name ?? '証拠資料をダウンロード'}</a>)}</div><button type="button" disabled={disabled} onClick={() => void save()}><Save size={16} aria-hidden="true" />変更を保存</button></details>
    {camera && !props.readOnly && <CameraDialog phase={phase} jobName={props.job.name} disabled={props.busy || working} hasUnstored={hasUnstored} onPhase={setPhase} onCapture={capture} onCapturing={value => { setCapturing(value); latest.current.onTransientDirty?.(value || outbox.snapshot().some(item => !item.durable && !item.acknowledged)) }} onClose={() => setCamera(false)} />}
  </section>
}
