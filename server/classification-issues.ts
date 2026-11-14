import { emptyClassification, type Answer, type ClassificationData, type ClassificationView, type Issue,
  type JobBasis, type Money, type TradeCode } from '../src/product/classification-model.ts'

const isNo = (a: Answer<unknown>) => a.state === 'known' && a.value === 'no'
const isYes = (a: Answer<unknown>) => a.state === 'known' && a.value === 'yes'
const known = (a: Answer<unknown>, ...values: unknown[]) => a.state === 'known' && values.includes(a.value)
const order = ['JOB_CHANGED','RULES_CHANGED','CATALOG_CHANGED','OUT_OF_SCOPE','FIELD_UNANSWERED','FIELD_UNKNOWN','SCOPE_REQUIRED',
  'TRADE_REVIEW','GENERAL_TRADE_REVIEW','ANCILLARY_REVIEW','PERMIT_REVIEW','AMOUNT_BASIS_REVIEW','TAX_BASIS_REVIEW',
  'SUPPLIED_MATERIAL_REVIEW','SPLIT_CONTRACT_REVIEW','SUBCONTRACT_REVIEW','ELECTRICAL_REVIEW','ASBESTOS_REVIEW',
  'RECYCLING_REVIEW','WASTE_REVIEW','BUILDING_REVIEW','REGIONAL_REVIEW','EVIDENCE_REVIEW'] as const
type Code = typeof order[number]

