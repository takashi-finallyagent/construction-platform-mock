import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Link, useParams, useSearchParams } from 'react-router'
import { ArrowDownToLine, ArrowLeft, ArrowRight, CalendarClock, Check, ChevronRight, ExternalLink, History, Plus, Save, X } from 'lucide-react'
import { useField } from './FieldProvider'
import { localDate, uid, type FieldJob } from './model'
import { downloadBlob } from './pdf'
import { saveError } from './storage'
import { activeEvents, assessPayment, emptyTerms, eventLabels, money, PAYMENT_RULE_VERSION, PAYMENT_SOURCE, type PaymentCase, type PaymentEvent, type PaymentEventKind, type PaymentRecord, type PaymentTerms } from './payment'

function useToday() {
  const [today, setToday] = useState(localDate)
  useEffect(() => {
    const refresh = () => setToday(localDate())
    const timer = window.setInterval(refresh, 60_000)
    window.addEventListener('focus', refresh)
    return () => { clearInterval(timer); window.removeEventListener('focus', refresh) }
  }, [])
  return today
}
function statusLabel(item: ReturnType<typeof assessPayment>) {
  if (item.overdueYen) return `管理期限超過 ${money(item.overdueYen)}`
  if (item.inspection.late && !item.inspection.completedOn) return '検査期限を確認'
  if (item.inspection.attention) return `検査 ${item.inspection.due}までに確認`
  if (item.remainingYen === 0) return item.lateHistory ? '支払記録あり・遅延履歴あり' : '全額の支払記録あり'
  return item.next ? `${item.next.date}までに確認${item.next.provisional ? '・仮の期限' : ''}` : '支払期限を確認'
}
export function PaymentSummary({ job }: { job: FieldJob }) {
  const today = useToday()
  const cases = job.paymentCases ?? []
  const urgent = cases.filter((item) => assessPayment(item, today).attention).length
  return <section className="compliance-summary payment-summary" aria-label="検査・下請支払の状況"><CalendarClock size={23} /><div><strong>検査・下請支払{urgent > 0 ? ` / 対応が必要 ${urgent}件` : ''}</strong><p>{cases.length ? `${cases.length}取引 / この端末の記録` : '取引未登録・期限未確認'}</p></div><Link className="field-button secondary" to={`/sites/${job.id}/payments`}>確認する<ArrowRight size={17} /></Link></section>
}
export function PaymentAlerts({ jobs }: { jobs: FieldJob[] }) {
  const today = useToday()
  const alerts = jobs.flatMap((job) => (job.paymentCases ?? []).map((item) => ({ job, item, state: assessPayment(item, today) }))).filter(({ state }) => state.attention)
  if (!alerts.length) return null
  return <section className="payment-alerts" aria-label="検査・支払の期限"><h2>検査・支払の確認 {alerts.length}件</h2>{alerts.map(({ job, item, state }) => <Link key={item.id} to={`/sites/${job.id}/payments?case=${item.id}`}><CalendarClock size={19} /><span><strong>{state.terms.counterparty} / {statusLabel(state)}</strong><small>{job.building} / {state.terms.scope}</small></span><ChevronRight size={18} /></Link>)}</section>
}
export function FieldPaymentPage() {
  const { siteId } = useParams()
  const { jobs, ready, error } = useField()
  const [params, setParams] = useSearchParams()
  const today = useToday()
  const job = jobs.find((value) => value.id === siteId)
  if (!ready) return <div className="field-empty" role="status">取引を開いています</div>
  if (!job) return <p className="field-error" role="alert">{error || '工事が見つかりません。'}</p>
  const cases = job.paymentCases ?? []
  const selected = cases.find((value) => value.id === params.get('case'))
  return <div className="field-page payment-page">
    <Link className="field-back" to={`/sites/${job.id}`}><ArrowLeft size={16} />工事へ戻る</Link>
    <header className="field-heading"><div><p className="field-eyebrow">{job.building} / {job.name}</p><h1>検査・下請支払</h1></div>{!selected && !params.has('new') && <button className="field-button secondary" onClick={() => setParams({ new: '1' })}><Plus size={18} />取引を登録</button>}</header>
    <p className="compliance-limitation">試作版・この端末のみ保存。自社が下請に発注した建設工事が対象です。入金・振込・通知の自動取得はありません。入力漏れや資料内容の審査、適法性の保証は未対応です。</p>
    {params.has('new') ? <TermsEditor key="new" jobId={job.id} onSaved={(id) => setParams({ case: id })} onCancel={() => setParams({})} />
      : selected ? <><Link className="field-back" to={`/sites/${job.id}/payments`}><ArrowLeft size={16} />取引一覧</Link><CaseDetail key={selected.id} jobId={job.id} item={selected} today={today} /></>
        : <div className="payment-list">{cases.length === 0 ? <p className="field-empty">下請取引は未登録です。登録がないことは支払義務がないことを意味しません。</p> : cases.map((item) => {
          const state = assessPayment(item, today)
          return <Link className={`payment-list-row ${state.attention ? 'needs-attention' : ''}`} key={item.id} to={`?case=${item.id}`}><div><strong>{state.terms.counterparty}</strong><small>{state.terms.scope}</small></div><div><strong>{statusLabel(state)}</strong><small>残額 {money(state.remainingYen)} / 要確認 {state.issues.length}項目</small></div><ChevronRight size={18} /></Link>
        })}</div>}
    <details className="field-records payment-guidance"><summary>期限の根拠と計算範囲</summary><p>検査は完成通知の翌日から20日以内。上位業者からの出来高・完成払の入金は翌日起算の暦1か月以内。特定建設業者等の適用条件を満たす支払は引渡申出日を含め50日以内を上限に、いずれもできる限り短く扱う必要があります。上限日まで待ってよいという意味ではありません。</p><p>契約の分割支払・入金に対応する累計額・引渡申出による総額を別々に比較します。請求書の有無は期限を変えません。休日・特約による延長は自動適用せず、表示日は管理上の警告日として扱います。</p><p>前払金の配慮義務、控除・相殺、手形等、遅延利息、フリーランス法その他の期限は自動判定対象外です。フリーランス法の対象は個人だけとは限りません。別途確認が必要です。</p><a className="compliance-source" href={PAYMENT_SOURCE} target="_blank" rel="noreferrer">国土交通省の根拠資料（45〜48ページ）<ExternalLink size={15} /></a><p>ルール確認日：2026-10-22 / {PAYMENT_RULE_VERSION}</p></details>
  </div>
}

