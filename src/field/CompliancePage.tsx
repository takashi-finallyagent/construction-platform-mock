import { useState, type FormEvent } from 'react'
import { Link, useParams } from 'react-router'
import { ArrowDownToLine, ArrowLeft, ArrowRight, Check, ClipboardCheck, ExternalLink, LoaderCircle } from 'lucide-react'
import { useField } from './FieldProvider'
import { localDate, stageLabels, uid, type FieldJob } from './model'
import { checkState, emptyProfile, permitSignals, profileIssues, readiness, requirements, reviewBasis, REVIEW_DATE, RULE_VERSION, type ComplianceProfile, type ComplianceReview, type Requirement } from './compliance'
import { downloadBlob } from './pdf'
import { saveError } from './storage'

const stateLabels = { missing: '未記録', stale: '再確認が必要', unresolved: '未解決', recorded: '記録あり・内容未審査' }

export function ComplianceSummary({ job }: { job: FieldJob }) {
  const state = readiness(job, Math.min(job.stage + 1, 3), localDate())
  return <section className="compliance-summary" aria-label="工事の確認状況"><ClipboardCheck size={23} /><div>
    <strong>{state.missingProfile.length ? '先に工事条件の確認が必要です' : state.pending.length ? `確認記録があと${state.pending.length}件必要です` : '必要項目の記録あり・法令適合は未判定'}</strong>
    <p>記録が不足している間は次の段階へ進めません。写真の保存は継続できます。</p>
  </div><Link className="field-button secondary" to={`/sites/${job.id}/checks`}>工事の確認<ArrowRight size={17} /></Link></section>
}

export function FieldCompliancePage() {
  const { siteId } = useParams()
  const { jobs, ready, error } = useField()
  const [selected, setSelected] = useState('')
  const [saved, setSaved] = useState(false)
  const job = jobs.find((item) => item.id === siteId)
  if (!ready) return <div className="field-empty" role="status">工事を開いています</div>
  if (!job) return <div className="field-empty" role="alert">{error || '工事が見つかりません'}</div>
  const issues = profileIssues(job.complianceProfile)
  const checks = requirements(job)
  const target = Math.min(job.stage + 1, 3)
  const current = checks.filter((r) => r.stage <= target)
  const state = readiness(job, target, localDate())
  const active = current.find((r) => r.id === selected) ?? state.pending[0] ?? current[0]
  return <div className="field-page compliance-page">
    <Link className="field-back" to={`/sites/${job.id}`}><ArrowLeft size={17} />工事に戻る</Link>
    <header className="field-heading"><div><p className="field-eyebrow">{job.name}</p><h1>工事の確認</h1><p className="field-meta">現在：{stageLabels[job.stage]} / 資料確認日 {REVIEW_DATE}</p></div></header>
    <p className="compliance-limitation">試作版・この端末のみ保存。本人確認・資料内容の審査・行政への提出・法定保存は未対応です。実務の承認や適法性を保証するものではありません。</p>
    <Link className="field-back" to={`/sites/${job.id}/payments`}>検査・下請支払の期限を確認<ArrowRight size={16} /></Link>
    {saved && <p className="field-success" role="status">確認記録をこの端末に保存しました（{job.complianceReviews?.length ?? 0}件）</p>}
    <details className="compliance-profile" open={issues.length ? true : undefined}><summary>{issues.length ? `工事条件を確認する（未確定 ${issues.length}項目）` : '工事条件を見る・変更する'}</summary><ProfileEditor key={job.id} job={job} /></details>
    {issues.length > 0 ? <div className="compliance-pending"><h2>担当者への確認事項</h2><ul>{issues.map((issue) => <li key={issue}>{issue}</li>)}</ul></div> : <>
      <div className="field-section-heading"><h2>{state.pending.length ? '次に確認すること' : '記録した確認内容'}</h2><span className="field-meta">{current.length - state.pending.length} / {current.length}件</span></div>
      {active && <ReviewEditor key={`${active.id}-${job.complianceReviews?.length ?? 0}`} job={job} check={active} onSaved={() => { setSelected(''); setSaved(true) }} />}
    </>}
    <details className="field-records"><summary>すべての確認項目・根拠・履歴</summary><div className="compliance-checks">{checks.map((check) => {
      const result = checkState(job, check, localDate())
      return <div className="compliance-check" key={check.id}><div><strong>{check.title}</strong><span>{stageLabels[check.stage]}に進む前 / {stateLabels[result.status]}</span></div>
        {check.stage <= target && !issues.length && <button className="field-button secondary" onClick={() => setSelected(check.id)}>記録を開く<ArrowRight size={16} /></button>}
        <p>{check.detail}</p><a href={check.source} target="_blank" rel="noreferrer">公的資料<ExternalLink size={14} /></a></div>
    })}</div>
      <h2 className="compliance-history-heading">保存した履歴</h2>
      {!(job.complianceReviews?.length) && <p className="field-meta">確認記録はありません。</p>}
      {[...(job.complianceReviews ?? [])].reverse().map((review) => <article className="compliance-history" key={review.id}><strong>{checks.find((r) => r.id === review.checkId)?.title ?? review.checkId}</strong><p>{review.reviewer} / 確認日 {review.reviewedOn} / {review.conclusion === 'unresolved' ? '未解決' : review.conclusion === 'not-applicable' ? '対象外の判断を記録' : '確認内容を記録'}</p><p>{review.note}</p><small>記録日時 {review.recordedAt} / ルール {review.ruleVersion}{review.basis !== reviewBasis(job) ? ' / 工事条件が変更されています' : ''}</small><button className="field-button secondary" onClick={() => downloadBlob(review.evidence, review.evidenceName)}><ArrowDownToLine size={17} />{review.evidenceName}</button></article>)}
    </details>
  </div>
}

