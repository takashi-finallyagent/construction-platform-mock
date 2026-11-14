import { useId, useLayoutEffect, useRef, useState } from 'react'
import { Download, FilePlus2, Save, Send, Trash2 } from 'lucide-react'
import type { Notice, PhotoReport, Publication, SitePhoto, WorkflowSectionProps } from './workflow-model'
import { draftPublication } from './workflow-model'
import { documentPdf, downloadDocument, photoReportPdf } from './workflow-documents'
import './site-work.css'

const KINDS: Record<Notice['kind'], string> = { construction: '工事のお知らせ', change: '工事変更のお知らせ', delay: '工事延期のお知らせ', cancel: '工事中止のお知らせ', complete: '工事完了のお知らせ' }
const PHASES: Record<SitePhoto['phase'], string> = { before: '施工前', during: '施工中', after: '完成' }
const IMPACTS = ['騒音', '振動', '粉じん', '断水', '停電', '通行制限', '車両の出入り', '立入制限']
const message = (error: unknown) => error instanceof Error ? error.message : '処理できませんでした。再試行してください。'
const dateValid = (value: string) => /^[12]\d{3}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T12:00:00Z`)) && new Date(`${value}T12:00:00Z`).toISOString().slice(0, 10) === value

function Field({ label, value, onChange, type = 'text', max = 200, multiline = false, required = false }: { label: string; value: string; onChange: (value: string) => void; type?: string; max?: number; multiline?: boolean; required?: boolean }) {
  const id = useId()
  return <label className={`ws-field${multiline ? ' ws-wide' : ''}`} htmlFor={id}><span id={`${id}-label`}>{label}</span>{multiline ? <textarea id={id} aria-labelledby={`${id}-label`} value={value} rows={4} maxLength={max} required={required} onChange={event => onChange(event.target.value)} /> : <input id={id} aria-labelledby={`${id}-label`} type={type} value={value} required={required} maxLength={max} min={type === 'date' ? '1000-01-01' : undefined} max={type === 'date' ? '2999-12-31' : undefined} onChange={event => onChange(event.target.value)} />}</label>
}

function PublicationInfo({ record }: { record: Publication }) {
  return <p className="ws-publication" data-testid="publication-status">{record.status === 'issued' ? `発行済み・内容固定｜発行日時 ${record.issuedAt ? new Date(record.issuedAt).toLocaleString('ja-JP') : '未取得'}｜工事版 ${record.basis?.job.version ?? '未取得'}｜発行者ID ${record.issuedBy ?? '未取得'}` : '下書き'}</p>
}

function PhaseReview({ photos }: { photos: SitePhoto[] }) {
  const missing = (['before', 'after'] as const).filter(phase => !photos.some(photo => photo.phase === phase))
  return missing.length > 0 ? <p className="ws-review" role="status" data-testid="report-phase-review">要確認：{missing.map(phase => PHASES[phase]).join('・')}写真が含まれていません。</p> : <p className="ws-muted">施工前・完成の写真を含む記録</p>
}

function noticeErrors(record: Notice, issuing: boolean): string[] {
  const errors: string[] = []
  if ((record.startsOn && !dateValid(record.startsOn)) || (record.endsOn && !dateValid(record.endsOn))) errors.push('有効な日付を入力してください。')
  if (record.startsOn && record.endsOn && record.endsOn < record.startsOn) errors.push('終了日は開始日以降にしてください。')
  if ([record.timeFrom, record.timeTo].some(time => time && !/^([01]\d|2[0-3]):[0-5]\d$/.test(time))) errors.push('時刻は00:00～23:59で入力してください。')
  if (record.timeFrom && record.timeTo && record.timeTo < record.timeFrom) errors.push('終了時刻は開始時刻以降にしてください。日をまたぐ場合は本文に記載してください。')
  if (issuing && [record.title, record.recipient, record.startsOn, record.endsOn, record.contactName, record.contactPhone, record.message].some(value => !value.trim())) errors.push('発行には件名・宛先・開始日・終了日・連絡先名・電話番号・本文が必要です。')
  return errors
}

function reportPhotos(report: PhotoReport, photos: SitePhoto[]) {
  return report.status === 'issued' ? report.photoSnapshot ?? [] : report.photoIds.flatMap(id => { const photo = photos.find(row => row.id === id); return photo ? [photo] : [] })
}

export function DeliverablesSection(props: WorkflowSectionProps) {
  return <Deliverables key={`${props.userId}/${props.job.companyId}/${props.job.id}`} {...props} />
}

function Deliverables(props: WorkflowSectionProps) {
  const latest = useRef(props)
  useLayoutEffect(() => { latest.current = props }, [props])
  const identity = useRef({ userId: props.userId, companyId: props.job.companyId, jobId: props.job.id })
  const [tab, setTab] = useState<'notices' | 'reports'>('notices')
  const [selection, setSelection] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [working, setWorking] = useState(false)
  const operation = useRef(false)
  const disabled = props.readOnly || props.busy || working
  const selected = props.data[tab].find(record => record.id === selection) ?? props.data[tab][0]
  const residentNotice = tab === 'notices' ? props.data.notices.find(record => record.id === selected?.id) : undefined
  const report = tab === 'reports' ? props.data.reports.find(record => record.id === selected?.id) : undefined
  const validScope = () => latest.current.userId === identity.current.userId && latest.current.job.companyId === identity.current.companyId && latest.current.job.id === identity.current.jobId
  const run = async (action: () => Promise<void>, mutation = true) => {
    if (operation.current || (mutation && (latest.current.readOnly || latest.current.busy))) return
    operation.current = true; setWorking(true); setError(''); setNotice('')
    try { await action() } catch (err) { if (validScope()) setError(message(err)) }
    finally { operation.current = false; if (validScope()) setWorking(false) }
  }
  const updateNotice = (patch: Partial<Notice>) => {
    if (disabled || !residentNotice) return
    const p = latest.current
    p.onChange({ ...p.data, notices: p.data.notices.map(row => row.id === residentNotice.id && row.status === 'draft' ? { ...row, ...patch } : row) })
  }
  const updateReport = (patch: Partial<PhotoReport>) => {
    if (disabled || !report) return
    const p = latest.current
    p.onChange({ ...p.data, reports: p.data.reports.map(row => row.id === report.id && row.status === 'draft' ? { ...row, ...patch } : row) })
  }
  const add = (kind: 'notices' | 'reports') => {
    if (disabled) return
    const p = latest.current
    if (p.data[kind].length >= 200) { setError('書類は各200件までです。不要な下書きを削除してください。'); return }
    const id = crypto.randomUUID()
    if (kind === 'notices') {
      const fresh: Notice = { ...draftPublication(), id, kind: 'construction', title: KINDS.construction, recipient: '近隣にお住まいの皆様', startsOn: p.job.plannedStart ?? '', endsOn: p.job.plannedEnd ?? '', timeFrom: '', timeTo: '', impacts: [], contactName: p.companyName, contactPhone: '', message: '' }
      p.onChange({ ...p.data, notices: [...p.data.notices, fresh] })
    } else {
      const fresh: PhotoReport = { ...draftPublication(), id, title: '工事写真台帳', photoIds: [], photoSnapshot: null, notes: '' }
      p.onChange({ ...p.data, reports: [...p.data.reports, fresh] })
    }
    setTab(kind); setSelection(id); setError(''); setNotice('')
  }
  const persist = (mode: 'save' | 'issue' | 'delete') => void run(async () => {
    const p = latest.current
    const current = p.data[tab].find(row => row.id === selected?.id)
    if (!current || current.status !== 'draft') return
    if (mode === 'delete' && !window.confirm('この下書きを削除して保存します。')) return
    if (mode !== 'delete') {
      const errors = tab === 'notices' ? noticeErrors(current as Notice, mode === 'issue') : []
      if (tab === 'reports') {
        const record = current as PhotoReport
        if (record.photoIds.length > 100) errors.push('写真台帳は1冊100枚までです。')
        if (record.photoIds.some(id => !p.data.photos.some(photo => photo.id === id))) errors.push('選択した写真が見つかりません。写真の選択を確認してください。')
        if (mode === 'issue' && (!record.title.trim() || !record.photoIds.length)) errors.push('台帳名と写真を1枚以上選択してください。')
      }
      if (errors.length) throw new Error(errors.join('\n'))
    }
    if (mode === 'issue' && !window.confirm('この内容を発行し、工事情報と書類内容を固定します。発行済みの書類は編集・削除できません。')) return
    // Server assigns issue metadata and photoSnapshot. Never mark the controlled draft issued before success.
    const data = tab === 'notices' ? { ...p.data, notices: mode === 'delete' ? p.data.notices.filter(row => row.id !== current.id) : p.data.notices.map(row => row.id === current.id && mode === 'issue' ? { ...row, status: 'issued' as const } : row) } : { ...p.data, reports: mode === 'delete' ? p.data.reports.filter(row => row.id !== current.id) : p.data.reports.map(row => row.id === current.id && mode === 'issue' ? { ...row, status: 'issued' as const } : row) }
    if (!await p.onSave(data)) throw new Error('保存できませんでした。入力内容と競合の表示を確認してください。発行済みとしてのPDFは保存成功後に作成できます。')
    setNotice(mode === 'issue' ? '発行しました。内容を固定して保存しました。' : mode === 'delete' ? '下書きを削除しました。' : '下書きを保存しました。')
  })
  const downloadNotice = () => void run(async () => {
    const p = latest.current
    const record = p.data.notices.find(row => row.id === residentNotice?.id)
    if (!record) return
    if (record.status === 'issued' && !record.basis) throw new Error('発行時の工事情報を取得できません。再読み込みしてください。')
    const job = record.status === 'issued' ? record.basis!.job : p.job
    const rows: [string, string][] = [['書類の種類', KINDS[record.kind]], ['宛先', record.recipient], ['工事内容', job.workDescription], ['期間', `${record.startsOn || '未定'} ～ ${record.endsOn || '未定'}`], ['作業時間', `${record.timeFrom || '未記載'} ～ ${record.timeTo || '未記載'}`], ['周辺への影響', record.impacts.join('・')], ['お知らせ', record.message], ['連絡先', `${record.contactName}\n${record.contactPhone}`]]
    if (record.status === 'issued') rows.push(['発行記録', `${record.issuedAt ?? ''}\n発行者ID：${record.issuedBy ?? ''}\n工事版：${job.version}`])
    const blob = await documentPdf(record.title || KINDS[record.kind], job, rows, record.status === 'issued' ? '発行済み / 発行時点の工事情報を使用' : '下書き / 未発行')
    downloadDocument(blob, `${record.title || '工事のお知らせ'}${record.status === 'draft' ? '-下書き' : ''}.pdf`)
  }, false)
  const downloadReport = (info = false) => void run(async () => {
    const p = latest.current
    const record = p.data.reports.find(row => row.id === report?.id)
    if (!record) return
    if (record.status === 'issued' && (!record.basis || !record.photoSnapshot)) throw new Error('発行時の工事情報・写真を取得できません。再読み込みしてください。')
    const job = record.status === 'issued' ? record.basis!.job : p.job
    const photos = reportPhotos(record, p.data.photos)
    if (!photos.length || photos.length > 100 || photos.length !== record.photoIds.length) throw new Error('写真は1～100枚を選択してください。見つからない写真がないか確認してください。')
    const missing = (['before', 'after'] as const).filter(phase => !photos.some(photo => photo.phase === phase))
    const title = `${record.title || '工事写真台帳'}${record.status === 'draft' ? '（下書き）' : ''}`
    const blob = info ? await documentPdf(`${title}・台帳情報`, job, [['状態', record.status === 'issued' ? `発行済み ${record.issuedAt ?? ''}\n発行者ID：${record.issuedBy ?? ''}` : '下書き・未発行'], ['工事版', String(job.version)], ['写真', `${photos.length}枚`], ['記録の確認', missing.length ? `要確認：${missing.map(phase => PHASES[phase]).join('・')}写真なし` : '施工前・完成の写真を含む記録'], ['備考', record.notes]], '写真台帳に添付する情報') : await photoReportPdf(title, job, photos, p.fileUrl)
    downloadDocument(blob, `${record.title || '工事写真台帳'}${record.status === 'draft' ? '-下書き' : ''}${info ? '-台帳情報' : ''}.pdf`)
  }, false)
  const actions = selected?.status === 'draft' ? <div className="ws-actions ws-document-actions"><button type="button" disabled={disabled} onClick={() => persist('save')} data-testid="deliverable-save"><Save size={16} aria-hidden="true" />下書きを保存</button><button type="button" className="ws-primary" disabled={disabled} onClick={() => persist('issue')} data-testid="deliverable-issue"><Send size={16} aria-hidden="true" />発行して固定</button><button type="button" disabled={disabled} onClick={() => persist('delete')}><Trash2 size={16} aria-hidden="true" />下書きを削除</button></div> : null
  const photos = report ? reportPhotos(report, props.data.photos) : []
  return <section className="w-deliverables" aria-label="成果物" data-testid="deliverables-section">
    <header className="ws-heading"><div><h2>成果物</h2><p>{props.job.name}</p></div><button type="button" disabled={disabled} onClick={() => add(tab)} data-testid="deliverable-add"><FilePlus2 size={18} aria-hidden="true" />{tab === 'notices' ? '周知文を作成' : '写真台帳を作成'}</button></header>
    <div className="ws-tabs" role="group" aria-label="成果物の種類"><button type="button" aria-pressed={tab === 'notices'} onClick={() => { setTab('notices'); setSelection(''); setError(''); setNotice('') }}>住民向け周知文 <span>{props.data.notices.length}</span></button><button type="button" aria-pressed={tab === 'reports'} onClick={() => { setTab('reports'); setSelection(''); setError(''); setNotice('') }}>写真台帳 <span>{props.data.reports.length}</span></button></div>
    {props.readOnly && <p className="ws-muted">閲覧・PDFダウンロードのみ</p>}{error && <p role="alert" className="ws-error">{error}</p>}{notice && <p role="status" className="ws-success">{notice}</p>}
    <div className="ws-documents"><nav aria-label="作成した成果物" className="ws-document-list">{props.data[tab].length === 0 && <p className="ws-empty">{tab === 'notices' ? '周知文' : '写真台帳'}はまだありません。</p>}{props.data[tab].map(record => <button type="button" key={record.id} aria-pressed={selected?.id === record.id} onClick={() => { setSelection(record.id); setError(''); setNotice('') }}><strong>{record.title || '件名未入力'}</strong><span>{record.status === 'issued' ? '発行済み・内容固定' : '下書き'}</span></button>)}</nav>
      <div className="ws-document-editor">
        {residentNotice && <article key={residentNotice.id} data-testid="notice-editor"><div className="ws-heading"><h3>{residentNotice.title || '周知文'}</h3><button type="button" disabled={working} onClick={downloadNotice} data-testid="notice-pdf"><Download size={16} aria-hidden="true" />{residentNotice.status === 'draft' ? '下書きPDF' : '発行済みPDF'}</button></div><PublicationInfo record={residentNotice} />
          <fieldset disabled={disabled || residentNotice.status === 'issued'}><legend className="ws-sr">周知文の内容</legend><div className="ws-grid"><label className="ws-field"><span>お知らせの種類</span><select value={residentNotice.kind} onChange={event => updateNotice({ kind: event.target.value as Notice['kind'] })}>{Object.entries(KINDS).map(([value, text]) => <option value={value} key={value}>{text}</option>)}</select></label><Field label="周知文の件名" value={residentNotice.title} required onChange={title => updateNotice({ title })} /><Field label="宛先" value={residentNotice.recipient} required onChange={recipient => updateNotice({ recipient })} /><Field label="開始日" type="date" value={residentNotice.startsOn} required onChange={startsOn => updateNotice({ startsOn })} /><Field label="終了日" type="date" value={residentNotice.endsOn} required onChange={endsOn => updateNotice({ endsOn })} /><Field label="開始時刻" type="time" value={residentNotice.timeFrom} onChange={timeFrom => updateNotice({ timeFrom })} /><Field label="終了時刻" type="time" value={residentNotice.timeTo} onChange={timeTo => updateNotice({ timeTo })} /><Field label="連絡先名" value={residentNotice.contactName} required onChange={contactName => updateNotice({ contactName })} /><Field label="連絡先電話番号" type="tel" max={100} value={residentNotice.contactPhone} required onChange={contactPhone => updateNotice({ contactPhone })} /></div><fieldset className="ws-impacts"><legend>周辺への影響</legend>{[...new Set([...IMPACTS, ...residentNotice.impacts])].map(impact => <label key={impact}><input type="checkbox" checked={residentNotice.impacts.includes(impact)} onChange={event => updateNotice({ impacts: event.target.checked ? [...residentNotice.impacts, impact] : residentNotice.impacts.filter(value => value !== impact) })} />{impact}</label>)}</fieldset><Field label="お知らせ本文" value={residentNotice.message} max={4000} required multiline onChange={message => updateNotice({ message })} /></fieldset>{actions}
        </article>}
        {report && <article key={report.id} data-testid="photo-report-editor"><div className="ws-heading"><h3>{report.title || '写真台帳'}</h3><div className="ws-actions"><button type="button" disabled={working || !photos.length} onClick={() => downloadReport()} data-testid="photo-report-pdf"><Download size={16} aria-hidden="true" />{report.status === 'draft' ? '下書き写真PDF' : '発行済み写真PDF'}</button><button type="button" disabled={working || !photos.length} onClick={() => downloadReport(true)}>備考・台帳情報PDF</button></div></div><PublicationInfo record={report} /><PhaseReview photos={photos} />
          <fieldset disabled={disabled || report.status === 'issued'}><legend className="ws-sr">写真台帳の内容</legend><Field label="写真台帳名" value={report.title} required onChange={title => updateReport({ title })} /><Field label="台帳の備考" value={report.notes} max={2000} multiline onChange={notes => updateReport({ notes })} />
            {report.status === 'draft' && <><div className="ws-heading"><h4>写真を選択 <span>{report.photoIds.length} / 100</span></h4><button type="button" disabled={!report.photoIds.length} onClick={() => updateReport({ photoIds: [] })}>選択を解除</button></div>{props.data.photos.length === 0 && <p className="ws-empty">現場管理で撮影・送信した写真を選択できます。</p>}<div className="ws-report-selection">{props.data.photos.map(photo => <label key={photo.id} className="ws-select-photo" data-testid="report-photo-option"><input type="checkbox" checked={report.photoIds.includes(photo.id)} disabled={!report.photoIds.includes(photo.id) && report.photoIds.length >= 100} onChange={event => updateReport({ photoIds: event.target.checked ? [...report.photoIds, photo.id] : report.photoIds.filter(id => id !== photo.id) })} /><img src={props.fileUrl(photo.fileId)} loading="lazy" alt={photo.caption || PHASES[photo.phase]} /><span><strong>{PHASES[photo.phase]}</strong>{photo.caption || '説明なし'}</span></label>)}</div>{report.photoIds.filter(id => !props.data.photos.some(photo => photo.id === id)).map(id => <div className="ws-error" key={id}>写真が見つかりません：{id}<button type="button" onClick={() => updateReport({ photoIds: report.photoIds.filter(value => value !== id) })}>選択から外す</button></div>)}</>}
          </fieldset>
          {report.status === 'issued' && <><h4>発行時点の写真</h4>{!report.photoSnapshot && <p role="alert" className="ws-error">写真の固定記録を取得できません。</p>}<div className="ws-photo-grid">{photos.map(photo => <figure key={photo.id} data-testid="issued-report-photo"><a href={props.fileUrl(photo.fileId)} target="_blank" rel="noreferrer"><img src={props.fileUrl(photo.fileId)} loading="lazy" alt={photo.caption || PHASES[photo.phase]} /></a><figcaption><strong>{PHASES[photo.phase]}</strong><p>{photo.caption || '説明なし'}</p><small>{photo.capturedAt ? new Date(photo.capturedAt).toLocaleString('ja-JP') : '撮影日時：未確認'}</small><a href={props.fileUrl(photo.fileId)} download>原本をダウンロード</a></figcaption></figure>)}</div></>}{actions}
        </article>}
        {!selected && <p className="ws-empty">{tab === 'notices' ? '周知文' : '写真台帳'}を作成してください。</p>}
      </div>
    </div>
  </section>
}
