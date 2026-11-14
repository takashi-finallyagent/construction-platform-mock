import test from 'node:test'
import assert from 'node:assert/strict'
import { emptyProfile, profileIssues, permitSignals, requirements, readiness, reviewBasis, checkState, validateReview, assertStageChange, validDate, RULE_VERSION } from '../src/field/compliance.ts'

const today = '2026-10-22'
const profile = { ...emptyProfile, address: '神奈川県横浜市 サンプル住所', role: 'prime', sector: 'private', category: 'other', trade: '管工事', contractYen: 4_999_999, suppliedYen: 0, relatedYen: 0, subcontract: 'no', existingWork: 'no' }
const job = { id: 'test', name: '検証工事', building: '検証ビル', part: '共用部', company: '検証施工', client: '検証管理', contact: '', stage: 0, start: today, end: today, tasks: [], complianceProfile: profile }
function review(id, overrides = {}, target = job) {
  return { id: crypto.randomUUID(), checkId: id, ruleVersion: RULE_VERSION, basis: reviewBasis(target), reviewer: '検証担当', reviewedOn: today, conclusion: 'documented', note: '試験用の確認内容と根拠資料の記録です。', eventDate: today, evidenceName: 'test.pdf', evidence: new Blob(['%PDF-1.7 test'], { type: 'application/pdf' }), recordedAt: `${today}T00:00:00.000Z`, ...overrides }
}
test('unknown and invalid inputs never mean exempt or zero', () => {
  assert.ok(profileIssues().length >= 9)
  assert.equal(permitSignals().atOrAbove, null)
  for (const value of [null, NaN, Infinity, -1, 1.5, '5000000', Number.MAX_SAFE_INTEGER]) {
    assert.ok(profileIssues({ ...profile, contractYen: value }).length)
    assert.equal(permitSignals({ ...profile, contractYen: value }).atOrAbove, null)
  }
  assert.equal(readiness(job, 1, today).canAdvance, false)
})
test('permit thresholds include equality, supplied materials and split amounts', () => {
  assert.equal(permitSignals(profile).atOrAbove, false)
  assert.equal(permitSignals({ ...profile, suppliedYen: 1 }).atOrAbove, true)
  assert.equal(permitSignals({ ...profile, relatedYen: 1 }).atOrAbove, true)
  assert.equal(permitSignals({ ...profile, category: 'building', contractYen: 14_999_999 }).atOrAbove, false)
  assert.equal(permitSignals({ ...profile, category: 'building', contractYen: 15_000_000 }).atOrAbove, true)
  assert.match(requirements({ ...job, complianceProfile: { ...profile, category: 'building', contractYen: 15_000_000 } })[0].detail, /例外/)
})
test('special permit uses direct prime subcontract total, not received price', () => {
  for (const [category, threshold] of [['other', 50_000_000], ['building', 80_000_000]]) {
    const p = { ...profile, category, subcontract: 'yes', subcontractYen: threshold }
    assert.equal(permitSignals(p).special, true)
    assert.equal(permitSignals({ ...p, subcontractYen: threshold - 1 }).special, false)
    assert.equal(permitSignals({ ...p, role: 'sub' }).special, false)
    assert.equal(permitSignals({ ...p, subcontract: 'no' }).special, false)
  }
  assert.equal(permitSignals({ ...profile, contractYen: 100_000_000 }).special, false)
})
test('public subcontract requires ledger review even below private threshold', () => {
  assert.equal(permitSignals({ ...profile, sector: 'public', subcontract: 'yes', subcontractYen: 100_000 }).ledger, true)
  assert.equal(permitSignals({ ...profile, sector: 'private', subcontract: 'yes', subcontractYen: 100_000 }).ledger, false)
})
test('small renovation still triggers asbestos review; unknown is not exemption', () => {
  for (const existingWork of ['yes', 'unknown']) assert.ok(requirements({ ...job, complianceProfile: { ...profile, existingWork, contractYen: 100_000 } }).some((r) => r.id === 'asbestos'))
  assert.ok(!requirements(job).some((r) => r.id === 'asbestos'))
  assert.ok(requirements({ ...job, complianceProfile: { ...profile, role: 'sub' } }).some((r) => r.id === 'subcontract'))
})
test('evidence, reviewer, date, conclusion and reason are mandatory', () => {
  for (const change of [{ evidence: new Blob() }, { evidence: new Blob(['x'], { type: 'text/plain' }) }, { evidence: new Blob([new Uint8Array(10 * 1024 * 1024 + 1)], { type: 'application/pdf' }) }, { reviewer: ' ' }, { note: '済' }, { reviewedOn: '2026-10-23' }, { reviewedOn: '2026-02-30' }, { conclusion: 'yes' }, { conclusion: 'not-applicable', checkId: 'contract' }]) {
    assert.throws(() => validateReview(review('permit', change), job, today))
  }
  assert.doesNotThrow(() => validateReview(review('permit', { conclusion: 'not-applicable' }), job, today))
})
test('contract delivery cannot be future, after start, or after review', () => {
  for (const eventDate of ['', '2026-10-23', '2026-02-30']) assert.throws(() => validateReview(review('contract', { eventDate }), job, today))
  assert.throws(() => validateReview(review('contract', { reviewedOn: '2026-10-20' }), job, today))
  assert.doesNotThrow(() => validateReview(review('contract', { conclusion: 'unresolved', eventDate: '' }), job, today))
})
test('latest unresolved review blocks even if an older review was recorded', () => {
  const check = requirements(job)[0]
  const target = { ...job, complianceReviews: [review(check.id), review(check.id, { conclusion: 'unresolved' })] }
  assert.equal(checkState(target, check, today).status, 'unresolved')
  assert.equal(readiness(target, 1, today).canAdvance, false)
})
test('conditions, paper price, deadline, scope and rule changes invalidate previous review', () => {
  const check = requirements(job)[0]
  const recorded = { ...job, complianceReviews: [review(check.id)] }
  assert.equal(checkState(recorded, check, today).status, 'recorded')
  for (const change of [{ start: '2026-10-23' }, { company: '別会社' }, { part: '別部位' }, { paperLines: [{ name: '変更', quantity: 1, unit: '式', unitPrice: 100, amount: 100 }] }, { paperDueDate: '2026-11-20' }, { complianceProfile: { ...profile, contractYen: 5_000_000 } }]) assert.equal(checkState({ ...recorded, ...change }, check, today).status, 'stale')
  assert.equal(checkState({ ...recorded, complianceReviews: [review(check.id, { ruleVersion: 'old' })] }, check, today).status, 'stale')
  assert.equal(reviewBasis({ ...job, stage: 1 }), reviewBasis(job))
})
test('only recorded prerequisites permit one-step transitions; later stages recheck earlier records', () => {
  const records = requirements(job).filter((r) => r.stage === 1).map((r) => review(r.id))
  const ready = { ...job, complianceReviews: records }
  assert.equal(readiness(ready, 1, today).canAdvance, true)
  assert.doesNotThrow(() => assertStageChange(ready, { ...ready, stage: 1 }, today))
  assert.throws(() => assertStageChange(ready, { ...ready, stage: 2 }, today))
  assert.throws(() => assertStageChange(job, { ...job, stage: 1 }, today))
  assert.throws(() => assertStageChange(undefined, { ...job, stage: 2 }, today))
  assert.equal(readiness(ready, 2, today).canAdvance, false)
  assert.doesNotThrow(() => assertStageChange({ ...job, stage: 2 }, { ...job, stage: 2 }, today))
})
test('calendar validation distinguishes leap and non-leap dates', () => {
  assert.equal(validDate('2024-02-29'), true)
  for (const value of ['2026-02-29', '2026-13-01', '2026-01-32', 'not-date']) assert.equal(validDate(value), false)
})