function RecordFields({ payment = false }: { payment?: boolean }) {
  return <><label>記録者<input name="recorder" required maxLength={60} /></label><label>根拠・訂正理由<textarea name="note" required minLength={10} maxLength={1500} rows={3} /></label><label>根拠資料{payment ? '（必須）' : '（任意）'}<input name="evidence" type="file" required={payment} accept="application/pdf,image/jpeg,image/png" /></label><span className="field-meta">PDF・JPEG・PNG / 10MB以下。記録者の本人確認は行われません。</span></>
}
function readRecord(form: HTMLFormElement): PaymentRecord {
  const data = new FormData(form)
  const file = data.get('evidence')
  const evidence = file instanceof File && file.size > 0 ? file : undefined
  return { id: uid(), recorder: String(data.get('recorder') ?? '').trim(), note: String(data.get('note') ?? '').trim(), recordedAt: new Date().toISOString(), evidence, evidenceName: evidence?.name ?? '' }
}
function TermsEditor({ jobId, item, onSaved, onCancel }: { jobId: string; item?: PaymentCase; onSaved: (id: string) => void; onCancel: () => void }) {
  const { savePaymentTerms } = useField()
  const [initial] = useState(() => item?.revisions.at(-1))
  const [terms, setTerms] = useState<PaymentTerms>(() => structuredClone(initial?.terms ?? emptyTerms))
  const [step, setStep] = useState(0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const change = <K extends keyof PaymentTerms>(key: K, value: PaymentTerms[K]) => setTerms((current) => ({ ...current, [key]: value }))
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (busy) return
    setError('')
    if (step < 2) { setStep(step + 1); return }
    setBusy(true)
    try {
      const id = item?.id ?? uid()
      await savePaymentTerms(jobId, id, { ...readRecord(event.currentTarget), terms, previousId: initial?.id ?? null, ruleVersion: PAYMENT_RULE_VERSION })
      onSaved(id)
    } catch (reason) { setError(saveError(reason)) } finally { setBusy(false) }
  }
  return <section className="payment-editor"><div className="field-section-heading"><h2>{item ? '取引条件を訂正' : '下請取引を登録'}</h2><button className="field-icon-button" onClick={onCancel} disabled={busy} aria-label="入力を閉じる" title="入力を閉じる"><X size={20} /></button></div>
    <form className="field-form compliance-form" onSubmit={(event) => void save(event)}>
      <nav className="field-segment" aria-label="取引登録の段階">{['相手と金額', '支払の約束', '記録を残す'].map((label, index) => <button key={label} type="button" aria-pressed={step === index} disabled={busy} onClick={() => setStep(index)}>{index + 1}. {label}</button>)}</nav>
      <fieldset disabled={busy} hidden={step !== 0}>
        <label>下請業者名<input aria-label="下請業者名" required={step === 0} maxLength={80} value={terms.counterparty} onChange={(e) => change('counterparty', e.target.value)} /></label>
        <label>契約番号・担当工事<input aria-label="契約番号・担当工事" required={step === 0} maxLength={100} value={terms.scope} onChange={(e) => change('scope', e.target.value)} /></label>
        <label>税込契約総額（円）<input aria-label="税込契約総額（円）" type="number" min="1" max="1000000000000" step="1" required={step === 0} value={terms.amountYen || ''} onChange={(e) => change('amountYen', e.target.valueAsNumber)} /></label>
        <label>支払う自社の建設業許可<select aria-label="支払う自社の建設業許可" value={terms.payerPermit} onChange={(e) => change('payerPermit', e.target.value as PaymentTerms['payerPermit'])}><option value="unknown">未確認</option><option value="none">許可なし</option><option value="general">一般建設業許可</option><option value="special">特定建設業許可</option></select></label>
        <label>下請業者の特定建設業許可<select aria-label="下請業者の特定建設業許可" value={terms.payeeSpecial} onChange={(e) => change('payeeSpecial', e.target.value as PaymentTerms['payeeSpecial'])}><option value="unknown">未確認</option><option value="yes">あり</option><option value="no">なし（一般許可・許可なし）</option></select></label>
        <label>下請業者の区分<select aria-label="下請業者の区分" value={terms.payeeSize} onChange={(e) => change('payeeSize', e.target.value as PaymentTerms['payeeSize'])}><option value="unknown">未確認</option><option value="individual">個人事業主</option><option value="small">法人・資本金4,000万円未満</option><option value="large">法人・資本金4,000万円以上</option></select></label>
      </fieldset>
      <fieldset disabled={busy} hidden={step !== 1}>
        <label>支払期日の合意<select aria-label="支払期日の合意" value={terms.agreement} onChange={(e) => setTerms((t) => ({ ...t, agreement: e.target.value as PaymentTerms['agreement'], schedule: e.target.value === 'agreed' ? [{ date: '', amountYen: t.amountYen }] : [] }))}><option value="unknown">未確認</option><option value="unset">期日を決めていない</option><option value="agreed">契約で決めている</option></select></label>
        {terms.agreement === 'agreed' && <>{terms.schedule.map((row, index) => <div className="payment-schedule-row" key={index}><label>期日 {index + 1}<input aria-label={`期日 ${index + 1}`} type="date" required={step === 1} value={row.date} onChange={(e) => change('schedule', terms.schedule.map((value, i) => i === index ? { ...value, date: e.target.value } : value))} /></label><label>支払額 {index + 1}（円）<input aria-label={`支払額 ${index + 1}（円）`} type="number" min="1" step="1" required={step === 1} value={Number.isFinite(row.amountYen) ? row.amountYen : ''} onChange={(e) => change('schedule', terms.schedule.map((value, i) => i === index ? { ...value, amountYen: e.target.valueAsNumber } : value))} /></label><button type="button" className="field-icon-button" title="期日を削除" aria-label={`期日 ${index + 1}を削除`} disabled={terms.schedule.length === 1} onClick={() => change('schedule', terms.schedule.filter((_, i) => i !== index))}><X size={18} /></button></div>)}<button type="button" className="field-text-button" disabled={terms.schedule.length >= 36} onClick={() => change('schedule', [...terms.schedule, { date: '', amountYen: 0 }])}><Plus size={18} />分割支払を追加</button><p className="field-meta">予定合計 {money(terms.schedule.reduce((sum, row) => sum + (row.amountYen || 0), 0))} / 契約総額 {money(terms.amountYen || 0)}</p></>}
        <label>引渡しを受ける日を別に定める特約<select aria-label="引渡特約" value={terms.handoverTerm} onChange={(e) => change('handoverTerm', e.target.value as PaymentTerms['handoverTerm'])}><option value="unknown">未確認</option><option value="none">特約なし</option><option value="fixed">特約あり・内容を別途確認</option></select></label>
      </fieldset>
      <fieldset disabled={busy || step !== 2} hidden={step !== 2}><p className="field-meta">{terms.counterparty || '相手未入力'} / 契約総額 {money(terms.amountYen || 0)}{item ? ' / 以前の条件は履歴に残ります' : ''}</p><RecordFields /></fieldset>
      {error && <p className="field-error" role="alert">{error}</p>}
      <div className="payment-form-actions">{step > 0 && <button className="field-button secondary" type="button" disabled={busy} onClick={() => setStep(step - 1)}><ArrowLeft size={17} />戻る</button>}<button className="field-button" disabled={busy}>{step === 2 ? <Save size={18} /> : <ArrowRight size={18} />}{busy ? '保存中' : step === 2 ? '取引条件を保存' : '次へ'}</button></div>
    </form>
  </section>
}

