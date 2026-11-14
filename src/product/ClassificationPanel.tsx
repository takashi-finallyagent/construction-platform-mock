import { createContext, useContext, useEffect, useId, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { AlertCircle, ArrowLeft, ArrowRight, Check, ChevronDown, History, LoaderCircle, Plus, RefreshCw, Save, Search, Trash2, X } from 'lucide-react'
import { ApiError, errorMessage } from './api'
import type { Company } from './api'
import { classificationApi, JOB_LABELS, validClassificationData } from './classification-api'
import { CLASSIFICATION_SOURCES } from './classification-sources'
import { CATALOG_VERSION, emptyClassification, TRADE_CATALOG } from './classification-model'
import type { Answer, ClassificationAuditEvent, ClassificationData, ClassificationView, Issue, JobBasis, Money, TradeCode, WorkItem } from './classification-model'
import { classificationInputTargets, classificationIssueTarget, dependentAnswerMode, deriveClassificationFlow, isNo } from './classification-flow'
import type { ClassificationTarget } from './classification-flow'

const STEPS = ['工事条件', '施工範囲', '金額と許可', '関連条件']
const STATES = { unanswered: '未入力', unknown: '未確認', known: '内容を入力', not_applicable: '対象外' }
const YES_NO = [['yes', 'あり'], ['no', 'なし']] as const
const CONTEXT = {
  market: { label: '工事の区分', options: [['private', '民間工事'], ['public', '公共工事']] },
  companyRole: { label: '当社の立場', options: [['prime_contractor', '元請'], ['subcontractor', '下請'], ['owner', '発注者'], ['other', 'その他']] },
  workKind: { label: '工事の目的', options: [['repair', '修繕'], ['renovation', '改修'], ['demolition', '解体'], ['new_build', '新築'], ['other', 'その他']] },
  targetKind: { label: '施工対象', options: [['building', '建築物'], ['structure', '工作物'], ['other', 'その他']] },
} as const
const CONDITION_LABELS = { electricalWork: '電気工事を含む', existingStructureWork: '既存の建物・工作物に手を加える', demolitionWork: '解体・撤去を含む', specifiedMaterials: '特定建設資材を扱う', constructionWaste: '建設廃棄物が発生する', structuralChange: '構造を変更する' }
const AMOUNT_LABELS = { contract: '当社が受ける今回の請負額', suppliedMaterials: '発注者からの材料支給', suppliedMaterialValue: '支給材料の価額', suppliedMaterialTransport: '支給材料の運送費', splitContracts: '関連する分割契約', relatedContractValue: '関連する分割契約額（今回分を除く）', splitReason: '契約を分けた理由', subcontracting: '当社からの下請発注', subcontractTotal: '当社が発注する下請契約額の合計' }
const RELATIONSHIPS = [['primary', '主たる工事として申告'], ['ancillary', '附帯工事の候補として申告'], ['independent', '独立した工事として申告']] as const
const PERMITS = [['held', '保有していると申告'], ['not_held', '保有していないと申告'], ['renewal_pending', '更新手続中と申告']] as const
const PERMIT_TRADE_LABEL = '許可の対象と考える工事'
const TAXES = [['tax_included', '税込'], ['tax_excluded', '税抜'], ['unknown', '税区分不明']] as const
const blank = <T,>(): Answer<T> => ({ state: 'unanswered', value: null, reason: null })
const known = <T,>(value: T): Answer<T> => ({ state: 'known', value, reason: null })
const labelOf = (options: readonly (readonly [string, string])[], value: unknown) => options.find(([key]) => key === value)?.[1] ?? '選択内容を確認してください'
const displayDate = (value: string) => new Date(value).toLocaleString('ja-JP')
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
const limit = (value: string, max: number) => [...value.trim()].length <= max ? value : [...value.trim()].slice(0, max).join('')
const FieldErrors = createContext<Record<string, string>>({})
type InputError = { step: number; label: string; message: string }
function inputErrors(data: ClassificationData): InputError[] {
  const errors: InputError[] = []
  const add = (step: number, label: string, message: string) => errors.push({ step, label, message })
  const primary = data.workItems.filter(i => i.relationship.state === 'known' && i.relationship.value === 'primary')
  data.workItems.forEach((item, index) => {
    const name = `施工範囲 ${index + 1}`
    if (!item.description.trim()) add(1, `${name}の施工内容`, '施工内容を入力してください。不要な施工範囲は削除できます。')
    if (item.tradeCandidates.state === 'known' && !item.tradeCandidates.value.length) add(1, `${name}の候補業種`, '候補を検索して追加するか、「後で確認する」を選んでください。')
    if (item.relationship.state === 'known' && item.relationship.value === 'primary' && primary.length > 1) add(1, `${name}の関係`, '主たる工事は1件だけにしてください。判断できない場合は「後で確認する」を選べます。')
    if (item.relationship.state === 'known' && item.relationship.value === 'ancillary' && !data.workItems.some(p => p.id === item.parentItemId && p.id !== item.id && p.relationship.state === 'known' && ['primary', 'independent'].includes(p.relationship.value))) add(1, `${name}の附帯先`, '附帯先の工事を選んでください。先に別の範囲を主たる工事か独立した工事として入力します。判断できない場合は関係を「後で確認する」にしてください。')
  })
  for (const key of Object.keys(AMOUNT_LABELS) as (keyof typeof AMOUNT_LABELS)[]) {
    const a = data.amounts[key]
    if (a.state === 'not_applicable' && !a.reason.trim()) add(2, AMOUNT_LABELS[key], '対象外とした理由を入力してください。')
    if (a.state === 'known' && typeof a.value === 'object' && !/^(0|[1-9][0-9]{0,11})$/.test(a.value.yen)) add(2, AMOUNT_LABELS[key], '円単位の半角数字を12桁以内で入力してください。カンマ・小数・先頭の余分な0は使えません。')
    if (key === 'splitReason' && a.state === 'known' && typeof a.value === 'string' && !a.value.trim()) add(2, AMOUNT_LABELS[key], '分けた理由を入力するか、「後で確認する」を選んでください。')
  }
  for (const [parent, children] of [['suppliedMaterials', ['suppliedMaterialValue', 'suppliedMaterialTransport']], ['splitContracts', ['relatedContractValue', 'splitReason']], ['subcontracting', ['subcontractTotal']]] as const) {
    const a = data.amounts[parent]; const no = a.state === 'known' && a.value === 'no'
    for (const child of children) {
      const state = data.amounts[child].state
      if (no && state === 'known') add(2, AMOUNT_LABELS[child], `「${AMOUNT_LABELS[parent]}」が「なし」です。親の回答を訂正するか、この項目の回答を取り消してください。`)
      if (!no && state === 'not_applicable') add(2, AMOUNT_LABELS[child], `「${AMOUNT_LABELS[parent]}」が「なし」の場合だけ対象外にできます。回答状態を見直してください。`)
    }
  }
  if (data.permit.reportedTrades.state === 'known' && !data.permit.reportedTrades.value.length) add(2, PERMIT_TRADE_LABEL, '工事種類の候補を追加するか、「後で確認する」を選んでください。')
  if (data.permit.declaration.state === 'known' && data.permit.declaration.value === 'not_held' && data.permit.reportedTrades.state === 'known') add(2, PERMIT_TRADE_LABEL, '許可を保有していない申告と工事種類の申告が混在しています。保有申告を訂正するか、工事種類の回答を取り消してください。')
  return errors
}

function Notice({ children }: { children: ReactNode }) { return <div className="p-alert" role="alert"><AlertCircle size={18} aria-hidden="true" /><div>{children}</div></div> }
function AnswerField<T>({ label, answer, onChange, initial, allowNA = false, children }: { label: string; answer: Answer<T>; onChange: (answer: Answer<T>) => void; initial: () => T; allowNA?: boolean; children: (value: T, change: (v: T) => void) => ReactNode }) {
  const id = useId()
  const error = useContext(FieldErrors)[label]
  return <div className="c-answer" data-classification-field={label} aria-labelledby={id} tabIndex={-1}><span className="c-field-label" id={id}>{label}</span>
    {(answer.state === 'known' || answer.state === 'unanswered') && <div className="c-answer-value">{children(answer.state === 'known' ? answer.value : initial(), v => onChange(known(v)))}</div>}
    {answer.state === 'unknown' ? <div className="c-defer"><span>未確認</span><button type="button" className="p-text-button" aria-label={`${label}の入力を再開する`} onClick={() => onChange(blank())}>入力する</button></div> : answer.state !== 'not_applicable' && <button type="button" className="p-text-button c-defer-button" aria-label={`${label}を後で確認する`} onClick={() => { if (answer.state !== 'known' || window.confirm('入力した回答を取り消し、未確認に変更しますか？')) onChange({ state: 'unknown', value: null, reason: null }) }}>後で確認する</button>}
    {answer.state === 'not_applicable' && <><label className="p-field"><span>対象外の理由</span><input aria-invalid={!!error} aria-describedby={error ? `${id}-error` : undefined} aria-label={`${label}の対象外の理由`} value={answer.reason} onChange={e => onChange({ state: 'not_applicable', value: null, reason: limit(e.target.value, 300) })} /></label>{!allowNA && <p className="p-field-error">親項目が「なし」の場合だけ対象外にできます。回答状態を見直してください。</p>}</>}
    {(answer.state === 'not_applicable' || answer.state === 'known') && <button type="button" className="p-text-button" aria-label={`${label}の回答を取り消す`} onClick={() => { if (window.confirm('この回答と対象外の理由を取り消しますか？')) onChange(blank()) }}>回答を取り消す</button>}
    {error && <p className="p-field-error" id={`${id}-error`}>{error}</p>}
  </div>
}
function SelectAnswer<T extends string>({ label, answer, onChange, options }: { label: string; answer: Answer<T>; onChange: (a: Answer<T>) => void; options: readonly (readonly [T, string])[] }) {
  const id = useId()
  const error = useContext(FieldErrors)[label]
  return <div className="c-answer" data-classification-field={label} tabIndex={-1}><label htmlFor={id}>{label}</label><select id={id} aria-invalid={!!error} aria-describedby={error ? `${id}-error` : undefined} value={answer.state === 'known' ? answer.value : answer.state} onChange={e => onChange(e.target.value === 'unknown' ? { state: 'unknown', value: null, reason: null } : known(e.target.value as T))}><option value="unanswered" disabled>選択してください</option><option value="unknown">{answer.state === 'unknown' ? '未確認' : '後で確認する'}</option>{options.map(([key, text]) => <option value={key} key={key}>{text}</option>)}</select>{error && <p className="p-field-error" id={`${id}-error`}>{error}</p>}</div>
}
function MoneyAnswer({ label, answer, onChange, allowNA }: { label: string; answer: Answer<Money>; onChange: (a: Answer<Money>) => void; allowNA?: boolean }) {
  const error = useContext(FieldErrors)[label]
  return <AnswerField<Money> label={label} answer={answer} onChange={onChange} initial={() => ({ yen: '', taxBasis: 'tax_included' })} allowNA={allowNA}>{(value, change) => <div className="c-money"><label><span>{value.taxBasis === 'tax_included' ? '金額（税込・円）' : value.taxBasis === 'tax_excluded' ? '金額（税抜・円）' : '金額（税区分未確認・円）'}</span><input aria-invalid={!!error} aria-label={`${label}の金額`} type="text" inputMode="numeric" maxLength={12} value={value.yen} onChange={e => { const yen = e.target.value; if (!yen && answer.state === 'unanswered') return; change({ ...value, yen }) }} /></label><details className="c-tax-options" open={value.taxBasis === 'unknown' || undefined}><summary>税の扱いを変更</summary><label><span>税区分</span><select aria-label={`${label}の税区分`} value={value.taxBasis} onChange={e => change({ ...value, taxBasis: e.target.value as Money['taxBasis'] })}>{TAXES.map(([key, text]) => <option key={key} value={key}>{text}</option>)}</select></label><p className="p-muted p-small">金額は自動換算しません。</p></details></div>}</AnswerField>
}
function TradeAnswer({ label, answer, onChange }: { label: string; answer: Answer<TradeCode[]>; onChange: (a: Answer<TradeCode[]>) => void }) {
  const [query, setQuery] = useState('')
  const error = useContext(FieldErrors)[label]
  const needle = query.trim()
  const results = needle ? TRADE_CATALOG.filter(t => t.label.includes(needle)).slice(0, 8) : []
  return <AnswerField label={label} answer={answer} onChange={onChange} initial={() => []}>{(selected, change) => <>
    <div className="c-trades">{selected.map(code => <span key={code}>{TRADE_CATALOG.find(t => t.code === code)?.label ?? '不明な業種'}<button type="button" className="p-icon-button" aria-label={`${TRADE_CATALOG.find(t => t.code === code)?.label}を外す`} title="候補から外す" onClick={() => { const next = selected.filter(c => c !== code); onChange(next.length ? known(next) : blank()) }}><X size={15} aria-hidden="true" /></button></span>)}</div>
    <label className="p-search"><Search size={17} aria-hidden="true" /><input aria-invalid={!!error} aria-label={`${label}を検索`} placeholder="例：電気、建具、内装" type="search" value={query} onChange={e => setQuery(e.target.value)} /></label>
    {needle && <div className="c-trade-results" aria-label="業種の検索結果">{results.length ? results.map(t => <button type="button" key={t.code} disabled={selected.includes(t.code)} className="p-button" onClick={() => { change([...selected, t.code]); setQuery('') }}><Plus size={15} aria-hidden="true" />{t.label}</button>) : <p className="p-muted">候補がありません</p>}</div>}
  </>}</AnswerField>
}

function answerText(a: Answer<unknown>, options?: readonly (readonly [string, string])[]): string {
  if (a.state !== 'known') return a.state === 'not_applicable' ? `対象外：${a.reason || '理由未入力'}` : STATES[a.state]
  if (options) return labelOf(options, a.value)
  if (Array.isArray(a.value)) return a.value.map(code => TRADE_CATALOG.find(t => t.code === code)?.label ?? '不明な業種').join('、') || '候補未選択'
  if (a.value && typeof a.value === 'object' && 'yen' in a.value) { const m = a.value as Money; return `${m.yen || '金額未入力'} 円（${labelOf(TAXES, m.taxBasis)}）` }
  return typeof a.value === 'string' ? a.value || '内容未入力' : '内容不明'
}
function AnswerSummary({ data }: { data: ClassificationData }) {
  const rows: [string, string][] = (Object.keys(CONTEXT) as (keyof typeof CONTEXT)[]).map(k => [CONTEXT[k].label, answerText(data.context[k], CONTEXT[k].options)])
  data.workItems.forEach((item, index) => {
    rows.push([`施工範囲 ${index + 1}`, item.description || '内容未入力'], ['候補業種', answerText(item.tradeCandidates)], ['工事の関係（申告）', answerText(item.relationship, RELATIONSHIPS)])
    if (item.parentItemId) rows.push(['附帯先として申告した工事', data.workItems.find(i => i.id === item.parentItemId)?.description ?? '対象不明'])
  })
  if (!data.workItems.length) rows.push(['施工範囲', '未入力'])
  for (const k of Object.keys(AMOUNT_LABELS) as (keyof typeof AMOUNT_LABELS)[]) rows.push([AMOUNT_LABELS[k], answerText(data.amounts[k], ['suppliedMaterials', 'splitContracts', 'subcontracting'].includes(k) ? YES_NO : undefined)])
  rows.push(['建設業許可の保有申告', answerText(data.permit.declaration, PERMITS)], [PERMIT_TRADE_LABEL, answerText(data.permit.reportedTrades)], ['許可に関する補足', data.permit.note || '記載なし'])
  for (const k of Object.keys(CONDITION_LABELS) as (keyof typeof CONDITION_LABELS)[]) rows.push([CONDITION_LABELS[k], answerText(data.conditions[k], YES_NO)])
  rows.push(['補足', data.note || '記載なし'])
  return <dl className="c-summary">{rows.map(([label, value], index) => <div key={index}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
}
function BasisSummary({ basis }: { basis: JobBasis }) { return <><p className="p-muted p-small">工事情報 版 {basis.version}</p><dl className="c-summary">{(Object.keys(JOB_LABELS) as (keyof typeof JOB_LABELS)[]).map(key => <div key={key}><dt>{JOB_LABELS[key]}</dt><dd>{basis[key] ?? '未設定'}</dd></div>)}</dl></> }
function IssueItem({ issue, action }: { issue: Issue; action?: ReactNode }) {
  const sourceIds = [...new Set([...issue.sourceIds, ...(issue.code === 'WASTE_REVIEW' ? ['WASTE'] : [])])]
  return <li><span className="p-role">{{ missing: '未入力', unknown: '未確認', review: '確認が必要', out_of_scope: '対象範囲外', stale: '前提更新' }[issue.kind]}</span><div>{issue.title}{action}<div className="c-issue-sources">{sourceIds.map(id => CLASSIFICATION_SOURCES[id] ? <a key={id} href={CLASSIFICATION_SOURCES[id].url} target="_blank" rel="noreferrer">{CLASSIFICATION_SOURCES[id].label}</a> : <span key={id}>参照資料の情報未登録</span>)}</div></div></li>
}

function DependentAnswer({ inactive, pending = false, answer, children }: { inactive: boolean; pending?: boolean; answer: Answer<unknown>; children: ReactNode }) {
  const mode = dependentAnswerMode(inactive, answer)
  if (mode === 'hidden') return null
  return mode === 'saved' || pending && ['unknown', 'unanswered'].includes(answer.state) ? <details className="c-saved-answer"><summary>{mode === 'saved' ? '保持している回答' : '必要な場合の入力'}</summary>{children}</details> : <div className="c-dependent">{children}</div>
}
function targetLabel(target: ClassificationTarget, data: ClassificationData): string {
  const [group, key] = target.field.split('.')
  if (group === 'context') return CONTEXT[key as keyof typeof CONTEXT]?.label ?? '工事条件'
  if (group === 'conditions') return CONDITION_LABELS[key as keyof typeof CONDITION_LABELS] ?? '関連条件'
  if (group === 'amounts') return `${AMOUNT_LABELS[key as keyof typeof AMOUNT_LABELS] ?? '金額'}${target.field.endsWith('.taxBasis') ? 'の税区分' : ''}`
  if (group === 'permit') return key === 'declaration' ? '建設業許可の保有申告' : PERMIT_TRADE_LABEL
  if (group === 'workItem') return `施工範囲 ${data.workItems.findIndex(item => item.id === target.workItemId) + 1}の${key === 'tradeCandidates' ? '候補業種' : '関係'}`
  return '施工範囲'
}

export default function ClassificationPanel({ company, jobId, onExpire, onDirty, onBackToJob, onNext }: { company: Company; jobId: string; onExpire: () => void; onDirty: (dirty: boolean) => void; onBackToJob?: () => void; onNext?: () => void }) {
  const noteId = useId()
  const permitNoteId = useId()
  const [view, setView] = useState<ClassificationView | null>(null)
  const [data, setData] = useState<ClassificationData>(emptyClassification)
  const [basis, setBasis] = useState<JobBasis | null>(null)
  const [version, setVersion] = useState(0)
  const [step, setStep] = useState(0)
  const [results, setResults] = useState(false)
  const [focusTarget, setFocusTarget] = useState<{ target: ClassificationTarget; label: string } | null>(null)
  const root = useRef<HTMLDivElement>(null)
  const resultHeading = useRef<HTMLHeadingElement>(null)
  const advanceFocus = useRef(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const [retry, setRetry] = useState(0)
  const [blocked, setBlocked] = useState(false)
  const [uncertain, setUncertain] = useState(false)
  const [sent, setSent] = useState<ClassificationData | null>(null)
  const [current, setCurrent] = useState<ClassificationView | null>(null)
  const [rebased, setRebased] = useState(false)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [validation, setValidation] = useState<InputError[]>([])
  const scope = useRef<AbortController | null>(null)
  const locked = useRef(false)
  const [loaded, setLoaded] = useState<ClassificationData>(emptyClassification)
  const dirty = !equal(data, loaded) || rebased || blocked
  const readOnly = company.role === 'viewer'
  useEffect(() => { onDirty(!readOnly && (dirty || busy)); return () => onDirty(false) }, [dirty, busy, readOnly, onDirty])
  useEffect(() => {
    if (!focusTarget || results) return
    const { target, label } = focusTarget
    const field = target.field === 'workItems' ? root.current?.querySelector<HTMLElement>('[data-add-work-item]') : root.current?.querySelector<HTMLElement>(`[data-classification-field="${CSS.escape(label.replace(/の税区分$/, ''))}"]`)
    if (!field) return
    for (let parent = field.parentElement; parent; parent = parent.parentElement) if (parent instanceof HTMLDetailsElement) parent.open = true
    const control = target.field.endsWith('.taxBasis') ? field.querySelector<HTMLElement>(`[aria-label="${CSS.escape(label)}"]`) : field.querySelector<HTMLElement>('input,select,textarea,button')
    const focus = control ?? field
    for (let parent = focus.parentElement; parent; parent = parent.parentElement) if (parent instanceof HTMLDetailsElement) parent.open = true
    focus.focus(); field.scrollIntoView({ block: 'center' })
  }, [focusTarget, results])
  useEffect(() => { if (results) resultHeading.current?.focus() }, [results])
  useEffect(() => {
    if (!advanceFocus.current || results) return
    advanceFocus.current = false
    const panel = root.current?.querySelector<HTMLElement>(`#c-step-panel-${step}`)
    panel?.focus(); panel?.scrollIntoView({ block: 'center' })
  }, [step, results])
  useEffect(() => {
    const controller = new AbortController(); scope.current = controller
    void classificationApi.get(company.id, jobId, controller.signal).then(next => {
      if (controller.signal.aborted) return
      setView(next); setData(next.record?.data ?? emptyClassification()); setLoaded(next.record?.data ?? emptyClassification())
      setVersion(next.record?.version ?? 0); setBasis(next.record?.basisJob ?? next.currentJob)
    }).catch(error => { if (!controller.signal.aborted) { if (error instanceof ApiError && error.status === 401) onExpire(); else setError(errorMessage(error)) } })
    return () => controller.abort()
  }, [company.id, jobId, onExpire, retry])
  const changed = (next: ClassificationData) => { setData(next); setMessage(''); setError(''); if (validation.length) setValidation(inputErrors(next)) }
  const updateContext = (key: keyof ClassificationData['context'], value: Answer<unknown>) => changed({ ...data, context: { ...data.context, [key]: value } })
  const updateAmount = (key: keyof ClassificationData['amounts'], value: Answer<unknown>) => changed({ ...data, amounts: { ...data.amounts, [key]: value } })
  const updateItem = (id: string, changes: Partial<WorkItem>) => changed({ ...data, workItems: data.workItems.map(item => item.id === id ? { ...item, ...changes } : item) })
  const deny = (error: unknown) => { if (error instanceof ApiError && error.status === 401) onExpire(); else setError(errorMessage(error)) }
  const catalogMismatch = !!view && view.currentCatalogVersion !== CATALOG_VERSION || !!current && current.currentCatalogVersion !== CATALOG_VERSION
  const stale = !!view?.staleReasons.length && !rebased
  const save = async (advance = false) => {
    if (locked.current || !view || !basis || readOnly || catalogMismatch || blocked || stale) return
    const errors = inputErrors(data)
    if (errors.length) { setValidation(errors); setStep(errors[0].step); setError(`「${STEPS[errors[0].step]}」の入力を見直してください。${errors[0].message}`); return }
    if (!validClassificationData(data)) { setError('入力内容を保存できません。入力した内容を見直してください。'); return }
    setValidation([])
    const signal = scope.current!.signal
    locked.current = true; setBusy(true); setError(''); setMessage(''); setSent(structuredClone(data)); setCurrent(null)
    try {
      const next = await classificationApi.put(company.id, jobId, { data, version, jobVersion: basis.version }, signal)
      if (signal.aborted) return
      setView(next); setData(next.record!.data); setLoaded(next.record!.data); setVersion(next.record!.version); setBasis(next.record!.basisJob); setRebased(false); setUncertain(false)
      setMessage('入力内容を保存しました。'); onDirty(false)
      if (advance) { if (step < 3) { advanceFocus.current = true; setStep(step + 1) } else setResults(true) }
    } catch (error) {
      if (signal.aborted) return
      if (!(error instanceof ApiError) || [0, 409, 500, 502, 503, 504].includes(error.status)) { setBlocked(true); setUncertain(!(error instanceof ApiError) || error.status !== 409) }
      deny(error)
    } finally { if (!signal.aborted) { locked.current = false; setBusy(false) } }
  }
  const checkCurrent = async () => {
    if (locked.current) return
    const signal = scope.current!.signal; locked.current = true; setBusy(true); setError(''); setCurrent(null)
    try { const next = await classificationApi.get(company.id, jobId, signal); if (!signal.aborted) setCurrent(next) }
    catch (error) { if (!signal.aborted) deny(error) }
    finally { if (!signal.aborted) { locked.current = false; setBusy(false) } }
  }
  if (!view) return <div className="c-classification">{error ? <><Notice>{error}</Notice><button className="p-button" onClick={() => { setError(''); setRetry(v => v + 1) }}><RefreshCw size={17} />再試行</button></> : <div className="p-loading" role="status"><LoaderCircle className="p-spin" size={18} />確認事項を読み込み中</div>}</div>
  const no = isNo
  const flow = deriveClassificationFlow(loaded)
  const nextTarget = flow.nextUnanswered ?? flow.nextDeferred
  const jump = (target: ClassificationTarget) => { setStep(target.step); setResults(false); setFocusTarget({ target, label: targetLabel(target, data) }) }
  const pendingTargets = classificationInputTargets(loaded)
  const pendingIssues = view.issues.filter(issue => ['FIELD_UNANSWERED', 'FIELD_UNKNOWN', 'SCOPE_REQUIRED'].includes(issue.code) && classificationIssueTarget(issue, loaded, data))
  const attention = view.issues.filter(issue => issue.kind === 'stale' || issue.kind === 'out_of_scope')
  const reviews = view.issues.filter(issue => !pendingIssues.includes(issue) && !attention.includes(issue))
  return <div className="c-classification" ref={root}>
    <div className="c-heading"><div><h2>契約前の確認</h2><p className="p-muted p-small">工事内容と条件の申告</p></div><span className="p-role">{view.record ? `回答 版 ${view.record.version}` : '未保存'}</span></div>
    <p className="c-scope-note">保存した回答は申告の記録です。業種・附帯工事の認定や許可の照合は別途必要です。</p>
    {catalogMismatch && <Notice>業種カタログが更新されています。再読込するまで保存できません。入力中の場合は、内容を確認してから再読込してください。</Notice>}
    {message && <div className="p-success" role="status"><Check size={17} />{message}</div>}
    {error && <Notice>{error}</Notice>}
    {view.record && <p className="p-record-meta">記録者 {view.record.updatedBy.name} · {displayDate(view.record.updatedAt)} · 保存時の工事 版 {view.record.basisJob.version}</p>}
    {!!view.staleReasons.length && <section className="c-review" aria-label="工事前提の再確認"><h3>工事条件の見直しが必要です</h3><ul>{view.staleReasons.map(reason => <li key={reason}>{{ job_changed: '工事情報の版が更新されています。', rules_changed: '確認事項のルールが更新されています。', catalog_changed: '業種カタログが更新されています。' }[reason]}</li>)}</ul>
      <div className="c-compare-grid"><section><h4>保存時の工事情報</h4><BasisSummary basis={view.record!.basisJob} /></section><section><h4>現在の工事情報</h4><BasisSummary basis={view.currentJob} /></section></div>
      {view.staleReasons.includes('job_changed') && view.jobDifferences.length === 0 && <p>項目の値は同じですが、工事情報の版が更新されています。</p>}
      {!readOnly && !blocked && <button type="button" className="p-button" disabled={busy || rebased || catalogMismatch} onClick={() => { setBasis(view.currentJob); setRebased(true); setMessage('前提を選び直しました。回答を見直して保存してください。') }}><Check size={17} />{rebased ? '現在の前提を選択中・保存待ち' : '工事情報を再確認し、回答を見直す'}</button>}
    </section>}
    {blocked && <section className="c-review" aria-label="保存結果の照合"><h3>{uncertain ? '保存結果は不明です' : '保存内容が更新されています'}</h3><p>入力内容は保持されています。現在の保存内容と照合してから編集を続けてください。</p><button type="button" className="p-button" onClick={() => void checkCurrent()} disabled={busy}><RefreshCw className={busy ? 'p-spin' : undefined} size={17} />現在の保存内容を確認</button>
      {current && <><p role="status">現在の回答 {current.record ? `版 ${current.record.version}` : '未保存（版 0）'}</p>{uncertain && <p>内容の一致だけでは、直前の送信が保存されたかどうかは確定できません。</p>}<div className="c-compare-grid"><section><h4>編集開始時の回答</h4><AnswerSummary data={loaded} /><h4>編集の前提とした工事情報</h4><BasisSummary basis={basis!} /></section><section><h4>直前の送信内容</h4><AnswerSummary data={sent ?? data} /></section><section><h4>現在の保存内容</h4>{current.record ? <AnswerSummary data={current.record.data} /> : <p>回答はまだ保存されていません。</p>}<h4>現在の工事情報</h4><BasisSummary basis={current.currentJob} /></section><section><h4>保持している入力</h4><AnswerSummary data={data} /></section></div><button type="button" className="p-button" disabled={busy || catalogMismatch} onClick={() => { setView(current); setVersion(current.record?.version ?? 0); setLoaded(current.record?.data ?? emptyClassification()); setBasis(current.currentJob); setRebased(true); setBlocked(false); setUncertain(false); setCurrent(null); setError(''); setMessage('照合した工事・回答の版を選びました。保持した入力を見直して保存してください。') }}><Check size={17} />比較を確認し、保持した入力で編集を続ける</button></>}
    </section>}
    {readOnly ? view.record ? <AnswerSummary data={data} /> : <p>保存した回答はありません。</p> : results ? <section className="c-results" aria-label="保存した確認事項"><h3 tabIndex={-1} ref={resultHeading}>回答を保存しました</h3><p>資料の確認が残っています。</p>
      <p className="c-remaining">未入力 {flow.unansweredCount}件 · 未確認 {flow.deferredCount}件</p>
      {nextTarget && <div className="c-next-input"><p>{flow.nextUnanswered ? '次に入力' : '未確認'}：{targetLabel(nextTarget, loaded)}</p><button type="button" className="p-button p-primary" disabled={busy || blocked || stale || catalogMismatch} onClick={() => jump(nextTarget)}><ArrowRight size={17} />{flow.nextUnanswered ? '入力する' : '確認して入力'}</button></div>}
      {flow.unansweredCount + flow.deferredCount > 1 && <details className="c-pending-list"><summary>残りの入力・確認を見る</summary><ul>{[...pendingTargets.unanswered, ...pendingTargets.deferred].slice(1).map(target => <li key={`${target.field}:${target.workItemId ?? ''}`}><button type="button" className="p-text-button" disabled={busy || blocked || stale || catalogMismatch} onClick={() => jump(target)}>{targetLabel(target, loaded)}<ArrowRight size={15} aria-hidden="true" /></button></li>)}</ul></details>}
      <div className="c-result-actions"><button type="button" className="p-button" disabled={busy || blocked || catalogMismatch} onClick={() => { setResults(false); setStep(0) }}>回答を編集</button>{onBackToJob && <button type="button" className="p-button" onClick={onBackToJob}><ArrowLeft size={17} />基本情報に戻る</button>}</div>
      {onNext && <div className="c-next-work"><h4>次の作業：確認記録・見積</h4><button className="p-button p-primary" type="button" disabled={busy || blocked || stale || catalogMismatch} onClick={onNext}><ArrowRight size={17} />確認記録・見積へ進む</button></div>}
    </section> : <>
      <div className="c-steps" role="tablist" aria-label="確認の段階">{STEPS.map((label, index) => <button key={label} id={`c-step-${index}`} aria-controls={`c-step-panel-${index}`} type="button" role="tab" disabled={busy} tabIndex={step === index ? 0 : -1} aria-selected={step === index} onClick={() => setStep(index)} onKeyDown={e => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return
        e.preventDefault(); const next = e.key === 'Home' ? 0 : e.key === 'End' ? 3 : (step + (e.key === 'ArrowRight' ? 1 : 3)) % 4
        setStep(next); document.getElementById(`c-step-${next}`)?.focus()
      }}><span>{index + 1}</span>{label}</button>)}</div>
      {validation.some(e => e.step === step) && <p role="alert" className="p-field-error">この段階の入力を見直してください。</p>}
      <FieldErrors.Provider value={Object.fromEntries(validation.map(e => [e.label, e.message]))}><fieldset disabled={busy || blocked || catalogMismatch} className="c-form"><div key={step} className="p-enter" role="tabpanel" tabIndex={0} id={`c-step-panel-${step}`} aria-labelledby={`c-step-${step}`}>
        {step === 0 && <div className="c-fields">{(Object.keys(CONTEXT) as (keyof typeof CONTEXT)[]).map(key => <SelectAnswer key={key} label={CONTEXT[key].label} answer={data.context[key] as Answer<string>} options={CONTEXT[key].options} onChange={value => updateContext(key, value)} />)}</div>}
        {step === 1 && <><p className="p-muted p-small">今回当社が受ける施工範囲</p>{data.workItems.map((item, index) => <section key={item.id} className="c-work-item"><div className="c-heading"><h3>施工範囲 {index + 1}</h3><button type="button" className="p-icon-button" title="この施工範囲を削除" aria-label={`施工範囲 ${index + 1}を削除`} onClick={() => { if (window.confirm('この施工範囲を削除しますか？ 関連する附帯先の指定も見直してください。')) changed({ ...data, workItems: data.workItems.filter(i => i.id !== item.id) }) }}><Trash2 size={17} /></button></div><label className="p-field"><span>施工内容</span><textarea aria-label={`施工範囲 ${index + 1}の施工内容`} aria-invalid={validation.some(e => e.label === `施工範囲 ${index + 1}の施工内容`)} aria-describedby={`c-description-error-${item.id}`} rows={3} value={item.description} onChange={e => updateItem(item.id, { description: limit(e.target.value, 300) })} /><span className="p-field-error" id={`c-description-error-${item.id}`}>{validation.find(e => e.label === `施工範囲 ${index + 1}の施工内容`)?.message}</span></label>
          <TradeAnswer label={`施工範囲 ${index + 1}の候補業種`} answer={item.tradeCandidates} onChange={value => updateItem(item.id, { tradeCandidates: value })} /><SelectAnswer label={`施工範囲 ${index + 1}の関係`} answer={item.relationship} options={RELATIONSHIPS} onChange={value => updateItem(item.id, { relationship: value, parentItemId: value.state === 'known' && value.value === 'ancillary' ? item.parentItemId : null })} />
          {item.relationship.state === 'known' && item.relationship.value === 'ancillary' && <label className="p-field"><span>附帯先として申告する工事</span><select aria-label={`施工範囲 ${index + 1}の附帯先`} aria-invalid={validation.some(e => e.label === `施工範囲 ${index + 1}の附帯先`)} aria-describedby={`c-parent-error-${item.id}`} value={item.parentItemId ?? ''} onChange={e => updateItem(item.id, { parentItemId: e.target.value || null })}><option value="">選択してください</option>{data.workItems.filter(i => i.id !== item.id && i.relationship.state === 'known' && ['primary', 'independent'].includes(i.relationship.value)).map(i => <option key={i.id} value={i.id}>{i.description || '施工内容未入力'}</option>)}</select><span className="p-field-error" id={`c-parent-error-${item.id}`}>{validation.find(e => e.label === `施工範囲 ${index + 1}の附帯先`)?.message}</span></label>}
        </section>)}<button type="button" data-add-work-item className="p-button" disabled={data.workItems.length >= 12} onClick={() => changed({ ...data, workItems: [...data.workItems, { id: crypto.randomUUID(), description: '', tradeCandidates: blank(), relationship: blank(), parentItemId: null }] })}><Plus size={17} />施工範囲を追加</button></>}
        {step === 2 && <><MoneyAnswer label={AMOUNT_LABELS.contract} answer={data.amounts.contract} onChange={v => updateAmount('contract', v)} />
          <SelectAnswer label={AMOUNT_LABELS.suppliedMaterials} answer={data.amounts.suppliedMaterials} options={YES_NO} onChange={v => updateAmount('suppliedMaterials', v)} />{(['suppliedMaterialValue', 'suppliedMaterialTransport'] as const).map(key => <DependentAnswer key={key} inactive={no(data.amounts.suppliedMaterials)} pending={data.amounts.suppliedMaterials.state !== 'known'} answer={data.amounts[key]}><MoneyAnswer label={AMOUNT_LABELS[key]} answer={data.amounts[key]} allowNA={no(data.amounts.suppliedMaterials)} onChange={v => updateAmount(key, v)} /></DependentAnswer>)}
          <SelectAnswer label={AMOUNT_LABELS.splitContracts} answer={data.amounts.splitContracts} options={YES_NO} onChange={v => updateAmount('splitContracts', v)} /><DependentAnswer inactive={no(data.amounts.splitContracts)} pending={data.amounts.splitContracts.state !== 'known'} answer={data.amounts.relatedContractValue}><MoneyAnswer label={AMOUNT_LABELS.relatedContractValue} answer={data.amounts.relatedContractValue} allowNA={no(data.amounts.splitContracts)} onChange={v => updateAmount('relatedContractValue', v)} /></DependentAnswer><DependentAnswer inactive={no(data.amounts.splitContracts)} pending={data.amounts.splitContracts.state !== 'known'} answer={data.amounts.splitReason}><AnswerField label={AMOUNT_LABELS.splitReason} answer={data.amounts.splitReason} initial={() => ''} allowNA={no(data.amounts.splitContracts)} onChange={v => updateAmount('splitReason', v)}>{(value, change) => <textarea aria-label="契約を分けた理由の内容" value={value} onChange={e => change(limit(e.target.value, 500))} />}</AnswerField></DependentAnswer>
          <SelectAnswer label={AMOUNT_LABELS.subcontracting} answer={data.amounts.subcontracting} options={YES_NO} onChange={v => updateAmount('subcontracting', v)} /><DependentAnswer inactive={no(data.amounts.subcontracting)} pending={data.amounts.subcontracting.state !== 'known'} answer={data.amounts.subcontractTotal}><MoneyAnswer label={AMOUNT_LABELS.subcontractTotal} answer={data.amounts.subcontractTotal} allowNA={no(data.amounts.subcontracting)} onChange={v => updateAmount('subcontractTotal', v)} /></DependentAnswer>
          <SelectAnswer label="建設業許可の保有申告" answer={data.permit.declaration} options={PERMITS} onChange={v => changed({ ...data, permit: { ...data.permit, declaration: v } })} /><DependentAnswer inactive={data.permit.declaration.state === 'known' && data.permit.declaration.value === 'not_held'} pending={data.permit.declaration.state !== 'known'} answer={data.permit.reportedTrades}><TradeAnswer label={PERMIT_TRADE_LABEL} answer={data.permit.reportedTrades} onChange={v => changed({ ...data, permit: { ...data.permit, reportedTrades: v } })} /></DependentAnswer><details className="c-optional-note"><summary>許可の補足{data.permit.note ? '（記録あり）' : '（任意）'}</summary><div className="p-field"><label htmlFor={permitNoteId}>許可に関する補足</label><textarea id={permitNoteId} value={data.permit.note} onChange={e => changed({ ...data, permit: { ...data.permit, note: limit(e.target.value, 1000) } })} /></div></details>
        </>}
        {step === 3 && <><div className="c-fields">{(Object.keys(CONDITION_LABELS) as (keyof typeof CONDITION_LABELS)[]).map(key => <SelectAnswer key={key} label={CONDITION_LABELS[key]} answer={data.conditions[key]} options={YES_NO} onChange={v => changed({ ...data, conditions: { ...data.conditions, [key]: v } })} />)}</div><div className="p-field"><label htmlFor={noteId}>補足</label><textarea id={noteId} value={data.note} onChange={e => changed({ ...data, note: limit(e.target.value, 2000) })} /></div></>}
      </div></fieldset></FieldErrors.Provider>
      <div className="c-actions"><button type="button" className="p-icon-button" title="前の段階" aria-label="前の段階" disabled={step === 0 || busy} onClick={() => setStep(v => v - 1)}><ArrowLeft size={18} /></button><span className="p-muted p-small">{step + 1} / 4</span><button type="button" className="p-button" disabled={busy || blocked || stale || catalogMismatch} onClick={() => void save()}><Save size={17} />途中まで保存</button><button type="button" className="p-button p-primary" disabled={busy || blocked || stale || catalogMismatch} onClick={() => void save(true)}>{busy ? <LoaderCircle className="p-spin" size={17} /> : <ArrowRight size={17} />}{step === 3 ? '保存して確認事項へ' : '保存して次へ'}</button></div>
      {view.record && <button type="button" className="p-text-button" disabled={dirty || busy || blocked} onClick={() => setResults(true)}>保存した確認事項を見る</button>}
    </>}
    {!!attention.length && <section className="c-issues" aria-label="優先して確認する事項"><ul>{attention.map(issue => <IssueItem key={issue.id} issue={issue} action={!readOnly && !dirty && classificationIssueTarget(issue, loaded, data) && <button type="button" className="p-text-button" disabled={busy || blocked || catalogMismatch} onClick={() => jump(classificationIssueTarget(issue, loaded, data)!)}>該当の回答へ</button>} />)}</ul></section>}
    {(readOnly || results) && <section className="c-issues" aria-label="資料で確認する事項"><h3>資料で確認する事項</h3>{!!reviews.length && <ul><IssueItem issue={reviews[0]} /></ul>}<details><summary><AlertCircle size={17} />その他の確認事項 {Math.max(0, reviews.length - 1)}件<ChevronDown size={16} /></summary><p className="p-muted p-small">保存済みの回答に基づく確認事項です。すべてが一律の法的義務を意味するものではありません。</p><ul>{reviews.slice(1).map(issue => <IssueItem key={issue.id} issue={issue} />)}</ul></details></section>}
    {!readOnly && <section className="c-history"><button type="button" className="p-text-button" aria-expanded={historyOpen} aria-controls="c-history-panel" onClick={() => setHistoryOpen(v => !v)}><History size={17} />回答の変更履歴<ChevronDown className={historyOpen ? 'c-rotated' : ''} size={16} /></button>{historyOpen && <div id="c-history-panel"><ClassificationHistory key={view.record?.version ?? 0} companyId={company.id} jobId={jobId} onExpire={onExpire} /></div>}</section>}
  </div>
}

function ClassificationHistory({ companyId, jobId, onExpire }: { companyId: string; jobId: string; onExpire: () => void }) {
  const [events, setEvents] = useState<ClassificationAuditEvent[]>([])
  const [cursor, setCursor] = useState<string | null>(null)
  const [request, setRequest] = useState<{ cursor: string | null; attempt: number }>({ cursor: null, attempt: 0 })
  const [busy, setBusy] = useState(true)
  const [error, setError] = useState('')
  const locked = useRef(false)
  useEffect(() => {
    const controller = new AbortController(); locked.current = true
    void classificationApi.audit(companyId, jobId, controller.signal, request.cursor).then(page => {
      if (controller.signal.aborted) return
      setEvents(old => request.cursor === null ? page.events : [...old, ...page.events.filter(e => !old.some(o => o.id === e.id))]); setCursor(page.nextCursor)
    }).catch(error => { if (!controller.signal.aborted) { if (error instanceof ApiError && error.status === 401) onExpire(); else setError(errorMessage(error)) } }).finally(() => { if (!controller.signal.aborted) { locked.current = false; setBusy(false) } })
    return () => controller.abort()
  }, [companyId, jobId, onExpire, request])
  const load = (cursor: string | null) => { if (!locked.current) { locked.current = true; setBusy(true); setError(''); setRequest(v => ({ cursor, attempt: v.attempt + 1 })) } }
  return <><p className="p-muted p-small">分類専用の履歴 · {events.length}件表示</p><ol className="c-history-list">{events.map(event => <li key={event.id} data-classification-version={event.targetVersion}><details><summary>回答 版 {event.targetVersion} · 記録者 {event.actorName} · {displayDate(event.occurredAt)}</summary><p className="p-muted p-small">ルール {event.afterData.rulesVersion} · カタログ {event.afterData.catalogVersion}</p><div className="c-compare-grid">{event.beforeData && <section><h4>変更前の回答</h4><AnswerSummary data={event.beforeData.data} /><h4>変更前の工事前提</h4><BasisSummary basis={event.beforeData.basisJob} /></section>}<section><h4>{event.beforeData ? '変更後の回答' : '保存した回答'}</h4><AnswerSummary data={event.afterData.data} /><h4>保存時の工事前提</h4><BasisSummary basis={event.afterData.basisJob} /></section></div></details></li>)}</ol>{error && <><Notice>{error} 取得済みの履歴は保持しています。</Notice><button type="button" className="p-button" disabled={busy} onClick={() => load(request.cursor)}><RefreshCw size={17} />回答履歴の取得を再試行</button></>}{busy ? <div className="p-loading" role="status"><LoaderCircle className="p-spin" size={18} />回答履歴を読み込み中</div> : !error && (cursor ? <button type="button" className="p-button" onClick={() => load(cursor)}><History size={17} />以前の回答履歴を表示</button> : <p className="p-muted p-small" role="status">{events.length ? '最初の回答履歴まで表示しました。' : '回答履歴はありません。'}</p>)}</>
}
