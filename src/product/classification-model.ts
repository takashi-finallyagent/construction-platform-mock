export const CATALOG_VERSION = 'construction-trades-2026-10-23.1'
export const RULES_VERSION = 'p04-2026-10-23.1'
export const TRADE_CATALOG = [
  { code: 'civil_general', label: '土木一式工事', kind: 'general' },
  { code: 'building_general', label: '建築一式工事', kind: 'general' },
  { code: 'carpentry', label: '大工工事', kind: 'specialty' },
  { code: 'plastering', label: '左官工事', kind: 'specialty' },
  { code: 'scaffolding_earthwork_concrete', label: 'とび・土工・コンクリート工事', kind: 'specialty' },
  { code: 'stone', label: '石工事', kind: 'specialty' },
  { code: 'roofing', label: '屋根工事', kind: 'specialty' },
  { code: 'electrical', label: '電気工事', kind: 'specialty' },
  { code: 'plumbing', label: '管工事', kind: 'specialty' },
  { code: 'tile_brick_block', label: 'タイル・れんが・ブロック工事', kind: 'specialty' },
  { code: 'steel_structure', label: '鋼構造物工事', kind: 'specialty' },
  { code: 'reinforcing_steel', label: '鉄筋工事', kind: 'specialty' },
  { code: 'paving', label: '舗装工事', kind: 'specialty' },
  { code: 'dredging', label: 'しゅんせつ工事', kind: 'specialty' },
  { code: 'sheet_metal', label: '板金工事', kind: 'specialty' },
  { code: 'glass', label: 'ガラス工事', kind: 'specialty' },
  { code: 'painting', label: '塗装工事', kind: 'specialty' },
  { code: 'waterproofing', label: '防水工事', kind: 'specialty' },
  { code: 'interior_finishing', label: '内装仕上工事', kind: 'specialty' },
  { code: 'machinery_installation', label: '機械器具設置工事', kind: 'specialty' },
  { code: 'thermal_insulation', label: '熱絶縁工事', kind: 'specialty' },
  { code: 'telecommunications', label: '電気通信工事', kind: 'specialty' },
  { code: 'landscaping', label: '造園工事', kind: 'specialty' },
  { code: 'well_drilling', label: 'さく井工事', kind: 'specialty' },
  { code: 'fittings', label: '建具工事', kind: 'specialty' },
  { code: 'water_facilities', label: '水道施設工事', kind: 'specialty' },
  { code: 'fire_protection', label: '消防施設工事', kind: 'specialty' },
  { code: 'sanitation_facilities', label: '清掃施設工事', kind: 'specialty' },
  { code: 'demolition', label: '解体工事', kind: 'specialty' },
] as const
export type TradeCode = typeof TRADE_CATALOG[number]['code']
export type Answer<T> =
  | { state: 'unanswered'; value: null; reason: null }
  | { state: 'unknown'; value: null; reason: null }
  | { state: 'known'; value: T; reason: null }
  | { state: 'not_applicable'; value: null; reason: string }
export type YesNo = 'yes' | 'no'
export type Money = { yen: string; taxBasis: 'tax_included' | 'tax_excluded' | 'unknown' }
export type WorkItem = { id: string; description: string; tradeCandidates: Answer<TradeCode[]>;
  relationship: Answer<'primary' | 'ancillary' | 'independent'>; parentItemId: string | null }
export type ClassificationData = {
  schemaVersion: 1;
  context: { market: Answer<'private' | 'public'>; companyRole: Answer<'prime_contractor' | 'subcontractor' | 'owner' | 'other'>;
    workKind: Answer<'repair' | 'renovation' | 'demolition' | 'new_build' | 'other'>; targetKind: Answer<'building' | 'structure' | 'other'> };
  workItems: WorkItem[];
  amounts: { contract: Answer<Money>; suppliedMaterials: Answer<YesNo>; suppliedMaterialValue: Answer<Money>;
    suppliedMaterialTransport: Answer<Money>; splitContracts: Answer<YesNo>; relatedContractValue: Answer<Money>;
    splitReason: Answer<string>; subcontracting: Answer<YesNo>; subcontractTotal: Answer<Money> };
  permit: { declaration: Answer<'held' | 'not_held' | 'renewal_pending'>; reportedTrades: Answer<TradeCode[]>; note: string };
  conditions: { electricalWork: Answer<YesNo>; existingStructureWork: Answer<YesNo>; demolitionWork: Answer<YesNo>;
    specifiedMaterials: Answer<YesNo>; constructionWaste: Answer<YesNo>; structuralChange: Answer<YesNo> };
  note: string;
}
export type ClassificationPut = { version: number; jobVersion: number; data: ClassificationData }
export type JobBasis = { version: number; name: string; siteAddress: string; customerName: string; workDescription: string;
  plannedStart: string | null; plannedEnd: string | null }
export type ActorSnapshot = { id: string; name: string }
export type ClassificationRecord = { companyId: string; jobId: string; version: number; data: ClassificationData;
  basisJob: JobBasis; rulesVersion: string; catalogVersion: string; createdBy: ActorSnapshot; createdAt: string;
  updatedBy: ActorSnapshot; updatedAt: string }
export type Issue = { id: string; code: string; path: string; kind: 'missing' | 'unknown' | 'review' | 'out_of_scope' | 'stale';
  title: string; sourceIds: string[] }
export type JobDifference = { field: 'name' | 'siteAddress' | 'customerName' | 'workDescription' | 'plannedStart' | 'plannedEnd';
  saved: string | null; current: string | null }
export type ClassificationView = { companyId: string; jobId: string; currentJob: JobBasis; record: ClassificationRecord | null;
  currentRulesVersion: string; currentCatalogVersion: string; staleReasons: ('job_changed' | 'rules_changed' | 'catalog_changed')[];
  jobDifferences: JobDifference[]; issues: Issue[] }
export type ClassificationAuditEvent = { id: string; companyId: string; jobId: string; targetVersion: number; requestId: string;
  actorId: string; actorName: string; action: 'classification.created' | 'classification.updated'; occurredAt: string;
  beforeData: ClassificationRecord | null; afterData: ClassificationRecord }
export type ClassificationAuditPage = { events: ClassificationAuditEvent[]; nextCursor: string | null }

export function emptyClassification(): ClassificationData {
  const answer = (): Answer<never> => ({ state: 'unanswered', value: null, reason: null })
  return { schemaVersion: 1,
    context: { market: answer(), companyRole: answer(), workKind: answer(), targetKind: answer() }, workItems: [],
    amounts: { contract: answer(), suppliedMaterials: answer(), suppliedMaterialValue: answer(), suppliedMaterialTransport: answer(),
      splitContracts: answer(), relatedContractValue: answer(), splitReason: answer(), subcontracting: answer(), subcontractTotal: answer() },
    permit: { declaration: answer(), reportedTrades: answer(), note: '' },
    conditions: { electricalWork: answer(), existingStructureWork: answer(), demolitionWork: answer(), specifiedMaterials: answer(),
      constructionWaste: answer(), structuralChange: answer() }, note: '' }
}