function ProfileEditor({ job }: { job: FieldJob }) {
  const { updateJob } = useField()
  const [draft, setDraft] = useState<ComplianceProfile>({ ...emptyProfile, ...job.complianceProfile })
  const [step, setStep] = useState(0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  function set<K extends keyof ComplianceProfile>(key: K, value: ComplianceProfile[K]) { setDraft((current) => ({ ...current, [key]: value })); setMessage('') }
  const money = (key: 'contractYen' | 'suppliedYen' | 'relatedYen' | 'subcontractYen', label: string) => <label>{label}<input type="number" inputMode="numeric" min="0" max="1000000000000" step="1" value={draft[key] ?? ''} onChange={(event) => set(key, event.target.value === '' ? null : Number(event.target.value))} /></label>
  async function save(event: FormEvent) {
    event.preventDefault(); if (busy) return
    setBusy(true); setError(''); setMessage('')
    try { await updateJob({ ...job, complianceProfile: draft }); setMessage('工事条件をこの端末に保存しました'); setStep(Math.min(2, step + 1)) } catch (reason) { setError(saveError(reason)) } finally { setBusy(false) }
  }
  const signal = permitSignals(draft)
  return <form className="field-form compliance-form" onSubmit={(event) => void save(event)}>
    <div className="field-segment" aria-label="工事条件の入力段階">{['立場・場所', '工種・金額', '下請・既存物'].map((label, index) => <button type="button" key={label} aria-pressed={step === index} onClick={() => setStep(index)}>{index + 1} {label}</button>)}</div>
    {step === 0 && <>
      <label>工事の所在地<input maxLength={120} value={draft.address} onChange={(e) => set('address', e.target.value)} placeholder="都道府県・市区町村・住所" /></label>
      <label>自社の立場<select aria-label="自社の立場" value={draft.role} onChange={(e) => set('role', e.target.value as ComplianceProfile['role'])}><option value="unknown">不明・担当者に確認</option><option value="prime">施主から直接受注（元請）</option><option value="sub">他の建設会社から受注（下請）</option></select></label>
      <label>発注者の区分<select aria-label="発注者の区分" value={draft.sector} onChange={(e) => set('sector', e.target.value as ComplianceProfile['sector'])}><option value="unknown">不明・担当者に確認</option><option value="private">民間工事</option><option value="public">公共工事</option></select></label>
    </>}
    {step === 1 && <>
      <label>法令上の工事分類<select aria-label="法令上の工事分類" value={draft.category} onChange={(e) => set('category', e.target.value as ComplianceProfile['category'])}><option value="unknown">不明・担当者に確認</option><option value="other">建築一式以外（専門工事・土木一式）</option><option value="building">建築一式工事</option></select></label>
      <label>該当業種・具体的な工事内容<input value={draft.trade} maxLength={120} onChange={(e) => set('trade', e.target.value)} placeholder="例：管工事／給排水管の更新" /></label>
      {money('contractYen', '自社の請負金額（税込・円）')}
      {money('suppliedYen', '別途支給される材料の市場価格＋運送費（税込・なしは0円）')}
      {money('relatedYen', '同一工事の分割契約・追加分（税込・上の金額との重複を除く・なしは0円）')}
      <p className="field-meta">許可判定用の合算：{signal.amount === null ? '未確定' : `${signal.amount.toLocaleString()}円`}。見積書の合計とは別に確認する金額です。</p>
    </>}
    {step === 2 && <>
      <label>自社から別の業者に工事を発注するか<select aria-label="自社から別の業者に工事を発注するか" value={draft.subcontract} onChange={(e) => set('subcontract', e.target.value as ComplianceProfile['subcontract'])}><option value="unknown">不明・担当者に確認</option><option value="no">発注しない</option><option value="yes">発注する</option></select></label>
      {draft.subcontract === 'yes' && money('subcontractYen', '下請契約の合計（税込・円・自社が支給する材料費は含めない）')}
      <label>既存建物・工作物の解体や改修を含むか<select aria-label="既存建物・工作物の解体や改修を含むか" value={draft.existingWork} onChange={(e) => set('existingWork', e.target.value as ComplianceProfile['existingWork'])}><option value="unknown">不明・担当者に確認</option><option value="yes">含む</option><option value="no">含まない（新築のみ等）</option></select></label>
    </>}
    {error && <p className="field-error" role="alert">{error}</p>}{message && <p className="field-success" role="status">{message}</p>}
    <button className="field-button" disabled={busy}>{busy ? <LoaderCircle className="spin" size={18} /> : <Check size={18} />}{step < 2 ? '保存して次の条件へ' : '工事条件を保存'}</button>
  </form>
}

function ReviewEditor({ job, check, onSaved }: { job: FieldJob; check: Requirement; onSaved: () => void }) {
  const { recordReview } = useField()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState(false)
  const previous = checkState(job, check, localDate())
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (busy) return
    const form = new FormData(event.currentTarget)
    const evidence = form.get('evidence')
    if (!(evidence instanceof File)) { setError('根拠資料を指定してください。'); return }
    const review: ComplianceReview = { id: uid(), checkId: check.id, ruleVersion: RULE_VERSION, basis: reviewBasis(job), reviewer: String(form.get('reviewer')).trim(), reviewedOn: String(form.get('reviewedOn')), conclusion: String(form.get('conclusion')) as ComplianceReview['conclusion'], note: String(form.get('note')).trim(), eventDate: String(form.get('eventDate') ?? ''), evidence, evidenceName: evidence.name, recordedAt: new Date().toISOString() }
    setBusy(true); setError(''); setSuccess(false)
    try { await recordReview(job.id, review); setSuccess(true); onSaved() } catch (reason) { setError(saveError(reason)) } finally { setBusy(false) }
  }
  return <section className="compliance-review"><p className="field-eyebrow">{stageLabels[check.stage]}に進む前 / {stateLabels[previous.status]}</p><h2>{check.title}</h2><p>{check.detail}</p><a className="compliance-source" href={check.source} target="_blank" rel="noreferrer">公的資料を確認<ExternalLink size={15} /></a>
    <form className="field-form compliance-form" onSubmit={(event) => void save(event)}>
      <label>確認した担当者<input name="reviewer" required maxLength={60} autoComplete="name" /></label>
      <label>確認日<input name="reviewedOn" type="date" required max={localDate()} defaultValue={localDate()} /></label>
      <label>確認結果<select name="conclusion" aria-label="確認結果" defaultValue="unresolved"><option value="unresolved">未解決・追加の確認が必要</option><option value="documented">必要な対応と資料を確認した</option>{check.exemption && <option value="not-applicable">対象外と判断した根拠がある</option>}</select></label>
      {check.id === 'contract' && <label>契約書類の双方交付日<input name="eventDate" type="date" max={localDate()} /></label>}
      <label>確認した内容・根拠・残っている問題<textarea name="note" required minLength={10} maxLength={2000} rows={4} /></label>
      <label>根拠資料（PDF・JPEG・PNG、10MBまで）<input name="evidence" type="file" required accept="application/pdf,image/jpeg,image/png" /><span className="field-meta">{check.evidence}</span></label>
      {error && <p className="field-error" role="alert">{error}</p>}{success && <p className="field-success" role="status">確認記録をこの端末に保存しました</p>}
      <button className="field-button" disabled={busy}>{busy ? <LoaderCircle className="spin" size={18} /> : <Check size={18} />}確認記録を保存</button>
    </form>
  </section>
}
