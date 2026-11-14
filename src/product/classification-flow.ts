import type { Answer, ClassificationData, Issue } from './classification-model.ts'

export type ClassificationTarget = { step: 0 | 1 | 2 | 3; field: string; workItemId?: string }
export type ClassificationFlow = {
  nextUnanswered: ClassificationTarget | null
  nextDeferred: ClassificationTarget | null
  unansweredCount: number
  deferredCount: number
}
export const isNo = (answer: Answer<unknown>) => answer.state === 'known' && answer.value === 'no'
export function dependentAnswerMode(inactive: boolean, answer: Answer<unknown>): 'input' | 'saved' | 'hidden' {
  if (!inactive || answer.state === 'known') return 'input'
  return answer.state === 'unanswered' ? 'hidden' : 'saved'
}

const CONTEXT_KEYS = ['market', 'companyRole', 'workKind', 'targetKind'] as const
const CONDITION_KEYS = ['electricalWork', 'existingStructureWork', 'demolitionWork', 'specifiedMaterials', 'constructionWaste', 'structuralChange'] as const
const AMOUNT_KEYS = ['contract', 'suppliedMaterials', 'suppliedMaterialValue', 'suppliedMaterialTransport', 'splitContracts', 'relatedContractValue', 'splitReason', 'subcontracting', 'subcontractTotal'] as const
const MONEY_KEYS = ['contract', 'suppliedMaterialValue', 'suppliedMaterialTransport', 'relatedContractValue', 'subcontractTotal'] as const

export function classificationInputTargets(data: ClassificationData): { unanswered: ClassificationTarget[]; deferred: ClassificationTarget[] } {
  const unanswered: ClassificationTarget[] = [], deferred: ClassificationTarget[] = []
  const add = (step: ClassificationTarget['step'], field: string, answer: Answer<unknown>, workItemId?: string) => {
    const target = { step, field, ...(workItemId ? { workItemId } : {}) }
    if (answer.state === 'unanswered') unanswered.push(target)
    if (answer.state === 'unknown') deferred.push(target)
    if (answer.state === 'known' && answer.value && typeof answer.value === 'object' && 'taxBasis' in answer.value && answer.value.taxBasis === 'unknown') deferred.push({ ...target, field: `${field}.taxBasis` })
  }
  for (const key of CONTEXT_KEYS) add(0, `context.${key}`, data.context[key])
  if (!data.workItems.length) unanswered.push({ step: 1, field: 'workItems' })
  for (const item of data.workItems) {
    add(1, 'workItem.tradeCandidates', item.tradeCandidates, item.id)
    add(1, 'workItem.relationship', item.relationship, item.id)
  }
  const a = data.amounts
  add(2, 'amounts.contract', a.contract)
  for (const [parent, children] of [
    ['suppliedMaterials', ['suppliedMaterialValue', 'suppliedMaterialTransport']],
    ['splitContracts', ['relatedContractValue', 'splitReason']],
    ['subcontracting', ['subcontractTotal']],
  ] as const) {
    add(2, `amounts.${parent}`, a[parent])
    if (!isNo(a[parent])) for (const key of children) add(2, `amounts.${key}`, a[key])
  }
  add(2, 'permit.declaration', data.permit.declaration)
  if (!(data.permit.declaration.state === 'known' && data.permit.declaration.value === 'not_held')) add(2, 'permit.reportedTrades', data.permit.reportedTrades)
  for (const key of CONDITION_KEYS) add(3, `conditions.${key}`, data.conditions[key])
  return { unanswered, deferred }
}

export function deriveClassificationFlow(data: ClassificationData): ClassificationFlow {
  const { unanswered, deferred } = classificationInputTargets(data)
  return { nextUnanswered: unanswered[0] ?? null, nextDeferred: deferred[0] ?? null, unansweredCount: unanswered.length, deferredCount: deferred.length }
}

export function classificationIssueTarget(issue: Issue, savedData: ClassificationData, draftData: ClassificationData): ClassificationTarget | null {
  if (!['FIELD_UNANSWERED', 'FIELD_UNKNOWN', 'SCOPE_REQUIRED', 'OUT_OF_SCOPE'].includes(issue.code)) return null
  if (issue.path === '/workItems') return issue.code === 'SCOPE_REQUIRED' ? { step: 1, field: 'workItems' } : null
  const work = /^\/workItems\/(\d+)\/(tradeCandidates|relationship)$/.exec(issue.path)
  if (work) {
    const id = savedData.workItems[Number(work[1])]?.id
    return id && draftData.workItems.some(item => item.id === id) ? { step: 1, field: `workItem.${work[2]}`, workItemId: id } : null
  }
  const match = /^\/(context|amounts|permit|conditions)\/([A-Za-z]+)(\/value\/taxBasis)?$/.exec(issue.path)
  if (!match) return null
  const [, group, key, tax] = match
  const keys: readonly string[] = group === 'context' ? CONTEXT_KEYS : group === 'amounts' ? AMOUNT_KEYS : group === 'conditions' ? CONDITION_KEYS : ['declaration', 'reportedTrades']
  if (!keys.includes(key)) return null
  if (tax && !(group === 'amounts' && (MONEY_KEYS as readonly string[]).includes(key))) return null
  return { step: group === 'context' ? 0 : group === 'conditions' ? 3 : 2, field: `${group}.${key}${tax ? '.taxBasis' : ''}` }
}