function CaseDetail({ jobId, item, today }: { jobId: string; item: PaymentCase; today: string }) {
  const [editing, setEditing] = useState(false)
  const [kind, setKind] = useState<PaymentEventKind | null>(null)
  const [voidTarget, setVoidTarget] = useState<string | null>(null)
  const [notice, setNotice] = useState('')
  const state = assessPayment(item, today)
  const active = activeEvents(item)
  if (editing) return <TermsEditor jobId={jobId} item={item} onSaved={() => { setEditing(false); setNotice('取引条件の訂正を保存しました。') }} onCancel={() => setEditing(false)} />
  return <>
    <section className="payment-overview"><div><p className="field-eyebrow">{state.terms.scope}</p><h2>{state.terms.counterparty}</h2><p className={state.attention ? 'payment-warning' : 'field-meta'}>{statusLabel(state)}</p></div><dl><div><dt>契約総額</dt><dd>{money(state.terms.amountYen)}</dd></div><div><dt>支払記録</dt><dd>{money(state.paidYen)}</dd></div><div><dt>残額</dt><dd>{money(state.remainingYen)}</dd></div></dl></section>
    {notice && <p className="field-success" role="status"><Check size={18} />{notice}</p>}
    <section className="payment-deadlines" aria-label="期限一覧"><h2>期限と残額</h2>
      <div className="payment-deadline"><div><strong>完成検査</strong><small>完成確認・引渡しの承認とは別の実績</small></div><div><strong>{state.inspection.due ?? '基準日・適用条件を確認'}</strong><small>{state.inspection.provisional && state.inspection.due ? '仮の警告日 / ' : ''}{state.inspection.completedOn ? `検査完了 ${state.inspection.completedOn}` : '検査完了の記録なし'}{state.inspection.late ? ' / 管理期限超過あり' : ''}</small></div></div>
      {state.deadlines.map((deadline) => <div className={`payment-deadline ${deadline.lateYen > 0 ? 'needs-attention' : ''}`} key={deadline.id}><div><strong>{deadline.label}{deadline.provisional ? '・仮' : ''}</strong><small>この日までの支払累計 {money(deadline.amountYen)}</small></div><div><strong>{deadline.date}</strong><small>現在の不足 {money(deadline.unpaidYen)}</small>{deadline.lateYen > 0 && <small className="payment-warning">期限時点の不足 {money(deadline.lateYen)} / 履歴あり</small>}</div></div>)}
      {!state.deadlines.length && <p className="field-meta">計算に必要な期日・入金日・引渡申出日が未登録です。</p>}
    </section>
    {state.issues.length > 0 && <details className="payment-issues" open><summary>担当者への確認 {state.issues.length}項目</summary><ul>{state.issues.map((issue) => <li key={issue}>{issue}</li>)}</ul></details>}
    <section className="payment-events"><h2>発生したことを記録</h2><div className="payment-event-actions">{(Object.keys(eventLabels) as PaymentEventKind[]).filter((value) => value !== 'void').map((value) => <button key={value} className="field-button secondary" disabled={['completion', 'inspection', 'offer'].includes(value) && active.some((event) => event.kind === value)} onClick={() => { setKind(value); setVoidTarget(null); setNotice('') }}><Plus size={17} />{eventLabels[value]}</button>)}</div></section>
    {kind && <EventEditor key={`${kind}-${voidTarget}`} jobId={jobId} item={item} kind={kind} voidTarget={voidTarget} today={today} onClose={() => { setKind(null); setVoidTarget(null) }} onSaved={() => { setKind(null); setVoidTarget(null); setNotice('実績をこの端末に保存しました。') }} />}
    <details className="field-records payment-history"><summary>取引条件・記録の履歴</summary><button className="field-button secondary" onClick={() => setEditing(true)}><History size={17} />取引条件を訂正</button>
      <h2>実績の履歴</h2>{[...item.events].reverse().map((event) => <article key={event.id}><strong>{eventLabels[event.kind]} / {event.date}</strong>{event.amountYen !== null && <p>{money(event.amountYen)}</p>}<p>{event.recorder} / {event.note}</p><small>記録日時 {event.recordedAt}</small>{event.voids && <small>訂正対象：{item.events.find((value) => value.id === event.voids)?.note ?? event.voids}</small>}{event.kind !== 'void' && !active.some((value) => value.id === event.id) && <small>訂正対象・現在の計算から除外</small>}<Evidence record={event} />{event.kind !== 'void' && active.some((value) => value.id === event.id) && <button className="field-text-button" onClick={() => { setKind('void'); setVoidTarget(event.id); setNotice('') }}><History size={16} />この記録を訂正する</button>}</article>)}
      <h2>条件の履歴</h2>{[...item.revisions].reverse().map((revision) => <article key={revision.id}><strong>{revision.terms.counterparty} / {money(revision.terms.amountYen)}</strong><p>{revision.recorder} / {revision.note}</p><small>記録日時 {revision.recordedAt} / ルール {revision.ruleVersion}</small><p>工事範囲：{revision.terms.scope}</p><p>支払期日：{revision.terms.agreement === 'agreed' ? revision.terms.schedule.map((row) => `${row.date} ${money(row.amountYen)}`).join(' / ') : revision.terms.agreement === 'unset' ? '未設定' : '未確認'}</p><dl className="payment-terms-history"><div><dt>自社許可</dt><dd>{({ unknown: '未確認', none: 'なし', general: '一般', special: '特定' })[revision.terms.payerPermit]}</dd></div><div><dt>下請の特定許可</dt><dd>{({ unknown: '未確認', yes: 'あり', no: 'なし' })[revision.terms.payeeSpecial]}</dd></div><div><dt>下請の区分</dt><dd>{({ unknown: '未確認', individual: '個人', small: '資本金4,000万円未満', large: '資本金4,000万円以上' })[revision.terms.payeeSize]}</dd></div><div><dt>引渡特約</dt><dd>{({ unknown: '未確認', none: 'なし', fixed: 'あり' })[revision.terms.handoverTerm]}</dd></div></dl><Evidence record={revision} /></article>)}
    </details>
  </>
}
function Evidence({ record }: { record: PaymentRecord }) {
  return record.evidence ? <button className="field-text-button" onClick={() => downloadBlob(record.evidence!, record.evidenceName)}><ArrowDownToLine size={16} />{record.evidenceName}</button> : <small>添付資料なし・入力内容のみ</small>
}
function EventEditor({ jobId, item, kind, voidTarget, today, onClose, onSaved }: { jobId: string; item: PaymentCase; kind: PaymentEventKind; voidTarget: string | null; today: string; onClose: () => void; onSaved: () => void }) {
  const { recordPaymentEvent } = useField()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const heading = useRef<HTMLHeadingElement>(null)
  useEffect(() => { heading.current?.focus({ preventScroll: true }); heading.current?.scrollIntoView({ block: 'center' }) }, [])
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (busy) return
    setBusy(true); setError('')
    const form = event.currentTarget
    const data = new FormData(form)
    const record: PaymentEvent = { ...readRecord(form), kind, date: String(data.get('date')), amountYen: ['receipt', 'payment'].includes(kind) ? Number(data.get('amount')) : null, voids: kind === 'void' ? voidTarget : null }
    try { await recordPaymentEvent(jobId, item.id, record); onSaved() } catch (reason) { setError(saveError(reason)) } finally { setBusy(false) }
  }
  return <section className="payment-editor" aria-label="実績入力"><div className="field-section-heading"><h2 ref={heading} tabIndex={-1}>{kind === 'void' ? '誤記録を訂正対象にする' : eventLabels[kind]}</h2><button className="field-icon-button" title="実績入力を閉じる" aria-label="実績入力を閉じる" disabled={busy} onClick={onClose}><X size={20} /></button></div>
    {kind === 'receipt' && <p className="field-meta">出来高・完成払の実際の入金が対象です。金額は入金総額ではなく、この下請の施工分に相応する額を記録します。前払金は対象外です。</p>}
    {kind === 'payment' && <p className="field-meta">実行済みの振込・現金支払の記録です。振込予約・手形・相殺を支払済みとして登録しないでください。</p>}
    {kind === 'void' && <p className="field-meta">対象：{item.events.find((event) => event.id === voidTarget)?.note}。元の記録は残り、期限は再計算されます。正しい実績は改めて登録が必要です。</p>}
    <form className="field-form compliance-form" onSubmit={(event) => void save(event)}><fieldset disabled={busy}><label>{kind === 'void' ? '訂正日' : '実績日'}<input name="date" aria-label={kind === 'void' ? '訂正日' : '実績日'} type="date" required max={today} defaultValue={today} /></label>{['receipt', 'payment'].includes(kind) && <label>{kind === 'receipt' ? 'この下請への対応額（円）' : '実際の支払額（円）'}<input name="amount" aria-label="実績金額" type="number" min="1" step="1" max={item.revisions.at(-1)!.terms.amountYen} required /></label>}<RecordFields payment={kind === 'payment'} /></fieldset>{error && <p className="field-error" role="alert">{error}</p>}<button className="field-button" disabled={busy}><Save size={18} />{busy ? '保存中' : kind === 'void' ? '訂正理由を保存' : '実績を保存'}</button></form>
  </section>
}
