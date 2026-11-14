import type { FieldJob } from './model'

// Rules are a review checklist, not an automated legal opinion.
export const RULE_VERSION = '2026-10-22.1'
export const REVIEW_DATE = '2026-10-22'
export const sources = {
  guideline: 'https://www.mlit.go.jp/totikensangyo/const/1_6_bt_000188.html',
  permit: 'https://www.mlit.go.jp/totikensangyo/const/1_6_bt_000080.html',
  engineer: 'https://www.mlit.go.jp/totikensangyo/const/content/001859191.pdf',
  electronic: 'https://www.mlit.go.jp/totikensangyo/const/content/001912595.pdf',
  asbestos: 'https://www.ishiwata.mhlw.go.jp/business/reform-contractor/',
  insurance: 'https://www.mhlw.go.jp/new-info/kobetu/roudou/gyousei/hoken/kakikata/dl/ikkatu-all.pdf',
  dispatch: 'https://www.mhlw.go.jp/bunya/koyou/gigi_outou01.html',
  waste: 'https://www.env.go.jp/recycle/waste/haisyutsu.html',
  building: 'https://www.mlit.go.jp/jutakukentiku/build/r4kaisei_kijunhou0001.html',
  retention: 'https://www.nta.go.jp/law/joho-zeikaishaku/sonota/jirei/tokusetsu/01.htm',
}