export function deriveClassificationIssues(savedData: ClassificationData | null, _currentJob: JobBasis,
  staleReasons: ClassificationView['staleReasons']): Issue[] {
  const d = savedData ?? emptyClassification()
  const issues: Issue[] = []
  const add = (code: Code, path: string, kind: Issue['kind'], title: string, sourceIds: string[] = []) => {
    const id = `${code}:${path}`
    if (!issues.some(i => i.id === id)) issues.push({ id,code,path,kind,title,sourceIds })
  }
  const hasTrade = (code: TradeCode) => d.workItems.some(i => i.tradeCandidates.state === 'known' && i.tradeCandidates.value.includes(code))
  if (staleReasons.includes('job_changed')) add('JOB_CHANGED','','stale','工事情報が変わっています')
  if (staleReasons.includes('rules_changed')) add('RULES_CHANGED','','stale','確認基準が更新されています')
  if (staleReasons.includes('catalog_changed')) add('CATALOG_CHANGED','','stale','工事分類が更新されています')
  for (const [key,values] of [['market',['public']],['companyRole',['owner','other']],['workKind',['demolition','new_build','other']],['targetKind',['other']]] as const) {
    if (known(d.context[key],...values)) add('OUT_OF_SCOPE',`/context/${key}`,'out_of_scope','初期対象外の条件です。個別確認が必要です')
  }
  const fields: [string,string,Answer<unknown>][] = [
    ['/context/market','民間・公共の区分',d.context.market], ['/context/companyRole','依頼者との関係',d.context.companyRole],
    ['/context/workKind','工事の種類',d.context.workKind], ['/context/targetKind','工事の対象',d.context.targetKind],
  ]
  d.workItems.forEach((item,index) => fields.push([`/workItems/${index}/tradeCandidates`,'業種候補',item.tradeCandidates],
    [`/workItems/${index}/relationship`,'作業の関係',item.relationship]))
  const a = d.amounts
  const monies: [string,string,Answer<Money>][] = [['/amounts/contract','請負金額',a.contract],
    ['/amounts/suppliedMaterialValue','支給材料の価額',a.suppliedMaterialValue],
    ['/amounts/suppliedMaterialTransport','支給材料の運送費',a.suppliedMaterialTransport],
    ['/amounts/relatedContractValue','関連する分割契約額',a.relatedContractValue],
    ['/amounts/subcontractTotal','下請契約額の合計',a.subcontractTotal]]
  fields.push(['/amounts/contract','請負金額',a.contract],['/amounts/suppliedMaterials','支給材料の有無',a.suppliedMaterials])
  if (!isNo(a.suppliedMaterials)) fields.push([monies[1][0],monies[1][1],a.suppliedMaterialValue],[monies[2][0],monies[2][1],a.suppliedMaterialTransport])
  fields.push(['/amounts/splitContracts','関連する分割契約の有無',a.splitContracts])
  if (!isNo(a.splitContracts)) fields.push([monies[3][0],monies[3][1],a.relatedContractValue],['/amounts/splitReason','分割する理由',a.splitReason])
  fields.push(['/amounts/subcontracting','下請発注の有無',a.subcontracting])
  if (!isNo(a.subcontracting)) fields.push([monies[4][0],monies[4][1],a.subcontractTotal])
  fields.push(['/permit/declaration','建設業許可の申告',d.permit.declaration])
  if (!known(d.permit.declaration,'not_held')) fields.push(['/permit/reportedTrades','申告する許可業種',d.permit.reportedTrades])
  const conditionLabels = { electricalWork: '電気工事の有無', existingStructureWork: '既存物への工事の有無', demolitionWork: '解体部分の有無',
    specifiedMaterials: '特定建設資材の有無', constructionWaste: '廃材の有無', structuralChange: '構造に関わる変更の有無' }
  for (const key of Object.keys(conditionLabels) as (keyof typeof conditionLabels)[]) fields.push([`/conditions/${key}`,conditionLabels[key],d.conditions[key]])
  for (const [path,label,answer] of fields) {
    if (answer.state === 'unanswered') add('FIELD_UNANSWERED',path,'missing',`${label}を入力してください`)
    if (answer.state === 'unknown') add('FIELD_UNKNOWN',path,'unknown',`${label}が不明です`)
    if (answer.state === 'known' && answer.value && typeof answer.value === 'object'
      && 'taxBasis' in answer.value && answer.value.taxBasis === 'unknown') {
      add('FIELD_UNKNOWN',`${path}/value/taxBasis`,'unknown',`${label}の税区分が不明です`)
    }
  }
  for (const [path,,answer] of monies) {
    if (answer.state === 'known' && answer.value.taxBasis === 'tax_excluded') add('TAX_BASIS_REVIEW',path,'review','税込金額と税の取扱いを確認',['L03'])
  }
  if (!d.workItems.length) add('SCOPE_REQUIRED','/workItems','missing','今回請け負う作業を入力してください',['L01'])
  d.workItems.forEach((item,index) => {
    const path = `/workItems/${index}`
    add('TRADE_REVIEW',path,'review','工事範囲と業種候補を確認',['L01','L02'])
    if (item.tradeCandidates.state === 'known' && item.tradeCandidates.value.some(c => c === 'civil_general' || c === 'building_general')) {
      add('GENERAL_TRADE_REVIEW',`${path}/tradeCandidates`,'review','一式工事に該当する根拠を確認',['L01','L02'])
    }
    if (known(item.relationship,'ancillary')) add('ANCILLARY_REVIEW',`${path}/relationship`,'review','主たる工事との関係と附帯工事の根拠を確認',['L01'])
  })
  add('PERMIT_REVIEW','/permit','review','工事業種に対応する許可と有効性を確認',['L01','L03'])
  add('AMOUNT_BASIS_REVIEW','/amounts','review','請負額・税・支給材・分割契約の集計範囲を確認',['L01','L03'])
  if (!isNo(a.suppliedMaterials)) add('SUPPLIED_MATERIAL_REVIEW','/amounts/suppliedMaterials','review','支給材料の有無・価額・運送費を確認',['L01'])
  if (!isNo(a.splitContracts)) add('SPLIT_CONTRACT_REVIEW','/amounts/splitContracts','review','関連する分割契約と分割理由を確認',['L01'])
  if (!isNo(a.subcontracting)) add('SUBCONTRACT_REVIEW','/amounts/subcontracting','review','下請契約の範囲と一般・特定の許可条件を確認',['L01','L03'])
  const c=d.conditions
  if (!isNo(c.electricalWork) || hasTrade('electrical')) add('ELECTRICAL_REVIEW','/conditions/electricalWork','review','電気工事の範囲・事業の登録届出・作業者資格を確認',['L06'])
  if (!isNo(c.existingStructureWork) || !isNo(c.demolitionWork) || known(d.context.workKind,'repair','renovation','demolition')) {
    add('ASBESTOS_REVIEW','/conditions/existingStructureWork','review','石綿の事前調査・調査者資格・報告等を確認',['L07'])
  }
  if (!isNo(c.specifiedMaterials) || !isNo(c.demolitionWork) || known(d.context.workKind,'demolition')) {
    add('RECYCLING_REVIEW','/conditions/specifiedMaterials','review','特定建設資材・工事規模・契約記載・届出を確認',['L08'])
  }
  if (!isNo(c.constructionWaste) || isYes(c.demolitionWork)) add('WASTE_REVIEW','/conditions/constructionWaste','review','廃材の処理方法と委託先・記録を確認',['L08'])
  if (!isNo(c.structuralChange) || hasTrade('building_general') || known(d.context.workKind,'new_build')) {
    add('BUILDING_REVIEW','/conditions/structuralChange','review','修繕範囲と建築確認等の要否を確認',['L09'])
  }
  add('REGIONAL_REVIEW','','review','現場所在地に応じた手続・施工条件を確認')
  add('EVIDENCE_REVIEW','','review','根拠資料と確認責任者の記録が必要です')
  return issues.sort((a,b) => order.indexOf(a.code as Code)-order.indexOf(b.code as Code))
}
