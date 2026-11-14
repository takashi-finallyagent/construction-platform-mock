import test from 'node:test'
import assert from 'node:assert/strict'
import { classificationInputTargets, classificationIssueTarget, dependentAnswerMode, deriveClassificationFlow } from '../src/product/classification-flow.ts'
import { emptyClassification } from '../src/product/classification-model.ts'
import { deriveClassificationIssues } from '../server/classification-issues.ts'

const known = value => ({ state: 'known', value, reason: null })
const unknown = () => ({ state: 'unknown', value: null, reason: null })
const na = () => ({ state: 'not_applicable', value: null, reason: '以前の確認理由' })
const item = id => ({ id, description: '建具の修繕', tradeCandidates: unknown(), relationship: unknown(), parentItemId: null })
const issue = (path, code = 'FIELD_UNKNOWN') => ({ id: `${code}:${path}`, code, path, kind: 'unknown', title: '確認', sourceIds: [] })

test('fresh rendering has deterministic next input, no default answers, and never mutates data', () => {
  const data = emptyClassification(), before = structuredClone(data)
  const flow = deriveClassificationFlow(data)
  assert.deepEqual(flow.nextUnanswered, { step: 0, field: 'context.market' })
  assert.equal(flow.deferredCount, 0)
  assert.deepEqual(data, before)
  data.context = Object.fromEntries(Object.entries(data.context).reverse())
  assert.deepEqual(deriveClassificationFlow(data), flow)
})

test('unanswered takes priority over explicit deferred and both remain distinct', () => {
  const data = emptyClassification()
  data.context.market = unknown()
  const flow = deriveClassificationFlow(data)
  assert.equal(flow.nextUnanswered.field, 'context.companyRole')
  assert.equal(flow.nextDeferred.field, 'context.market')
  assert.equal(flow.deferredCount, 1)
})

test('parent no skips all five children without manufacturing exclusions or destroying answers', () => {
  const data = emptyClassification(), initial = deriveClassificationFlow(data).unansweredCount
  for (const key of ['suppliedMaterials', 'splitContracts', 'subcontracting']) data.amounts[key] = known('no')
  data.amounts.suppliedMaterialTransport = unknown()
  data.amounts.splitReason = na()
  const before = structuredClone(data)
  const flow = deriveClassificationFlow(data)
  assert.equal(flow.unansweredCount, initial - 8)
  assert.equal(flow.deferredCount, 0)
  assert.deepEqual(data, before)
  data.amounts.suppliedMaterials = known('yes')
  assert.equal(deriveClassificationFlow(data).deferredCount, 1)
  assert.equal(data.amounts.suppliedMaterialTransport.state, 'unknown')
})

test('unknown parents do not silently exclude unresolved children', () => {
  const data = emptyClassification()
  data.amounts.suppliedMaterials = unknown()
  const fields = classificationInputTargets(data).unanswered.map(t => t.field)
  assert.ok(fields.includes('amounts.suppliedMaterialValue'))
  assert.ok(fields.includes('amounts.suppliedMaterialTransport'))
})

test('inactive known answers stay visible as contradictions and old NA reasons stay referable', () => {
  assert.equal(dependentAnswerMode(true, known({ yen: '1', taxBasis: 'tax_excluded' })), 'input')
  assert.equal(dependentAnswerMode(true, unknown()), 'saved')
  assert.equal(dependentAnswerMode(true, na()), 'saved')
  assert.equal(dependentAnswerMode(true, emptyClassification().amounts.contract), 'hidden')
  assert.equal(dependentAnswerMode(false, na()), 'input')
})

test('not held skips only permit trades, retaining all historical values', () => {
  const data = emptyClassification()
  data.permit.declaration = known('not_held'); data.permit.reportedTrades = unknown()
  const before = structuredClone(data)
  assert.ok(!classificationInputTargets(data).deferred.some(t => t.field === 'permit.reportedTrades'))
  assert.deepEqual(data, before)
  data.permit.declaration = known('held')
  assert.ok(classificationInputTargets(data).deferred.some(t => t.field === 'permit.reportedTrades'))
})

test('tax unknown remains a separate unresolved target without changing money', () => {
  const data = emptyClassification()
  data.amounts.contract = known({ yen: '0', taxBasis: 'unknown' })
  const before = structuredClone(data)
  assert.deepEqual(deriveClassificationFlow(data).nextDeferred, { step: 2, field: 'amounts.contract.taxBasis' })
  assert.deepEqual(data, before)
  data.amounts.contract.value.taxBasis = 'tax_excluded'
  assert.equal(deriveClassificationFlow(data).deferredCount, 0)
  assert.equal(data.amounts.contract.value.yen, '0')
})

test('issue indexes resolve through saved work IDs, never through reordered draft positions', () => {
  const saved = emptyClassification()
  saved.workItems = [item('a'), item('b')]
  const draft = structuredClone(saved); draft.workItems.reverse()
  assert.equal(classificationIssueTarget(issue('/workItems/0/tradeCandidates'), saved, draft).workItemId, 'a')
  draft.workItems = [item('b')]
  assert.equal(classificationIssueTarget(issue('/workItems/0/tradeCandidates'), saved, draft), null)
  assert.equal(classificationIssueTarget(issue('/workItems/999/relationship'), saved, draft), null)
})

test('only recognized input paths are jumpable, unknown issues cannot become selectors', () => {
  const data = emptyClassification()
  assert.deepEqual(classificationIssueTarget(issue('/amounts/contract/value/taxBasis'), data, data), { step: 2, field: 'amounts.contract.taxBasis' })
  for (const path of ['/context/constructor', '/permit/note', '/amounts/splitReason/value/taxBasis', '/context/market/value/taxBasis', '/workItems/-1/tradeCandidates', '/arbitrary']) {
    assert.equal(classificationIssueTarget(issue(path), data, data), null)
  }
  assert.equal(classificationIssueTarget(issue('/context/market', 'FUTURE_REVIEW'), data, data), null)
})

test('all entered answers means no input tasks, not legal completion or permit exemption', () => {
  const data = emptyClassification()
  data.context = { market: known('private'), companyRole: known('prime_contractor'), workKind: known('repair'), targetKind: known('building') }
  data.workItems = [{ ...item('a'), tradeCandidates: known(['fittings']), relationship: known('primary') }]
  for (const key of ['suppliedMaterials', 'splitContracts', 'subcontracting']) data.amounts[key] = known('no')
  data.permit.declaration = known('not_held')
  for (const key of Object.keys(data.conditions)) data.conditions[key] = known('no')
  for (const yen of ['0', '4999999', '5000000', '5000001']) {
    data.amounts.contract = known({ yen, taxBasis: 'tax_included' })
    assert.equal(deriveClassificationFlow(data).unansweredCount, 0)
    assert.equal(deriveClassificationFlow(data).deferredCount, 0)
    const issues = deriveClassificationIssues(data, {}, [])
    for (const code of ['PERMIT_REVIEW', 'AMOUNT_BASIS_REVIEW', 'ASBESTOS_REVIEW', 'EVIDENCE_REVIEW']) assert.ok(issues.some(i => i.code === code))
  }
})
