import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import type { ChangeEvent, ReactNode } from 'react'
import { Download, FilePlus2, Plus, Save, Send, Trash2, Upload, Undo2 } from 'lucide-react'
import { CONTRACT_TERM_LABELS, documentTotals, draftPublication, emptyTerms, invoicePaid, lineTotal, yen } from './workflow-model'
import type { Contract, ContractEvent, Estimate, Invoice, LineItem, Milestone, PaymentRecord, Publication, WorkflowData, WorkflowSectionProps } from './workflow-model'
import { documentPdf, downloadDocument } from './workflow-documents'
import './commercial.css'

const CATEGORIES: Record<LineItem['category'], string> = { material: '材料費', labor: '労務費', welfare: '法定福利費', safety: '安全衛生経費', retirement: '建退共掛金等', other: 'その他' }
const EVENT_LABELS: Record<ContractEvent['type'], string> = { delivered: '交付・送付', accepted: '相手方の承諾を記録', change_requested: '変更依頼', cancelled: '取消・解除の連絡' }
const MILESTONE_LABELS: Record<Milestone['type'], string> = { completion_notice: '完成通知', inspection: '検査', handover_offer: '引渡しの申出', handover: '引渡し', upstream_receipt: '上位からの入金' }
const CONTRACT_PDF_TITLE = '工事請負契約書案（社内発行・双方交換は別記録）'
const TERM_HINTS: Partial<Record<keyof Contract['terms'], string>> = {
  paymentTerms: '前払金・出来高払・残額それぞれの支払時期と方法を記載してください。前払金がない場合も「前払なし」と明示します。',
  changeTerms: '設計変更・延期・中止について、変更・協議の手続と、工期変更・損害負担・算定方法を記載してください。',
  forceMajeureTerms: '不可抗力による工期変更と、損害の負担範囲・算定方法を記載してください。',
}
const CHANGE_FIELDS = { previousId: '直前の契約ID', oldTotal: '変更前の全体額（円）', newTotal: '変更後の全体額（円）', periodImpact: '工期への影響', reason: '変更の内容・理由' } as const
type ChangeDetails = Record<keyof typeof CHANGE_FIELDS, string>
function parseChange(value: string): ChangeDetails {
  const details: ChangeDetails = { previousId: '', oldTotal: '', newTotal: '', periodImpact: '', reason: '' }
  const entries = Object.entries(CHANGE_FIELDS) as [keyof ChangeDetails, string][]
  if (!value.startsWith(`${entries[0][1]}: `)) return { ...details, reason: value }
  for (let index = 0; index < entries.length; index++) {
    const [key, label] = entries[index]
    const start = value.indexOf(`${label}: `)
    const next = entries[index + 1]
    const end = next ? value.indexOf(`\n${next[1]}: `, start) : value.length
    if (start >= 0) details[key] = value.slice(start + label.length + 2, end >= 0 ? end : undefined)
  }
  return details
}
const formatChange = (value: ChangeDetails) => (Object.entries(CHANGE_FIELDS) as [keyof ChangeDetails, string][]).map(([key, label]) => `${label}: ${value[key]}`).join('\n')
type ContractEventDraft = ContractEvent & { deliveryDirection: '' | 'outgoing' | 'incoming'; sender: string; recipient: string; deliveryMethod: string; signerName: string; signerRole: string; authorityMethod: string }
function savedEvent(draft: ContractEventDraft): ContractEvent {
  const { id, contractId, type, eventDate, counterparty, evidenceIds, note } = draft
  const details = type === 'delivered' ? `【交付の記録】\n方向: ${draft.deliveryDirection === 'outgoing' ? '当社から相手方へ' : '相手方から当社へ'}\n送付者: ${draft.sender}\n受取人: ${draft.recipient}\n方法: ${draft.deliveryMethod}` : type === 'accepted' ? `【承諾の手動記録】\n署名者名: ${draft.signerName}\n役職・立場: ${draft.signerRole}\n権限確認の方法・根拠（担当者の記録）: ${draft.authorityMethod}` : ''
  return { id, contractId, type, eventDate, counterparty, evidenceIds, note: `${details}${details ? '\n\n【補足・確認方法】\n' : ''}${note}` }
}
const id = () => crypto.randomUUID()
const today = () => { const date = new Date(); return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}` }
const moneyValid = (value: string) => /^(0|[1-9]\d{0,11})$/.test(value)
const quantityValid = (value: string) => /^(0|[1-9]\d{0,8})(\.\d{1,2})?$/.test(value)
const dateValid = (value: string) => {
  if (!/^[12]\d{3}-\d{2}-\d{2}$/.test(value)) return false
  const [y, m, d] = value.split('-').map(Number)
  const date = new Date(2000, m - 1, d); date.setFullYear(y)
  return date.getFullYear() === y && date.getMonth() === m - 1 && date.getDate() === d
}
const message = (error: unknown) => error instanceof Error ? error.message : '処理できませんでした。再試行してください。'
const required = (value: string, check: boolean) => check && !value.trim() ? '入力してください。' : undefined
const dateError = (value: string, check: boolean) => value ? !dateValid(value) ? '有効な日付を入力してください。' : undefined : required(value, check)
const totalsOf = (record: Estimate | Invoice) => { try { return documentTotals(record) } catch { return null } }
const totalText = (record: Estimate | Invoice) => { const totals = totalsOf(record); return totals ? yen(totals.total) : '金額を確認' }

function useLatest<T>(value: T) {
  const ref = useRef(value)
  useLayoutEffect(() => { ref.current = value }, [value])
  return ref
}

function useActions(props: WorkflowSectionProps) {
  const latest = useLatest(props)
  const active = useRef(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const run = async (action: () => Promise<void>, mutation = true) => {
    if (active.current || (mutation && (latest.current.readOnly || latest.current.busy))) return
    active.current = true; setPending(true); setError(''); setNotice('')
    try { await action() } catch (err) { setError(message(err)) }
    finally { active.current = false; setPending(false) }
  }
  const save = async (data: WorkflowData) => {
    const ok = await latest.current.onSave(data)
    if (!ok) { setError('保存できませんでした。入力内容と画面上のエラーを確認してください。'); return false }
    setNotice('保存しました。'); return true
  }
  return { latest, pending, error, notice, run, save, setError, disabled: props.readOnly || props.busy || pending }
}
type Actions = ReturnType<typeof useActions>

type OperationDraft = ContractEventDraft | PaymentRecord | Milestone
type OperationStore = ReturnType<typeof useOperationDrafts>

// Only new, uncommitted operations live here. Canonical records always come from props.
// Keeping these above the internal tabs preserves input when the selected record changes.
function useOperationDrafts(props: WorkflowSectionProps) {
  const [values, setValues] = useState<Record<string, OperationDraft>>({})
  const dirty = Object.keys(values).length > 0
  const onTransientDirty = props.onTransientDirty
  useEffect(() => { onTransientDirty?.(dirty) }, [dirty, onTransientDirty])
  return {
    values,
    set: (key: string, value: OperationDraft) => setValues(current => ({ ...current, [key]: value })),
    clear: (key: string) => setValues(current => { const next = { ...current }; delete next[key]; return next }),
    discard: (key: string) => {
      if (window.confirm('入力中の記録を破棄します。保存済みの履歴は残ります。')) setValues(current => { const next = { ...current }; delete next[key]; return next })
    },
  }
}

function Field({ label, value, onChange, type = 'text', max = 200, error, multiline = false, hint }: { label: string; value: string; onChange: (value: string) => void; type?: string; max?: number; error?: string; multiline?: boolean; hint?: string }) {
  const inputId = useId()
  const common = { id: inputId, value, onChange: (event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => onChange(event.target.value), maxLength: max, 'aria-invalid': !!error, 'aria-describedby': error || hint ? `${inputId}-help` : undefined }
  return <div className={`wc-field${multiline ? ' wc-wide' : ''}`}><label htmlFor={inputId}>{label}</label>{multiline ? <textarea {...common} rows={3} /> : <input {...common} type={type} inputMode={label.includes('金額') || label.includes('単価') ? 'numeric' : undefined} min={type === 'date' ? '1000-01-01' : undefined} max={type === 'date' ? '2999-12-31' : undefined} />}{(error || hint) && <small id={`${inputId}-help`} className={error ? 'wc-invalid' : ''}>{error || hint}</small>}</div>
}

function Select<T extends string>({ label, value, options, onChange, empty, error }: { label: string; value: T; options: readonly (readonly [string, string])[]; onChange: (value: T) => void; empty?: string; error?: string }) {
  const selectId = useId()
  return <div className="wc-field"><label htmlFor={selectId}>{label}</label><select id={selectId} value={value} onChange={event => onChange(event.target.value as T)} aria-invalid={!!error} aria-describedby={error ? `${selectId}-error` : undefined}>{empty !== undefined && <option value="">{empty}</option>}{options.map(([key, text]) => <option key={key} value={key}>{text}</option>)}</select>{error && <small id={`${selectId}-error`} className="wc-invalid">{error}</small>}</div>
}

function Feedback({ actions }: { actions: Actions }) {
  return <>{actions.error && <p role="alert" className="wc-error">{actions.error}</p>}{actions.notice && <p role="status" className="wc-notice">{actions.notice}</p>}</>
}

function PublicationInfo({ record }: { record: Publication }) {
  return <p className="wc-publication">{record.status === 'draft' ? '下書き — 保存後も編集できます。' : `発行済み・内容固定｜発行日時 ${record.issuedAt ?? '未取得'}｜発行者ID ${record.issuedBy ?? '未取得'}｜工事版 ${record.basis?.job.version ?? '未取得'}`}</p>
}

function Evidence({ props, value, onChange, disabled, actions }: { props: WorkflowSectionProps; value: string[]; onChange: (value: string[]) => void; disabled: boolean; actions: Actions }) {
  const latest = useLatest({ props, value, onChange })
  const [pending, setPending] = useState(false)
  const uploading = useRef(false)
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const [error, setError] = useState('')
  const inputId = useId()
  const upload = async (file: File | undefined) => {
    if (!file || uploading.current || disabled || latest.current.props.readOnly || latest.current.props.busy) return
    if (!['application/pdf', 'image/jpeg', 'image/png'].includes(file.type)) { setError('PDF・JPEG・PNGを選択してください。'); return }
    if (!file.size || file.size > 10 * 1024 * 1024) { setError('空でない10 MB以下のファイルを選択してください。'); return }
    if (latest.current.value.length >= 200) { setError('証拠資料は1記録200件までです。'); return }
    await actions.run(async () => {
      uploading.current = true; setPending(true); setError('')
      // Mark the local operation dirty before the upload starts so navigation is guarded.
      latest.current.onChange([...latest.current.value])
      try {
        const stored = await latest.current.props.onUpload(file, file.name, 'evidence')
        if (mounted.current && !latest.current.props.readOnly) latest.current.onChange([...new Set([...latest.current.value, stored.id])])
      } catch (err) { if (mounted.current) setError(message(err)) }
      finally { uploading.current = false; if (mounted.current) setPending(false) }
    })
  }
  return <div className="wc-evidence"><label htmlFor={inputId}><Upload size={15} aria-hidden="true" /> 証拠資料を追加（PDF・JPEG・PNG、10 MB以下）</label><input id={inputId} type="file" accept="application/pdf,image/jpeg,image/png" disabled={disabled || pending} onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; void upload(file) }} />{pending && <p role="status">アップロード中…</p>}{error && <p role="alert" className="wc-invalid">{error}</p>}<fieldset disabled={disabled || pending}><legend>既存資料から選択</legend>{props.files.length === 0 && <p className="wc-muted">資料はまだありません。</p>}{props.files.map(file => <label className="wc-check" key={file.id}><input type="checkbox" disabled={value.length >= 200 && !value.includes(file.id)} checked={value.includes(file.id)} onChange={event => onChange(event.target.checked ? [...value, file.id] : value.filter(key => key !== file.id))} />{file.name}</label>)}{value.filter(key => !props.files.some(file => file.id === key)).map(key => <span key={key} className="wc-muted">選択資料ID: {key}</span>)}</fieldset><FileLinks ids={value} props={props} /></div>
}

function FileLinks({ ids, props }: { ids: string[]; props: WorkflowSectionProps }) {
  return <div className="wc-file-links">{ids.map(key => <a key={key} href={props.fileUrl(key)} target="_blank" rel="noreferrer" download title="資料をダウンロード"><Download size={14} aria-hidden="true" />{props.files.find(file => file.id === key)?.name ?? key}</a>)}</div>
}

function Items({ record, onChange, check }: { record: Estimate | Invoice; onChange: (patch: Partial<Estimate & Invoice>) => void; check: boolean }) {
  const update = (key: string, patch: Partial<LineItem>) => onChange({ items: record.items.map(item => item.id === key ? { ...item, ...patch } : item) })
  const totals = totalsOf(record)
  return <div className="wc-items"><div className="wc-subheading"><h4>明細</h4><button type="button" disabled={record.items.length >= 100} onClick={() => onChange({ items: [...record.items, { id: id(), description: '', category: 'material', quantity: '1', unit: '', unitPrice: '0' }] })}><Plus size={15} aria-hidden="true" />行を追加</button></div><p className="wc-muted">数量は整数9桁・小数2桁、単価は円単位12桁以内。行金額の円未満は切捨て。明細は100行まで。</p>{record.items.length === 0 && <p className={check ? 'wc-invalid' : 'wc-muted'}>明細を追加してください。費用区分を行ごとに選択します。</p>}<div className="wc-table-scroll"><table className="wc-lines"><thead><tr><th scope="col">内容・費用区分</th><th scope="col">数量・単位</th><th scope="col">単価（円）</th><th scope="col">金額</th><th scope="col"><span className="wc-sr">操作</span></th></tr></thead><tbody>{record.items.map((item, index) => <tr key={item.id}><td><Field label={`明細${index + 1} 内容`} value={item.description} max={500} onChange={description => update(item.id, { description })} error={required(item.description, check)} /><Select label={`明細${index + 1} 費用区分`} value={item.category} options={Object.entries(CATEGORIES)} onChange={category => update(item.id, { category })} /></td><td><Field label={`明細${index + 1} 数量`} value={item.quantity} max={12} onChange={quantity => update(item.id, { quantity })} error={!quantityValid(item.quantity) ? '整数9桁・小数2桁以内の半角数字' : undefined} /><Field label={`明細${index + 1} 単位`} value={item.unit} max={30} onChange={unit => update(item.id, { unit })} error={required(item.unit, check)} /></td><td><Field label={`明細${index + 1} 単価`} value={item.unitPrice} max={12} onChange={unitPrice => update(item.id, { unitPrice })} error={!moneyValid(item.unitPrice) ? '円単位・12桁以内の半角数字' : undefined} /></td><td>{quantityValid(item.quantity) && moneyValid(item.unitPrice) ? yen(lineTotal(item).toString()) : '—'}</td><td><button type="button" className="wc-icon" title={`明細${index + 1}を削除`} aria-label={`明細${index + 1}を削除`} onClick={() => onChange({ items: record.items.filter(row => row.id !== item.id) })}><Trash2 size={17} /></button></td></tr>)}</tbody></table></div><div className="wc-grid"><Select label="消費税率" value={record.taxRate} options={[["10", '10%'], ['8', '8%'], ['0', '0%']]} onChange={taxRate => onChange({ taxRate })} /><Select label="消費税の端数処理" value={record.rounding} options={[["floor", '切捨て'], ['round', '四捨五入'], ['ceil', '切上げ']]} onChange={rounding => onChange({ rounding })} /></div>{totals ? <dl className="wc-totals"><div><dt>税抜小計</dt><dd>{yen(totals.subtotal)}</dd></div><div><dt>消費税（{record.taxRate}%）</dt><dd>{yen(totals.tax)}</dd></div><div><dt>合計</dt><dd>{yen(totals.total)}</dd></div></dl> : <p role="alert" className="wc-invalid">数量・単価を確認してください。税込合計の上限は999,999,999,999円です。</p>}</div>
}

function itemErrors(record: Estimate | Invoice): string[] {
  const errors: string[] = []
  if (!record.items.length) errors.push('明細を1行以上追加してください。')
  if (record.items.some(item => !item.description.trim() || !item.unit.trim() || !quantityValid(item.quantity) || !moneyValid(item.unitPrice))) errors.push('各明細の内容・単位・数量・単価を確認してください。')
  if (!totalsOf(record)) errors.push('合計金額または税の設定を確認してください。')
  return errors
}

function estimateErrors(record: Estimate): string[] {
  const errors = itemErrors(record)
  if ([record.title, record.recipient, record.recipientAddress, record.issuer, record.issuerAddress].some(value => !value.trim())) errors.push('件名・宛先と住所・発行者と住所を入力してください。')
  if (!dateValid(record.issuedOn) || (record.validUntil !== null && !dateValid(record.validUntil))) errors.push('発行日・有効期限を確認してください。')
  if (record.validUntil && record.validUntil < record.issuedOn) errors.push('有効期限は発行日以降にしてください。')
  return errors
}

function contractErrors(record: Contract, data: WorkflowData): string[] {
  const errors: string[] = []
  if (!record.title.trim() || !record.counterparty.trim()) errors.push('契約名・相手方を入力してください。')
  if (!data.estimates.some(estimate => estimate.id === record.estimateId && estimate.status === 'issued')) errors.push('発行済み見積を選択してください。')
  if (!record.effectiveDate || !dateValid(record.effectiveDate)) errors.push('契約日を入力してください。')
  if (record.kind === 'change' && (!record.changeReason.trim() || !data.contracts.some(contract => contract.id === record.originalContractId && contract.status === 'issued'))) errors.push('変更元の発行済み契約と変更理由を確認してください。')
  const estimate = data.estimates.find(row => row.id === record.estimateId)
  if (estimate && record.counterparty.trim() !== (record.partyRole === 'receiving' ? estimate.recipient.trim() : estimate.issuer.trim())) errors.push('受注時の相手方は見積の宛先、発注時の相手方は見積の発行者と一致させてください。')
  if (record.kind === 'change') {
    const details = parseChange(record.changeReason)
    const previous = data.contracts.find(row => row.id === details.previousId && row.status === 'issued')
    const previousEstimate = previous && data.estimates.find(row => row.id === previous.estimateId)
    if (!previous || (previous.originalContractId ?? previous.id) !== record.originalContractId) errors.push('直前の発行済み契約IDを、同じ当初契約の履歴から指定してください。')
    if (!moneyValid(details.oldTotal) || !previousEstimate || details.oldTotal !== totalsOf(previousEstimate)?.total) errors.push('変更前の全体額は直前の契約が参照する見積の税込合計と一致させてください。')
    if (!moneyValid(details.newTotal) || !estimate || details.newTotal !== totalsOf(estimate)?.total) errors.push('変更後の全体額は選択した見積の税込合計と一致させてください。差額ではなく全体額を入力します。')
    if (!details.periodImpact.trim() || !details.reason.trim()) errors.push('工期への影響と変更の内容・理由を入力してください。影響がない場合も「なし」と明示してください。')
  }
  for (const [key, label] of Object.entries(CONTRACT_TERM_LABELS)) {
    if (!record.terms[key as keyof Contract['terms']].trim()) errors.push(`${label}を入力してください。該当しない場合は「なし」と明示します。`)
  }
  for (const key of ['startDate', 'endDate', 'handoverDate'] as const) if (!dateValid(record.terms[key])) errors.push(`${CONTRACT_TERM_LABELS[key]}を確認してください。`)
  if (record.terms.startDate > record.terms.endDate || record.terms.endDate > record.terms.handoverDate) errors.push('着工日・完成日・引渡日の前後関係を確認してください。')
  return errors
}

function invoiceErrors(record: Invoice, data: WorkflowData): string[] {
  const errors = itemErrors(record)
  if ([record.number, record.recipient, record.issuer].some(value => !value.trim())) errors.push('請求番号・宛先・発行者を入力してください。')
  if (!data.contracts.some(contract => contract.id === record.contractId && contract.status === 'issued')) errors.push('発行済み契約を選択してください。')
  if (!dateValid(record.issuedOn) || !dateValid(record.dueOn)) errors.push('発行日・契約で定めた期日を入力してください。')
  if (record.dueOn && record.issuedOn && record.dueOn < record.issuedOn) errors.push('契約で定めた期日が発行日より前です。日付を確認してください。')
  if (!record.bank.trim()) errors.push('振込先・支払方法を入力してください。現金等の場合も明示してください。')
  const linkedContract = data.contracts.find(contract => contract.id === record.contractId)
  if (linkedContract && (record.direction === 'receivable') !== (linkedContract.partyRole === 'receiving')) errors.push('受注契約は売掛、発注契約は買掛として記録してください。')
  if (record.registrationNumber && !/^T\d{13}$/.test(record.registrationNumber)) errors.push('登録番号はTと半角数字13桁で入力してください。')
  return errors
}

function Errors({ errors }: { errors: string[] }) {
  return errors.length ? <div className="wc-error" role="alert"><p>発行前に確認してください。</p><ul>{errors.map((error, index) => <li key={index}>{error}</li>)}</ul></div> : null
}

function ChangeReasonFields({ value, onChange, check }: { value: string; onChange: (value: string) => void; check: boolean }) {
  const details = parseChange(value)
  return <div className="wc-grid" aria-label="変更契約の内訳">{(Object.keys(CHANGE_FIELDS) as (keyof ChangeDetails)[]).map(key => <Field key={key} label={CHANGE_FIELDS[key]} value={details[key]} max={key === 'previousId' ? 36 : key === 'oldTotal' || key === 'newTotal' ? 12 : key === 'reason' ? 1000 : 500} multiline={key === 'reason'} onChange={next => onChange(formatChange({ ...details, [key]: next }))} error={key === 'oldTotal' || key === 'newTotal' ? (details[key] || check) && !moneyValid(details[key]) ? '税込全体額を円単位・12桁以内で入力してください。' : undefined : required(details[key], check)} hint={key === 'previousId' ? '変更する直前の発行済み契約または変更契約のID' : key === 'newTotal' ? '参照する「変更後全体額の見積」の税込合計。増減差額ではありません。' : key === 'periodImpact' ? '着工・完成・引渡しへの影響。影響なしの場合も「なし」と明示' : undefined} />)}</div>
}

function EventDetailFields({ draft, check, onChange }: { draft: ContractEventDraft; check: boolean; onChange: (patch: Partial<ContractEventDraft>) => void }) {
  if (draft.type === 'delivered') return <div className="wc-grid"><Select label="交付の方向" value={draft.deliveryDirection} empty="方向を選択" options={[["outgoing", '当社から相手方へ'], ['incoming', '相手方から当社へ']]} onChange={deliveryDirection => onChange({ deliveryDirection })} error={required(draft.deliveryDirection, check)} /><Field label="送付者" value={draft.sender} max={150} onChange={sender => onChange({ sender })} error={required(draft.sender, check)} /><Field label="受取人" value={draft.recipient} max={150} onChange={recipient => onChange({ recipient })} error={required(draft.recipient, check)} /><Field label="交付・送付方法" value={draft.deliveryMethod} max={200} onChange={deliveryMethod => onChange({ deliveryMethod })} error={required(draft.deliveryMethod, check)} hint="手渡し・郵送・電子メール等。実際の方法を記録" /></div>
  if (draft.type === 'accepted') return <div className="wc-grid"><Field label="署名者名（手動記録）" value={draft.signerName} max={150} onChange={signerName => onChange({ signerName })} error={required(draft.signerName, check)} /><Field label="署名者の役職・立場" value={draft.signerRole} max={150} onChange={signerRole => onChange({ signerRole })} error={required(draft.signerRole, check)} /><Field label="権限を確認した方法・根拠" value={draft.authorityMethod} max={300} onChange={authorityMethod => onChange({ authorityMethod })} error={required(draft.authorityMethod, check)} hint="担当者による確認方法の記録です。本システムによる本人・権限の証明ではありません。" /></div>
  return null
}

function RecordActions({ record, disabled, onSave, onIssue, onDelete }: { record: Publication; disabled: boolean; onSave: () => void; onIssue: () => void; onDelete: () => void }) {
  const [confirm, setConfirm] = useState<'issue' | 'delete' | null>(null)
  if (record.status === 'issued') return null
  return <div className="wc-record-actions"><div className="wc-toolbar"><button type="button" disabled={disabled} onClick={onSave}><Save size={16} aria-hidden="true" />下書きを保存</button><button type="button" className="wc-primary" disabled={disabled} onClick={() => setConfirm('issue')}><Send size={16} aria-hidden="true" />発行する</button><button type="button" disabled={disabled} onClick={() => setConfirm('delete')}><Trash2 size={16} aria-hidden="true" />下書きを削除</button></div>{confirm && <div className="wc-confirm" role="group" aria-label={confirm === 'issue' ? '発行の確認' : '削除の確認'}><p>{confirm === 'issue' ? '保存して発行すると、この内容と工事情報が固定され、編集・削除できなくなります。内容を確認して発行してください。' : 'この下書きを削除して保存します。ほかの入力中の内容も一緒に保存されます。'}</p><button type="button" disabled={disabled} className="wc-primary" onClick={() => { setConfirm(null); if (confirm === 'issue') onIssue(); else onDelete() }}>{confirm === 'issue' ? '内容を固定して発行' : '削除して保存'}</button><button type="button" disabled={disabled} onClick={() => setConfirm(null)}>戻る</button></div>}</div>
}

function lineRows(record: Estimate | Invoice): [string, string][] {
  const totals = documentTotals(record)
  return [...record.items.map((item, index): [string, string] => [`明細 ${index + 1}・${CATEGORIES[item.category]}`, `${item.description}｜${item.quantity} ${item.unit} × ${yen(item.unitPrice)} = ${yen(lineTotal(item).toString())}`]), ['税抜小計', yen(totals.subtotal)], [`消費税 ${record.taxRate}%`, yen(totals.tax)], ['端数処理', { floor: '切捨て', round: '四捨五入', ceil: '切上げ' }[record.rounding]], ['合計', yen(totals.total)]]
}

function contractRows(current: Contract, linked: Estimate): [string, string][] {
  return [
    ['契約名', current.title], ['契約日', current.effectiveDate ?? ''],
    ['区分', current.kind === 'change' ? '変更契約' : '当初契約'],
    ['当社の立場', current.partyRole === 'receiving' ? '受注者' : '発注者'],
    ['発注者名', linked.recipient], ['発注者住所', linked.recipientAddress],
    ['受注者名', linked.issuer], ['受注者住所', linked.issuerAddress], ['相手方', current.counterparty],
    ['見積参照', `${linked.title}（${linked.id}）`], ['変更元契約ID', current.originalContractId ?? ''], ['変更理由', current.changeReason],
    ...lineRows(linked),
    ...(Object.entries(CONTRACT_TERM_LABELS) as [keyof Contract['terms'], string][]).map(([key, label]): [string, string] => [label, current.terms[key]]),
    ['発注者 記名押印欄', '氏名: ____________________  印: ____________________'],
    ['受注者 記名押印欄', '氏名: ____________________  印: ____________________'],
    ['書面の扱い', '社内発行の契約書案です。双方の交換・承諾は証拠を添えて別途記録してください。本人確認・電子署名・契約成立の自動判定は行いません。'],
  ]
}

function invoiceRows(current: Invoice): [string, string][] {
  return [
    ['請求番号', current.number], ['方向', current.direction === 'receivable' ? '売掛・入金' : '買掛・支払'],
    ['契約ID', current.contractId], ['宛先', current.recipient], ['発行者', current.issuer],
    ['発行日', current.issuedOn], ['契約で定めた期日', current.dueOn], ['振込先', current.bank],
    ...(current.registrationNumber.trim() ? [['登録番号', current.registrationNumber] as [string, string]] : []),
    ...lineRows(current),
    ...(current.notes.trim() ? [['備考', current.notes] as [string, string]] : []),
  ]
}

async function pdf(props: WorkflowSectionProps, title: string, record: Publication & { id: string }, rows: [string, string][]) {
  const basis = record.status === 'issued' ? record.basis?.job : props.job
  if (!basis) throw new Error('発行時の工事情報を取得できないためPDFを作成できません。')
  const footer = record.status === 'draft' ? '下書き・未発行' : `発行日時 ${record.issuedAt ?? '未取得'}｜工事版 ${basis.version}`
  const blob = await documentPdf(`${record.status === 'draft' ? '【下書き】' : ''}${title}`, basis, rows, footer)
  downloadDocument(blob, `${[...title].map(char => char.charCodeAt(0) < 32 || '<>:"/\\|?*'.includes(char) ? '_' : char).join('').slice(0, 90)}-${record.id}.pdf`)
}

const blankEstimate = (): Estimate => ({ ...draftPublication(), id: id(), title: '', recipient: '', recipientAddress: '', issuer: '', issuerAddress: '', issuedOn: '', validUntil: null, items: [], taxRate: '10', rounding: 'floor', notes: '' })
const blankContract = (estimateId = ''): Contract => ({ ...draftPublication(), id: id(), title: '', estimateId, kind: 'initial', originalContractId: null, changeReason: '', effectiveDate: null, partyRole: 'receiving', counterparty: '', terms: emptyTerms() })
const blankInvoice = (): Invoice => ({ ...draftPublication(), id: id(), number: '', direction: 'receivable', contractId: '', recipient: '', issuer: '', issuedOn: '', dueOn: '', bank: '', registrationNumber: '', items: [], taxRate: '10', rounding: 'floor', notes: '' })

const suggestedTitle = (name: string, suffix: string) => name.trim() ? `${[...name.trim()].slice(0, 200 - suffix.length).join('')}${suffix}` : ''
function assistEstimate(record: Estimate, props: WorkflowSectionProps): Estimate {
  return { ...record, title: record.title.trim() ? record.title : suggestedTitle(props.job.name, ' 御見積'), recipient: record.recipient.trim() ? record.recipient : props.job.customerName, issuer: record.issuer.trim() ? record.issuer : props.companyName, issuedOn: record.issuedOn || today() }
}
function assistContract(record: Contract, props: WorkflowSectionProps): Contract {
  const estimate = props.data.estimates.find(row => row.id === record.estimateId && row.status === 'issued')
  if (!estimate) return record
  return { ...record, title: record.title.trim() ? record.title : suggestedTitle(props.job.name, ' 契約案'), counterparty: record.counterparty.trim() ? record.counterparty : record.partyRole === 'receiving' ? estimate.recipient : estimate.issuer }
}
function assistInvoice(record: Invoice, props: WorkflowSectionProps): Invoice {
  const contract = props.data.contracts.find(row => row.id === record.contractId && row.status === 'issued')
  const estimate = props.data.estimates.find(row => row.id === contract?.estimateId && row.status === 'issued')
  if (!estimate) return record
  return { ...record, recipient: record.recipient.trim() ? record.recipient : estimate.recipient, issuer: record.issuer.trim() ? record.issuer : estimate.issuer }
}

function RecordLayout({ list, children }: { list: ReactNode; children: ReactNode }) {
  return <div className="wc-workspace"><div className="wc-record-list">{list}</div><div className="wc-editor">{children}</div></div>
}

export function EstimatesContractsSection(props: WorkflowSectionProps) {
  const actions = useActions(props)
  const operations = useOperationDrafts(props)
  const [tab, setTab] = useState<'estimates' | 'contracts'>('estimates')
  const [selection, setSelection] = useState('')
  const [checkedId, setCheckedId] = useState('')
  const records = props.data[tab]
  const selected = records.find(record => record.id === selection) ?? records[0]
  const recordId = selected?.id
  const estimate = tab === 'estimates' ? props.data.estimates.find(record => record.id === recordId) : undefined
  const contract = tab === 'contracts' ? props.data.contracts.find(record => record.id === recordId) : undefined
  const updateEstimate = (patch: Partial<Estimate>) => {
    const p = actions.latest.current
    if (actions.disabled) return
    p.onChange({ ...p.data, estimates: p.data.estimates.map(record => record.id === recordId && record.status === 'draft' ? { ...record, ...patch } : record) })
  }
  const updateContract = (patch: Partial<Contract>) => {
    const p = actions.latest.current
    if (actions.disabled) return
    p.onChange({ ...p.data, contracts: p.data.contracts.map(record => {
      if (record.id !== recordId || record.status !== 'draft') return record
      const next = { ...record, ...patch }
      return 'estimateId' in patch || 'partyRole' in patch ? assistContract(next, p) : next
    }) })
  }
  const addEstimate = (source?: Estimate) => {
    if (actions.disabled) return
    const p = actions.latest.current
    if (source) {
      const sourceId = source.id
      const current = p.data.estimates.find(record => record.id === sourceId && record.status === 'issued')
      if (!current) return
      source = current
    }
    if (p.data.estimates.length >= 200) { actions.setError('見積は200件までです。不要な下書きを削除してください。'); return }
    const fresh = assistEstimate(source ? { ...source, ...draftPublication(), id: id(), title: `${[...source.title].slice(0, 195).join('')}（改訂案）`, issuedOn: '', validUntil: null, items: source.items.map(item => ({ ...item, id: id() })) } : blankEstimate(), p)
    p.onChange({ ...p.data, estimates: [...p.data.estimates, fresh] }); setTab('estimates'); setSelection(fresh.id)
  }
  const addContract = (source?: Contract, sourceEstimateId?: string) => {
    if (actions.disabled) return
    const p = actions.latest.current
    if (source) {
      const sourceId = source.id
      const current = p.data.contracts.find(record => record.id === sourceId && record.status === 'issued')
      if (!current) return
      source = current
    }
    if (p.data.contracts.length >= 200) { actions.setError('契約は200件までです。不要な下書きを削除してください。'); return }
    const sourceEstimateIdForChange = source?.estimateId
    const fresh: Contract = source ? { ...source, ...draftPublication(), id: id(), title: `${[...source.title].slice(0, 195).join('')}（変更案）`, kind: 'change', originalContractId: source.originalContractId ?? source.id, changeReason: formatChange({ previousId: source.id, oldTotal: totalsOf(p.data.estimates.find(row => row.id === sourceEstimateIdForChange) ?? blankEstimate())?.total ?? '', newTotal: '', periodImpact: '', reason: '' }), effectiveDate: null, terms: { ...source.terms } } : blankContract(sourceEstimateId)
    p.onChange({ ...p.data, contracts: [...p.data.contracts, source ? fresh : assistContract(fresh, p)] }); setTab('contracts'); setSelection(fresh.id)
  }
  const persist = (mode: 'save' | 'issue' | 'delete') => void actions.run(async () => {
    const p = actions.latest.current
    const current = p.data[tab].find(record => record.id === recordId)
    if (!current || current.status !== 'draft') return
    if (mode === 'issue') {
      setCheckedId(current.id)
      const errors = tab === 'estimates' ? estimateErrors(current as Estimate) : contractErrors(current as Contract, p.data)
      if (errors.length) { actions.setError('未入力・入力エラーを確認してください。'); return }
    }
    const data: WorkflowData = tab === 'estimates'
      ? { ...p.data, estimates: p.data.estimates.flatMap(record => record.id !== recordId ? [record] : mode === 'delete' ? [] : [{ ...record, status: mode === 'issue' ? 'issued' as const : record.status }]) }
      : { ...p.data, contracts: p.data.contracts.flatMap(record => record.id !== recordId ? [record] : mode === 'delete' ? [] : [{ ...record, status: mode === 'issue' ? 'issued' as const : record.status }]) }
    await actions.save(data)
  })
  const exportEstimate = (record: Estimate) => void actions.run(async () => { const p = actions.latest.current; const current = p.data.estimates.find(row => row.id === record.id); if (!current) return; await pdf(p, '見積書', current, [['件名', current.title], ['宛先', current.recipient], ['宛先住所', current.recipientAddress], ['発行者', current.issuer], ['発行者住所', current.issuerAddress], ['発行日', current.issuedOn], ['有効期限', current.validUntil ?? ''], ...lineRows(current), ['備考', current.notes]]) }, false)
  const exportContract = (record: Contract) => void actions.run(async () => {
    const p = actions.latest.current; const current = p.data.contracts.find(row => row.id === record.id); if (!current) return
    const linked = p.data.estimates.find(row => row.id === current.estimateId)
    if (!linked || linked.status !== 'issued') throw new Error('参照する発行済み見積を選択してください。')
    await pdf(p, CONTRACT_PDF_TITLE, current, contractRows(current, linked))
  }, false)
  const check = checkedId === recordId
  return <section className="w-commercial" aria-label="見積・契約"><header className="wc-heading"><div><h2>見積・契約</h2><p>下書きから発行、契約書の交換記録まで。</p></div><button type="button" disabled={actions.disabled} onClick={() => tab === 'estimates' ? addEstimate() : addContract()}><Plus size={17} aria-hidden="true" />{tab === 'estimates' ? '見積を追加' : '契約を追加'}</button></header><div className="wc-tabs" role="group" aria-label="書類の種類"><button type="button" aria-pressed={tab === 'estimates'} onClick={() => setTab('estimates')}>見積 <span>{props.data.estimates.length}</span></button><button type="button" aria-pressed={tab === 'contracts'} onClick={() => setTab('contracts')}>契約 <span>{props.data.contracts.length}</span></button></div><Feedback actions={actions} /><RecordLayout list={records.length ? records.map(record => <button key={record.id} type="button" className="wc-record-button" aria-pressed={record.id === recordId} onClick={() => setSelection(record.id)}><strong>{record.title || '名称未入力'}</strong><span>{record.status === 'issued' ? '発行済み' : '下書き'}{'items' in record ? `・${totalText(record)}` : record.kind === 'change' ? '・変更契約' : '・当初契約'}</span></button>) : <p className="wc-muted">{tab === 'estimates' ? '見積' : '契約'}はまだありません。</p>}>
    {estimate && <article key={estimate.id} data-testid="estimate-editor"><div className="wc-subheading"><h3>{estimate.title || '新しい見積'}</h3><button type="button" title="見積書PDFをダウンロード" disabled={actions.pending} onClick={() => exportEstimate(estimate)}><Download size={16} aria-hidden="true" />PDF</button></div><PublicationInfo record={estimate} />{check && <Errors errors={estimateErrors(estimate)} />}<fieldset disabled={actions.disabled || estimate.status === 'issued'} className="wc-form"><legend className="wc-sr">見積の入力</legend><div className="wc-grid"><Field label="見積件名" value={estimate.title} onChange={title => updateEstimate({ title })} error={required(estimate.title, check)} /><Field label="見積発行日" value={estimate.issuedOn} type="date" onChange={issuedOn => updateEstimate({ issuedOn })} error={dateError(estimate.issuedOn, check)} /><Field label="宛先" value={estimate.recipient} onChange={recipient => updateEstimate({ recipient })} error={required(estimate.recipient, check)} /><Field label="宛先住所" value={estimate.recipientAddress} max={500} onChange={recipientAddress => updateEstimate({ recipientAddress })} error={required(estimate.recipientAddress, check)} /><Field label="発行者" value={estimate.issuer} onChange={issuer => updateEstimate({ issuer })} error={required(estimate.issuer, check)} /><Field label="発行者住所" value={estimate.issuerAddress} max={500} onChange={issuerAddress => updateEstimate({ issuerAddress })} error={required(estimate.issuerAddress, check)} /><Field label="見積有効期限（任意）" type="date" value={estimate.validUntil ?? ''} onChange={validUntil => updateEstimate({ validUntil: validUntil || null })} error={dateError(estimate.validUntil ?? '', false)} /></div><Items record={estimate} onChange={updateEstimate} check={check} /><details><summary>備考</summary><Field label="見積備考" value={estimate.notes} max={2000} multiline onChange={notes => updateEstimate({ notes })} /></details></fieldset><RecordActions record={estimate} disabled={actions.disabled} onSave={() => persist('save')} onIssue={() => persist('issue')} onDelete={() => persist('delete')} />{estimate.status === 'issued' && <div className="wc-toolbar"><button type="button" disabled={actions.disabled} onClick={() => addContract(undefined, estimate.id)}><FilePlus2 size={16} aria-hidden="true" />この見積から契約を作成</button><button type="button" disabled={actions.disabled} onClick={() => addEstimate(estimate)}><Plus size={16} aria-hidden="true" />改訂見積を作成</button></div>}</article>}
    {contract && <article key={contract.id} data-testid="contract-editor"><div className="wc-subheading"><h3>{contract.title || '新しい契約'}</h3><button type="button" disabled={actions.pending} title="契約書PDFをダウンロード" onClick={() => exportContract(contract)}><Download size={16} aria-hidden="true" />PDF</button></div><PublicationInfo record={contract} /><p className="wc-muted">社内発行は双方の交換・承諾や契約成立の確認とは別です。発行には工事条件の回答と最新の資料確認が必要です。画面上部の「1 確認記録」から前提と根拠資料を確認してください。条件未充足でも下書きPDFを作成できます。</p>{check && <Errors errors={contractErrors(contract, props.data)} />}<fieldset disabled={actions.disabled || contract.status === 'issued'} className="wc-form"><legend className="wc-sr">契約の入力</legend><div className="wc-grid"><Field label="契約名" value={contract.title} onChange={title => updateContract({ title })} error={required(contract.title, check)} /><Select label={contract.kind === 'change' ? '変更後全体額の発行済み見積' : '参照する発行済み見積'} value={contract.estimateId} empty="見積を選択" options={props.data.estimates.filter(record => record.status === 'issued').map(record => [record.id, `${record.title}・${totalText(record)}`])} onChange={estimateId => updateContract({ estimateId })} error={check && !contract.estimateId ? '発行済み見積を選択してください。' : undefined} /><Select label="当社の立場" value={contract.partyRole} options={[["receiving", '受注者'], ['ordering', '発注者']]} onChange={partyRole => updateContract({ partyRole })} /><Field label="契約相手方" value={contract.counterparty} onChange={counterparty => updateContract({ counterparty })} error={required(contract.counterparty, check)} /><Field label="契約日" type="date" value={contract.effectiveDate ?? ''} onChange={effectiveDate => updateContract({ effectiveDate: effectiveDate || null })} error={dateError(contract.effectiveDate ?? '', check)} /></div>{contract.kind === 'change' && <><p>変更元: {props.data.contracts.find(record => record.id === contract.originalContractId)?.title ?? contract.originalContractId}</p><ChangeReasonFields value={contract.changeReason} check={check} onChange={changeReason => updateContract({ changeReason })} /></>}<details open={check || undefined}><summary>契約条件（{Object.keys(CONTRACT_TERM_LABELS).length}項目）</summary><p className="wc-muted">18項目すべてに合意する内容を入力してください。含まない工事・施工しない日を含め、該当しない条件は「なし」と明示します。定型条文は自動入力しません。</p><div className="wc-grid">{(Object.keys(CONTRACT_TERM_LABELS) as (keyof Contract['terms'])[]).map(key => <Field key={key} label={CONTRACT_TERM_LABELS[key]} value={contract.terms[key]} type={['startDate', 'endDate', 'handoverDate'].includes(key) ? 'date' : 'text'} multiline={!['startDate', 'endDate', 'handoverDate'].includes(key)} max={2000} hint={TERM_HINTS[key]} error={['startDate', 'endDate', 'handoverDate'].includes(key) ? dateError(contract.terms[key], check) : required(contract.terms[key], check)} onChange={value => { const current = actions.latest.current.data.contracts.find(row => row.id === contract.id); if (current) updateContract({ terms: { ...current.terms, [key]: value } }) }} />)}</div></details></fieldset><RecordActions record={contract} disabled={actions.disabled} onSave={() => persist('save')} onIssue={() => persist('issue')} onDelete={() => persist('delete')} />{contract.status === 'issued' && <><button type="button" disabled={actions.disabled} onClick={() => addContract(contract)}><FilePlus2 size={16} aria-hidden="true" />この契約から変更契約を作成</button><ContractEvents key={contract.id} props={props} contractId={contract.id} actions={actions} store={operations} /></>}</article>}
    {!selected && <div className="wc-empty"><FilePlus2 size={28} aria-hidden="true" /><p>{tab === 'estimates' ? '見積を追加して内容を入力してください。' : '発行済み見積を選び、契約を作成してください。'}</p></div>}
  </RecordLayout></section>
}

const blankEvent = (contractId: string): ContractEventDraft => ({ id: id(), contractId, type: 'delivered', eventDate: '', counterparty: '', evidenceIds: [], note: '', deliveryDirection: '', sender: '', recipient: '', deliveryMethod: '', signerName: '', signerRole: '', authorityMethod: '' })

function ContractEvents({ props, contractId, actions, store }: { props: WorkflowSectionProps; contractId: string; actions: Actions; store: OperationStore }) {
  const key = `event:${contractId}`
  const draft = (store.values[key] as ContractEventDraft | undefined) ?? blankEvent(contractId)
  const [check, setCheck] = useState(false)
  const latest = useLatest(draft)
  const update = (patch: Partial<ContractEventDraft>) => store.set(key, { ...latest.current, ...patch })
  const append = () => void actions.run(async () => {
    const p = actions.latest.current; const event = latest.current
    if (p.data.contractEvents.length >= 200) throw new Error('交換記録の上限200件に達しています。')
    setCheck(true)
    if (!dateValid(event.eventDate) || event.eventDate > today() || !event.counterparty.trim() || !event.note.trim() || !event.evidenceIds.length) { actions.setError('交換記録の日付・相手方・証拠資料・記録内容を入力してください。'); return }
    if (event.type === 'delivered' && (!event.deliveryDirection || !event.sender.trim() || !event.recipient.trim() || !event.deliveryMethod.trim())) { actions.setError('交付の方向・送付者・受取人・方法を入力してください。'); return }
    if (event.type === 'accepted' && (!event.signerName.trim() || !event.signerRole.trim() || !event.authorityMethod.trim())) { actions.setError('署名者名・役職等・権限確認の方法を入力してください。'); return }
    const saved = savedEvent(event)
    if (saved.note.length > 2000) { actions.setError('交付・承諾の詳細と補足を合わせて2000文字以内にしてください。'); return }
    if (!p.data.contracts.some(record => record.id === contractId && record.status === 'issued')) throw new Error('発行済み契約を選択してください。')
    if (p.data.contractEvents.some(record => record.id === event.id)) { actions.setError('同じ記録は追加できません。保存結果を確認してください。'); return }
    if (await actions.save({ ...p.data, contractEvents: [...p.data.contractEvents, saved] })) { store.clear(key); setCheck(false) }
  })
  return <section className="wc-history" aria-label="契約交換記録"><h4>契約書の交換記録</h4><p className="wc-muted">担当者による手動の事実記録です。本人確認・電子署名・契約成立の自動判定を行うものではありません。保存後は変更・削除できません。</p><div>{props.data.contractEvents.filter(record => record.contractId === contractId).map(record => <article className="wc-log" key={record.id}><strong>{record.eventDate}｜{EVENT_LABELS[record.type]}</strong><p>相手方: {record.counterparty}</p><p>{record.note}</p><FileLinks ids={record.evidenceIds} props={props} /></article>)}</div>{!props.readOnly && <details><summary>交換記録を追加</summary><fieldset disabled={actions.disabled} className="wc-form"><legend className="wc-sr">交換記録の入力</legend><div className="wc-grid"><Select label="交換記録の種類" value={draft.type} options={Object.entries(EVENT_LABELS)} onChange={type => update({ type })} /><Field label="交換記録の日付" value={draft.eventDate} type="date" onChange={eventDate => update({ eventDate })} error={dateError(draft.eventDate, check)} /><Field label="交換の相手方" value={draft.counterparty} onChange={counterparty => update({ counterparty })} error={required(draft.counterparty, check)} /></div><EventDetailFields draft={draft} check={check} onChange={update} /><Field label="交換記録の内容・確認方法" value={draft.note} max={1000} multiline onChange={note => update({ note })} error={required(draft.note, check)} /><Evidence actions={actions} props={props} value={draft.evidenceIds} onChange={evidenceIds => update({ evidenceIds })} disabled={actions.disabled} />{check && !draft.evidenceIds.length && <p className="wc-invalid">証拠資料を選択してください。</p>}<div className="wc-toolbar"><button type="button" onClick={append} disabled={actions.disabled}><Save size={16} aria-hidden="true" />交換記録を保存（追記）</button>{store.values[key] && <button type="button" disabled={actions.disabled} onClick={() => store.discard(key)}>入力を破棄</button>}</div></fieldset></details>}</section>
}

function invoiceBalance(data: WorkflowData, record: Invoice) {
  const totals = totalsOf(record)
  if (!totals) return null
  try { const paid = invoicePaid(data, record.id); return { paid, outstanding: (BigInt(totals.total) - BigInt(paid)).toString() } } catch { return null }
}

export function BillingSection(props: WorkflowSectionProps) {
  const actions = useActions(props)
  const operations = useOperationDrafts(props)
  const [tab, setTab] = useState<'invoices' | 'milestones'>('invoices')
  const [selection, setSelection] = useState('')
  const [direction, setDirection] = useState('all')
  const [status, setStatus] = useState('all')
  const [checkedId, setCheckedId] = useState('')
  const invoices = props.data.invoices.filter(record => {
    const balance = invoiceBalance(props.data, record)
    return (direction === 'all' || record.direction === direction) && (status === 'all' || (status === 'draft' && record.status === 'draft') || (record.status === 'issued' && balance && (status === 'paid' ? BigInt(balance.outstanding) === 0n : status === 'unpaid' ? BigInt(balance.outstanding) > 0n : status === 'overdue' && BigInt(balance.outstanding) > 0n && !!record.dueOn && record.dueOn < today())))
  })
  const invoice = invoices.find(record => record.id === selection) ?? invoices[0]
  const balance = invoice ? invoiceBalance(props.data, invoice) : null
  const check = checkedId === invoice?.id
  const update = (patch: Partial<Invoice>) => {
    if (actions.disabled) return
    const p = actions.latest.current
    p.onChange({ ...p.data, invoices: p.data.invoices.map(record => {
      if (record.id !== invoice?.id || record.status !== 'draft') return record
      const next = { ...record, ...patch }
      return 'contractId' in patch ? assistInvoice(next, p) : next
    }) })
  }
  const add = () => {
    if (actions.disabled) return
    const fresh = blankInvoice(); const p = actions.latest.current
    if (p.data.invoices.length >= 200) { actions.setError('請求は200件までです。不要な下書きを削除してください。'); return }
    p.onChange({ ...p.data, invoices: [...p.data.invoices, fresh] }); setSelection(fresh.id); setDirection('all'); setStatus('all'); setTab('invoices')
  }
  const copy = () => {
    if (!invoice || actions.disabled) return
    const p = actions.latest.current
    const current = p.data.invoices.find(record => record.id === invoice.id)
    if (!current || current.status !== 'draft') return
    const contract = p.data.contracts.find(record => record.id === current.contractId && record.status === 'issued')
    const estimate = p.data.estimates.find(record => record.id === contract?.estimateId && record.status === 'issued')
    if (!estimate) { actions.setError('発行済み見積を参照する契約を選択してください。'); return }
    if (current.items.length && !window.confirm('現在の請求明細を、参照見積の明細で置き換えます。')) return
    update({ items: estimate.items.map(item => ({ ...item, id: id() })), taxRate: estimate.taxRate, rounding: estimate.rounding })
  }
  const persist = (mode: 'save' | 'issue' | 'delete') => void actions.run(async () => {
    const p = actions.latest.current; const current = p.data.invoices.find(record => record.id === invoice?.id)
    if (!current || current.status !== 'draft') return
    if (mode === 'issue') { setCheckedId(current.id); if (invoiceErrors(current, p.data).length) { actions.setError('未入力・入力エラーを確認してください。'); return } }
    await actions.save({ ...p.data, invoices: p.data.invoices.flatMap(record => record.id !== current.id ? [record] : mode === 'delete' ? [] : [{ ...record, status: mode === 'issue' ? 'issued' as const : record.status }]) })
  })
  const exportInvoice = () => void actions.run(async () => {
    const p = actions.latest.current; const current = p.data.invoices.find(record => record.id === invoice?.id); if (!current) return
    await pdf(p, current.direction === 'receivable' ? '請求書' : '支払請求書控え', current, invoiceRows(current))
  }, false)
  const summary = (kind: Invoice['direction']) => props.data.invoices.filter(record => record.direction === kind && record.status === 'issued').reduce((sum, record) => { const b = invoiceBalance(props.data, record); return b ? sum + BigInt(b.outstanding) : sum }, 0n).toString()
  return <section className="w-billing" aria-label="請求・入出金"><header className="wc-heading"><div><h2>請求・入出金</h2><p>契約に紐づく請求と実績を記録します。</p></div>{tab === 'invoices' && <button type="button" disabled={actions.disabled} onClick={add}><Plus size={17} aria-hidden="true" />請求を追加</button>}</header><dl className="wc-summary"><div><dt>未収残高（発行済み）</dt><dd>{yen(summary('receivable'))}</dd></div><div><dt>未払残高（発行済み）</dt><dd>{yen(summary('payable'))}</dd></div></dl><div className="wc-tabs" role="group" aria-label="請求と工事実績"><button type="button" aria-pressed={tab === 'invoices'} onClick={() => setTab('invoices')}>請求・入出金</button><button type="button" aria-pressed={tab === 'milestones'} onClick={() => setTab('milestones')}>完成・引渡し等</button></div><p className="wc-muted">法定期限の根拠・適用条件は未確認です。ここでは入力した「契約で定めた期日」と実績を管理します。</p><Feedback actions={actions} />{tab === 'milestones' ? <Milestones props={props} actions={actions} store={operations} /> : <><div className="wc-filters"><Select label="請求の方向" value={direction} options={[["all", 'すべて'], ['receivable', '売掛・入金'], ['payable', '買掛・支払']]} onChange={setDirection} /><Select label="請求の状態" value={status} options={[["all", 'すべて'], ['draft', '下書き'], ['unpaid', '残高あり'], ['paid', '精算済み'], ['overdue', '契約期日超過']]} onChange={setStatus} /></div><RecordLayout list={invoices.length ? invoices.map(record => { const b = invoiceBalance(props.data, record); return <button key={record.id} type="button" className="wc-record-button" aria-pressed={invoice?.id === record.id} onClick={() => setSelection(record.id)}><strong>{record.number || '請求番号未入力'}</strong><span>{record.direction === 'receivable' ? '売掛' : '買掛'}・{record.status === 'issued' ? '発行済み' : '下書き'}・{totalText(record)}</span>{record.status === 'issued' && b && <span>残高 {yen(b.outstanding)}{BigInt(b.outstanding) > 0n && record.dueOn && record.dueOn < today() ? '・契約期日超過' : ''}</span>}</button> }) : <p className="wc-muted">該当する請求はありません。</p>}>
    {invoice ? <article key={invoice.id} data-testid="invoice-editor"><div className="wc-subheading"><h3>{invoice.number || '新しい請求'}</h3><button type="button" title="請求書PDFをダウンロード" disabled={actions.pending} onClick={exportInvoice}><Download size={16} aria-hidden="true" />PDF</button></div><PublicationInfo record={invoice} />{check && <Errors errors={invoiceErrors(invoice, props.data)} />}<fieldset disabled={actions.disabled || invoice.status === 'issued'} className="wc-form"><legend className="wc-sr">請求の入力</legend><div className="wc-grid"><Field label="請求番号" value={invoice.number} max={100} onChange={number => update({ number })} error={required(invoice.number, check)} /><Select label="売掛・買掛" value={invoice.direction} options={[["receivable", '売掛（入金を記録）'], ['payable', '買掛（支払を記録）']]} onChange={direction => update({ direction })} /><Select label="対象の発行済み契約" value={invoice.contractId} empty="契約を選択" options={props.data.contracts.filter(record => record.status === 'issued').map(record => [record.id, record.title])} onChange={contractId => update({ contractId })} error={check && !invoice.contractId ? '契約を選択してください。' : undefined} /><Field label="請求宛先" value={invoice.recipient} onChange={recipient => update({ recipient })} error={required(invoice.recipient, check)} /><Field label="請求発行者" value={invoice.issuer} onChange={issuer => update({ issuer })} error={required(invoice.issuer, check)} /><Field label="請求発行日" value={invoice.issuedOn} type="date" onChange={issuedOn => update({ issuedOn })} error={dateError(invoice.issuedOn, check)} /><Field label="契約で定めた期日" value={invoice.dueOn} type="date" onChange={dueOn => update({ dueOn })} error={dateError(invoice.dueOn, check)} /><Field label="登録番号（任意）" value={invoice.registrationNumber} max={14} onChange={registrationNumber => update({ registrationNumber })} error={invoice.registrationNumber && !/^T\d{13}$/.test(invoice.registrationNumber) ? 'Tと半角数字13桁で入力してください。' : undefined} /></div><details><summary>振込先・備考</summary><Field label="振込先・支払方法の記載" value={invoice.bank} max={1000} multiline onChange={bank => update({ bank })} error={required(invoice.bank, check)} /><Field label="請求備考" value={invoice.notes} max={2000} multiline onChange={notes => update({ notes })} /></details><button type="button" disabled={!invoice.contractId} onClick={copy} title="対象契約が参照する発行済み見積の明細・税設定をコピー"><FilePlus2 size={16} aria-hidden="true" />契約の見積から明細をコピー</button><Items record={invoice} onChange={update} check={check} /></fieldset><RecordActions record={invoice} disabled={actions.disabled} onSave={() => persist('save')} onIssue={() => persist('issue')} onDelete={() => persist('delete')} />{invoice.status === 'issued' && <><dl className="wc-totals"><div><dt>{invoice.direction === 'receivable' ? '入金済み' : '支払済み'}</dt><dd>{balance ? yen(balance.paid) : '金額を確認'}</dd></div><div><dt>{invoice.direction === 'receivable' ? '未収残高' : '未払残高'}</dt><dd>{balance ? yen(balance.outstanding) : '金額を確認'}</dd></div><div><dt>契約で定めた期日</dt><dd>{invoice.dueOn || '未入力'}{balance && BigInt(balance.outstanding) > 0n && invoice.dueOn && invoice.dueOn < today() ? '（超過）' : ''}</dd></div></dl><Payments key={invoice.id} props={props} invoiceId={invoice.id} actions={actions} store={operations} /></>}</article> : <div className="wc-empty"><p>請求を追加するか、絞り込み条件を変更してください。</p></div>}
    </RecordLayout></>}</section>
}

const blankPayment = (invoiceId: string): PaymentRecord => ({ id: id(), invoiceId, type: 'payment', reversesId: null, paidOn: '', amountYen: '', method: '', reference: '', evidenceIds: [], note: '' })

function Payments({ props, invoiceId, actions, store }: { props: WorkflowSectionProps; invoiceId: string; actions: Actions; store: OperationStore }) {
  const key = `payment:${invoiceId}`
  const draft = (store.values[key] as PaymentRecord | undefined) ?? blankPayment(invoiceId)
  const [check, setCheck] = useState(false)
  const latest = useLatest(draft)
  const update = (patch: Partial<PaymentRecord>) => store.set(key, { ...latest.current, ...patch })
  const records = props.data.payments.filter(record => record.invoiceId === invoiceId)
  const original = props.data.payments.find(record => record.id === draft.reversesId)
  const append = () => void actions.run(async () => {
    const p = actions.latest.current; const record = latest.current
    if (p.data.payments.length >= 200) throw new Error('入出金記録の上限200件に達しています。')
    setCheck(true)
    if (!dateValid(record.paidOn) || record.paidOn > today() || !moneyValid(record.amountYen) || BigInt(record.amountYen) <= 0n || !record.method.trim() || !record.evidenceIds.length) { actions.setError('実績日・正の金額・方法・証拠資料（必須）を入力してください。'); return }
    if (record.type === 'payment' && /予定|手形|相殺/.test(record.method)) { actions.setError('実行済みの振込・現金を記録してください。予定・手形・相殺は対象外です。'); return }
    const invoice = p.data.invoices.find(row => row.id === invoiceId && row.status === 'issued')
    if (!invoice) throw new Error('発行済み請求を選択してください。')
    if (p.data.payments.some(row => row.id === record.id)) { actions.setError('同じ実績は追加できません。保存結果を確認してください。'); return }
    if (record.type === 'reversal') {
      const source = p.data.payments.find(row => row.id === record.reversesId && row.type === 'payment' && row.invoiceId === invoiceId)
      if (!source || source.amountYen !== record.amountYen || record.paidOn < source.paidOn || !record.evidenceIds.length || p.data.payments.some(row => row.type === 'reversal' && row.reversesId === source.id) || !record.note.trim()) { actions.setError('取消元・元実績以降の取消日・同額の取消金額・取消理由・証拠資料を確認してください。重複取消はできません。'); return }
    } else {
      const b = invoiceBalance(p.data, invoice)
      if (!b || BigInt(record.amountYen) > BigInt(b.outstanding)) { actions.setError('金額が残高を超えています。取消が必要な場合は先に取消記録を保存してください。'); return }
    }
    if (await actions.save({ ...p.data, payments: [...p.data.payments, record] })) { store.clear(key); setCheck(false) }
  })
  const reverse = (record: PaymentRecord) => {
    if (actions.disabled) return
    if (store.values[key] && !window.confirm('入力中の実績を破棄して、この実績の取消を入力します。')) return
    store.set(key, { ...blankPayment(invoiceId), type: 'reversal', reversesId: record.id, amountYen: record.amountYen, method: record.method }); setCheck(false)
  }
  return <section className="wc-history" aria-label="入出金実績"><h4>入出金実績</h4><p className="wc-muted">保存後は変更・削除できません。誤記は元の実績を同額で取り消してから、正しい実績を追加してください。銀行送金は行いません。</p>{!records.length && <p className="wc-muted">実績はまだありません。</p>}{records.map(record => <article className="wc-log" key={record.id}><strong>{record.paidOn}｜{record.type === 'reversal' ? '取消 −' : ''}{yen(record.amountYen)}</strong><p>方法: {record.method}｜照合番号: {record.reference || '—'}</p>{record.reversesId && <p>取消元ID: {record.reversesId}</p>}<p>{record.note}</p><FileLinks ids={record.evidenceIds} props={props} />{record.type === 'payment' && !records.some(row => row.type === 'reversal' && row.reversesId === record.id) && <button type="button" disabled={actions.disabled} onClick={() => reverse(record)}><Undo2 size={15} aria-hidden="true" />この実績の取消記録を入力</button>}</article>)}{!props.readOnly && <div className="wc-append"><h4>{draft.type === 'reversal' ? '取消記録を追加' : '入出金実績を追加'}</h4>{draft.type === 'reversal' && <p>取消元: {original?.paidOn}・{original ? yen(original.amountYen) : draft.reversesId}（元記録と同額）</p>}<fieldset disabled={actions.disabled} className="wc-form"><legend className="wc-sr">入出金実績の入力</legend><div className="wc-grid"><Field label={draft.type === 'reversal' ? '取消日' : '入出金日'} value={draft.paidOn} type="date" onChange={paidOn => update({ paidOn })} error={dateError(draft.paidOn, check)} /><div><fieldset disabled={draft.type === 'reversal'}><legend className="wc-sr">実績金額</legend><Field label="実績金額（円）" value={draft.amountYen} max={12} onChange={amountYen => update({ amountYen })} error={(check || draft.amountYen !== '') && (!moneyValid(draft.amountYen) || BigInt(draft.amountYen || '0') <= 0n) ? '正の整数・12桁以内で入力してください。' : undefined} /></fieldset></div><Field label="方法" value={draft.method} max={100} onChange={method => update({ method })} error={required(draft.method, check)} hint="実行済みの振込・現金。予定・手形・相殺は対象外です。" /><Field label="照合番号・参照（任意）" value={draft.reference} max={200} onChange={reference => update({ reference })} /></div><Field label={draft.type === 'reversal' ? '取消理由（必須）' : '実績の備考'} value={draft.note} max={2000} multiline onChange={note => update({ note })} error={required(draft.note, check && draft.type === 'reversal')} /><p className="wc-muted">証拠資料（必須）: 実行済み振込の控えや領収書を追加するか、既存資料から選択してください。</p><Evidence actions={actions} props={props} value={draft.evidenceIds} onChange={evidenceIds => update({ evidenceIds })} disabled={actions.disabled} />{check && !draft.evidenceIds.length && <p className="wc-invalid" role="alert">証拠資料を1件以上選択してください。</p>}<div className="wc-toolbar"><button type="button" disabled={actions.disabled} onClick={append}><Save size={16} aria-hidden="true" />{draft.type === 'reversal' ? '取消記録を保存（追記）' : '実績を保存（追記）'}</button>{store.values[key] && <button type="button" disabled={actions.disabled} onClick={() => { store.discard(key); setCheck(false) }}>入力を破棄</button>}</div></fieldset></div>}</section>
}

const blankMilestone = (): Milestone => ({ id: id(), contractId: '', type: 'completion_notice', eventDate: '', amountYen: null, evidenceIds: [], note: '' })

function Milestones({ props, actions, store }: { props: WorkflowSectionProps; actions: Actions; store: OperationStore }) {
  const key = 'milestone'
  const draft = (store.values[key] as Milestone | undefined) ?? blankMilestone()
  const [check, setCheck] = useState(false)
  const [contractFilter, setContractFilter] = useState('')
  const latest = useLatest(draft)
  const update = (patch: Partial<Milestone>) => store.set(key, { ...latest.current, ...patch })
  const contracts = props.data.contracts.filter(record => record.status === 'issued').map(record => [record.id, record.title] as const)
  const append = () => void actions.run(async () => {
    const p = actions.latest.current; const record = latest.current
    if (p.data.milestones.length >= 200) throw new Error('工事実績の上限200件に達しています。')
    setCheck(true)
    if (!dateValid(record.eventDate) || record.eventDate > today() || !record.note.trim() || !record.evidenceIds.length || !p.data.contracts.some(row => row.id === record.contractId && row.status === 'issued') || (record.amountYen !== null && !moneyValid(record.amountYen))) { actions.setError('契約・過去または今日の実績日・金額・備考・証拠資料を確認してください。'); return }
    if (p.data.milestones.some(row => row.id === record.id)) { actions.setError('同じ記録は追加できません。保存結果を確認してください。'); return }
    if (await actions.save({ ...p.data, milestones: [...p.data.milestones, record] })) { store.clear(key); setCheck(false) }
  })
  return <section className="wc-history" aria-label="完成・引渡し等の記録"><h3>完成・引渡し等の記録</h3><p className="wc-muted">通知・検査・引渡し等の実際の日付と証拠を記録します。保存後は変更・削除できません。法定期限の自動判定は行いません。</p><Select label="実績一覧の対象契約" value={contractFilter} empty="すべての契約" options={contracts} onChange={setContractFilter} />{props.data.milestones.filter(record => !contractFilter || record.contractId === contractFilter).map(record => <article className="wc-log" key={record.id}><strong>{record.eventDate}｜{MILESTONE_LABELS[record.type]}</strong><p>契約: {props.data.contracts.find(row => row.id === record.contractId)?.title ?? record.contractId}</p>{record.amountYen !== null && <p>金額: {yen(record.amountYen)}</p>}<p>{record.note}</p><FileLinks ids={record.evidenceIds} props={props} /></article>)}{!props.data.milestones.length && <p className="wc-muted">記録はまだありません。</p>}{!props.readOnly && <details><summary>実績記録を追加</summary><fieldset disabled={actions.disabled} className="wc-form"><legend className="wc-sr">完成・引渡し等の入力</legend><div className="wc-grid"><Select label="実績の対象契約" value={draft.contractId} empty="発行済み契約を選択" options={contracts} onChange={contractId => update({ contractId })} error={check && !draft.contractId ? '契約を選択してください。' : undefined} /><Select label="工事実績の種類" value={draft.type} options={Object.entries(MILESTONE_LABELS)} onChange={type => update({ type })} /><Field label="工事実績の日付" type="date" value={draft.eventDate} onChange={eventDate => update({ eventDate })} error={dateError(draft.eventDate, check)} /><Field label="関連金額（円・任意）" value={draft.amountYen ?? ''} max={12} onChange={amountYen => update({ amountYen: amountYen || null })} error={draft.amountYen !== null && !moneyValid(draft.amountYen) ? '円単位・12桁以内の半角数字' : undefined} /></div><Field label="工事実績の備考" value={draft.note} max={2000} multiline onChange={note => update({ note })} error={required(draft.note, check)} /><Evidence actions={actions} props={props} value={draft.evidenceIds} onChange={evidenceIds => update({ evidenceIds })} disabled={actions.disabled} /><div className="wc-toolbar"><button type="button" disabled={actions.disabled} onClick={append}><Save size={16} aria-hidden="true" />実績記録を保存（追記）</button>{store.values[key] && <button type="button" disabled={actions.disabled} onClick={() => store.discard(key)}>入力を破棄</button>}</div></fieldset></details>}</section>
}