export interface ComplianceProfile {
  address: string
  role: 'unknown' | 'prime' | 'sub'
  sector: 'unknown' | 'private' | 'public'
  category: 'unknown' | 'building' | 'other'
  trade: string
  contractYen: number | null
  suppliedYen: number | null
  relatedYen: number | null
  subcontract: 'unknown' | 'yes' | 'no'
  subcontractYen: number | null
  existingWork: 'unknown' | 'yes' | 'no'
}
export const emptyProfile: ComplianceProfile = {
  address: '', role: 'unknown', sector: 'unknown', category: 'unknown', trade: '',
  contractYen: null, suppliedYen: null, relatedYen: null,
  subcontract: 'unknown', subcontractYen: null, existingWork: 'unknown',
}
export interface ComplianceReview {
  id: string
  checkId: string
  ruleVersion: string
  basis: string
  reviewer: string
  reviewedOn: string
  conclusion: 'documented' | 'not-applicable' | 'unresolved'
  note: string
  eventDate: string
  evidenceName: string
  evidence: Blob
  recordedAt: string
}
export interface Requirement {
  id: string
  stage: 1 | 2 | 3
  title: string
  detail: string
  evidence: string
  source: string
  exemption: boolean
}
const yen = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000_000_000
export function profileIssues(profile?: ComplianceProfile): string[] {
  const p = { ...emptyProfile, ...profile }
  const issues: string[] = []
  if (!p.address.trim()) issues.push('工事の所在地')
  if (!['prime', 'sub'].includes(p.role)) issues.push('元請・下請の立場')
  if (!['private', 'public'].includes(p.sector)) issues.push('民間・公共の区分')
  if (!['building', 'other'].includes(p.category) || !p.trade.trim()) issues.push('工事の業種・分類')
  if (!yen(p.contractYen) || p.contractYen === 0) issues.push('税込請負金額')
  if (!yen(p.suppliedYen)) issues.push('支給材料の税込市場価格・運送費（なしは0円）')
  if (!yen(p.relatedYen)) issues.push('同一工事の分割契約合計・追加額（重複を除く、なしは0円）')
  if (!['yes', 'no'].includes(p.subcontract)) issues.push('下請への発注の有無')
  if (p.subcontract === 'yes' && (!yen(p.subcontractYen) || p.subcontractYen === 0)) issues.push('下請契約の税込合計額')
  if (!['yes', 'no'].includes(p.existingWork)) issues.push('既存建物・工作物の解体や改修の有無')
  return issues
}
export function permitSignals(profile?: ComplianceProfile) {
  const p = { ...emptyProfile, ...profile }
  const amountKnown = yen(p.contractYen) && yen(p.suppliedYen) && yen(p.relatedYen)
  const amount = amountKnown ? p.contractYen! + p.suppliedYen! + p.relatedYen! : null
  const threshold = p.category === 'building' ? 15_000_000 : p.category === 'other' ? 5_000_000 : null
  const specialThreshold = p.category === 'building' ? 80_000_000 : p.category === 'other' ? 50_000_000 : null
  const special = p.role === 'prime' && p.subcontract === 'yes' && yen(p.subcontractYen) && specialThreshold !== null && p.subcontractYen >= specialThreshold
  const ledger = p.role === 'prime' && p.subcontract === 'yes' && (p.sector === 'public' || special)
  return { amount, threshold, atOrAbove: amount !== null && threshold !== null ? amount >= threshold : null, special, ledger }
}
export function requirements(job: FieldJob): Requirement[] {
  const p = { ...emptyProfile, ...job.complianceProfile }
  const signal = permitSignals(p)
  const permitDetail = signal.atOrAbove === null ? '金額・工種が未確定です。軽微工事とは判定できません。'
    : signal.atOrAbove ? '許可の金額基準以上です。該当業種・有効期間と、建築一式の場合の木造住宅等の例外を確認。'
      : '金額基準未満でも、工種・契約の合算・支給材料・別法令の登録を確認。許可不要とは断定しません。'
  const list: Requirement[] = [
    { id: 'permit', stage: 1, title: 'この工事を請け負えるか', detail: `${permitDetail}${signal.special ? ' 特定建設業許可の確認が必要な下請金額です。' : ''}`, evidence: '該当業種の許可通知・有効期間、または許可不要と判断した計算と根拠。会社名だけの照合は不可。', source: sources.permit, exemption: true },
    { id: 'estimate', stage: 1, title: '見積と工期の条件', detail: '見積期間、材料費・労務費等の内訳、必要日数、価格や納期に影響する情報、協議の記録。内訳明示の努力義務と禁止行為を区別して確認。', evidence: '条件提示日・見積書・工程の根拠・必要な事前通知や協議記録。', source: sources.guideline, exemption: false },
    { id: 'contract', stage: 1, title: '契約を双方で取り交わしたか', detail: '着工前の契約書、または注文書・請書と基本契約／約款。第19条の必要事項と追加変更の合意方法を確認。PDFを作っただけでは契約成立の確認になりません。', evidence: '署名等を含む双方交付済み契約一式。電子契約は事前承諾・本人性・非改ざん性等の記録も必要。', source: sources.electronic, exemption: false },
    { id: 'engineer', stage: 2, title: '技術者と施工体制', detail: `主任・監理技術者、雇用関係、専任・兼任条件と他現場との重複を確認。${signal.ledger ? '施工体制台帳・体系図が必要となる条件です。' : '台帳・体系図の要否も個別に確認。'}`, evidence: '配置名簿・資格・雇用資料・必要な施工体制台帳／掲示、または適用外の根拠。', source: sources.engineer, exemption: true },
    { id: 'insurance', stage: 2, title: '現場の労災と働く人の確認', detail: '元請の労災適用関係と下請を含む対象、単独／一括有期、雇用・社会保険を確認。一人親方等の特別加入は労働者の扱いと分けて確認。', evidence: '現場との対応が分かる保険手続・加入資料、対象者区分。申告の完了は外部で確認。', source: sources.insurance, exemption: true },
    { id: 'site-permits', stage: 2, title: '作業場所の許可と安全対策', detail: '工種・所在地・作業内容に応じた建築確認、道路・消防・設備関係、資格、安全対策、労働時間、熱中症対策等の適用を担当者が確認。', evidence: '所在地別の適用確認表、必要な許可・届出の控え、資格・安全計画。未確認の項目を残さないこと。', source: sources.building, exemption: false },
    { id: 'waste', stage: 2, title: '廃棄物と再資源化の手配', detail: '元請等の処理責任、委託先の許可・契約、マニフェスト、建設リサイクル法の適用を確認。外部システム未連携でも手続は省略できません。', evidence: '処理計画・委託契約・許可・必要な届出、または廃棄物等が発生しない根拠。', source: sources.waste, exemption: true },
    { id: 'handover', stage: 3, title: '検査と引渡しの記録', detail: '契約変更の合意、完成通知・検査・是正・引渡しを確認。写真台帳だけで検査済み・引渡し済みにはしません。', evidence: '変更契約、完成通知、検査・是正結果と引渡し記録。', source: sources.guideline, exemption: false },
    { id: 'payment', stage: 3, title: '支払期日と保存の手配', detail: '契約期日、出来高入金・引渡申出に応じた下請支払期限等を個別確認。月末締め翌月末払いを一律に設定しません。', evidence: '入金・引渡申出等の基準日、支払予定、控除の根拠、帳簿・原本データの保存先と保存期間。支払実績は別途追跡が必要。', source: sources.guideline, exemption: false },
  ]
  if (p.subcontract !== 'no' || p.role === 'sub') list.splice(3, 0, { id: 'subcontract', stage: 1, title: '下請・応援の実態', detail: '責任施工範囲、指揮命令、丸投げ・偽装請負の有無を確認。「人工」「応援」という呼び名だけでは判断できません。', evidence: '施工分担と責任者・指示系統が分かる契約／体制図。疑義がある場合は専門家の確認結果。', source: sources.dispatch, exemption: false })
  if (p.existingWork !== 'no') list.splice(list.findIndex((r) => r.id === 'waste'), 0, { id: 'asbestos', stage: 2, title: '解体・改修前の石綿確認', detail: '少額でも事前調査の要否を確認。調査と一定規模以上の報告は別の義務です。対象材料・調査者資格・掲示・必要な届出と措置を確認。', evidence: '事前調査記録・資格・必要な報告控え／作業計画、または調査対象外となる具体的根拠。', source: sources.asbestos, exemption: true })
  return list
}
export function reviewBasis(job: FieldJob) {
  return JSON.stringify({ version: RULE_VERSION, id: job.id, name: job.name, building: job.building, part: job.part, company: job.company, client: job.client, start: job.start, end: job.end, profile: job.complianceProfile ?? emptyProfile, lines: job.paperLines ?? [], dueDate: job.paperDueDate ?? '', tasks: job.tasks.map(({ status: _status, ...task }) => task) })
}
export function validDate(value: string) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value
}
export function validateReview(review: ComplianceReview, job: FieldJob, today: string) {
  const check = requirements(job).find((r) => r.id === review.checkId)
  if (!check || review.ruleVersion !== RULE_VERSION || review.basis !== reviewBasis(job)) throw new Error('工事条件または確認項目が変わりました。最新の条件で記録し直してください。')
  if (profileIssues(job.complianceProfile).length) throw new Error('先に工事条件を入力してください。')
  if (!review.reviewer.trim() || review.note.trim().length < 10) throw new Error('確認者と具体的な確認内容（10文字以上）を入力してください。')
  if (!validDate(review.reviewedOn) || review.reviewedOn > today) throw new Error('確認日は今日以前の実在する日付を指定してください。')
  if (!['documented', 'not-applicable', 'unresolved'].includes(review.conclusion) || (review.conclusion === 'not-applicable' && !check.exemption)) throw new Error('この項目は対象外にはできません。')
  if (!(review.evidence instanceof Blob) || !review.evidence.size || review.evidence.size > 10 * 1024 * 1024 || !['application/pdf', 'image/jpeg', 'image/png'].includes(review.evidence.type) || !review.evidenceName.trim()) throw new Error('根拠資料は10MB以下のPDF・JPEG・PNGを指定してください。')
  if (review.checkId === 'contract' && review.conclusion === 'documented' && (!validDate(review.eventDate) || review.eventDate > job.start || review.eventDate > review.reviewedOn)) throw new Error('双方交付日は確認日以前・工事開始日以前である必要があります。遅れがある場合は「未解決」で記録してください。')
}
export function checkState(job: FieldJob, check: Requirement, today: string) {
  const review = [...(job.complianceReviews ?? [])].reverse().find((r) => r.checkId === check.id)
  if (!review) return { status: 'missing' as const, review }
  try { validateReview(review, job, today) } catch { return { status: 'stale' as const, review } }
  return { status: review.conclusion === 'unresolved' ? 'unresolved' as const : 'recorded' as const, review }
}
export function readiness(job: FieldJob, target: number, today: string) {
  const missingProfile = profileIssues(job.complianceProfile)
  const pending = requirements(job).filter((r) => r.stage <= target && checkState(job, r, today).status !== 'recorded')
  return { missingProfile, pending, canAdvance: missingProfile.length === 0 && pending.length === 0 }
}
export function assertStageChange(previous: FieldJob | undefined, next: FieldJob, today: string) {
  if (!Number.isInteger(next.stage) || next.stage < 0 || next.stage > 3) throw new Error('工事の段階が不正です。')
  if (!previous && next.stage !== 0) throw new Error('新しい工事は相談・見積から登録してください。')
  if (previous && next.stage !== previous.stage) {
    if (next.stage !== previous.stage + 1) throw new Error('工事の段階は一段階ずつ進めてください。')
    const state = readiness(next, next.stage, today)
    if (!state.canAdvance) throw new Error('工事条件・必要な確認記録が不足しています。「工事の確認」を開いてください。')
  }
}
