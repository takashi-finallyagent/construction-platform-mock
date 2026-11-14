import test from 'node:test'
import assert from 'node:assert/strict'
import { activeEvents, addDays, appendPaymentEvent, assessPayment, emptyTerms, monthDeadline, PAYMENT_RULE_VERSION, revisePaymentCase } from '../src/field/payment.ts'

let sequence = 0
const record = () => ({ id: `record-${++sequence}`, recorder: '担当者', note: '契約原本と実行済み資料を照合して記録', recordedAt: '2026-10-22T03:00:00Z', evidenceName: '' })
function item(overrides = {}) {
  return revisePaymentCase(undefined, 'case-1', { ...record(), previousId: null, ruleVersion: PAYMENT_RULE_VERSION, terms: { ...emptyTerms, counterparty: '下請A', scope: '契約001・玄関ドア工事', amountYen: 100000, payerPermit: 'special', payeeSpecial: 'no', payeeSize: 'small', agreement: 'agreed', schedule: [{ date: '2026-12-31', amountYen: 100000 }], handoverTerm: 'none', ...overrides } })
}
function event(kind, date, amountYen = null, patch = {}) {
  return { ...record(), kind, date, amountYen, voids: null, ...(kind === 'payment' ? { evidence: new Blob(['receipt'], { type: 'application/pdf' }), evidenceName: 'receipt.pdf' } : {}), ...patch }
}
function append(value, ...events) { return events.reduce((current, next) => appendPaymentEvent(current, next, '2026-10-22'), value) }
function completed(overrides) {
  return append(item(overrides), event('completion', '2026-08-30'), event('inspection', '2026-08-31'), event('offer', '2026-09-01'))
}

test('calendar-month deadline excludes receipt day, including leap/month/year boundaries', () => {
  for (const [date, expected] of [['2026-01-15', '2026-02-15'], ['2026-01-30', '2026-02-28'], ['2026-01-31', '2026-02-28'], ['2026-02-28', '2026-03-31'], ['2024-01-30', '2024-02-29'], ['2024-02-28', '2024-03-28'], ['2024-02-29', '2024-03-31'], ['2026-04-30', '2026-05-31'], ['2026-12-31', '2027-01-31']]) assert.equal(monthDeadline(date), expected, date)
  assert.throws(() => monthDeadline('2026-02-29'))
  assert.throws(() => addDays('invalid', 20))
})
test('inspection uses 20 days excluding notification day; preserves late completion', () => {
  let value = append(item(), event('completion', '2026-09-01'))
  assert.equal(assessPayment(value, '2026-09-21').inspection.due, '2026-09-21')
  assert.equal(assessPayment(value, '2026-09-21').inspection.late, false)
  assert.equal(assessPayment(value, '2026-09-14').inspection.attention, true)
  assert.equal(assessPayment(value, '2026-09-13').inspection.attention, false)
  assert.equal(assessPayment(value, '2026-09-22').inspection.late, true)
  value = append(value, event('inspection', '2026-09-22'))
  assert.equal(assessPayment(value, '2026-10-22').inspection.late, true)
  assert.equal(assessPayment(value, '2026-10-22').inspection.attention, false)
})
test('50 days includes offer day, while invoice data is not required', () => {
  const result = assessPayment(completed(), '2026-10-22')
  assert.equal(result.deadlines.find((d) => d.id === 'fifty').date, '2026-10-20')
  assert.equal(result.deadlines.find((d) => d.id === 'fifty').provisional, false)
  assert.equal(result.overdueYen, 100000)
})
test('ordinary contractor and large/special payees do not trigger 50 days', () => {
  for (const patch of [{ payerPermit: 'general' }, { payeeSize: 'large' }, { payeeSpecial: 'yes' }]) assert.ok(!assessPayment(completed(patch), '2026-10-22').deadlines.some((d) => d.id === 'fifty'))
  assert.ok(assessPayment(completed({ payeeSize: 'individual' }), '2026-10-22').deadlines.some((d) => d.id === 'fifty'))
})
test('unknown conditions and handover exceptions remain provisional, never extend automatically', () => {
  for (const patch of [{ payerPermit: 'unknown' }, { payeeSize: 'unknown' }, { handoverTerm: 'fixed' }, { handoverTerm: 'unknown' }]) {
    const state = assessPayment(completed(patch), '2026-10-22')
    assert.equal(state.deadlines.find((d) => d.id === 'fifty').provisional, true)
    assert.equal(state.deadlines.find((d) => d.id === 'fifty').date, '2026-10-20')
    assert.ok(state.issues.length)
  }
})
test('no agreed due date uses offer day for 24-6(2), not the maximum 50 days', () => {
  const value = completed({ agreement: 'unset', schedule: [] })
  const state = assessPayment(value, '2026-10-22')
  assert.equal(state.deadlines.find((d) => d.id === 'unset').date, '2026-09-01')
  assert.equal(state.deadlines.find((d) => d.id === 'unset').provisional, false)
  assert.equal(state.next.date, '2026-09-01')
  assert.equal(assessPayment(completed({ agreement: 'unknown', schedule: [] }), '2026-10-22').deadlines.find((d) => d.id === 'unset').provisional, true)
})
test('earlier contract date remains actionable regardless of upstream receipt', () => {
  const state = assessPayment(item({ schedule: [{ date: '2026-10-01', amountYen: 100000 }] }), '2026-10-22')
  assert.equal(state.next.date, '2026-10-01')
  assert.equal(state.overdueYen, 100000)
})
test('competing cumulative obligations are not added together or applied to unrelated work', () => {
  const value = append(completed({ schedule: [{ date: '2026-09-15', amountYen: 30000 }, { date: '2026-12-31', amountYen: 70000 }] }), event('receipt', '2026-08-31', 40000), event('receipt', '2026-09-10', 20000), event('payment', '2026-09-20', 20000))
  const state = assessPayment(value, '2026-10-11')
  assert.equal(state.overdueYen, 40000)
  assert.equal(state.remainingYen, 80000)
  assert.equal(state.deadlines.find((d) => d.label.startsWith('入金') && d.date === '2026-10-10').amountYen, 60000)
  assert.equal(assessPayment(item(), '2026-10-11').paidYen, 0)
})
test('partial and late payments retain deadline deficits after full payment', () => {
  const value = append(completed(), event('payment', '2026-10-20', 40000), event('payment', '2026-10-21', 60000))
  const state = assessPayment(value, '2026-10-22')
  assert.equal(state.remainingYen, 0)
  assert.equal(state.overdueYen, 0)
  assert.equal(state.deadlines.find((d) => d.id === 'fifty').lateYen, 60000)
  assert.equal(state.lateHistory, true)
})
test('deadline day is not yet overdue and weekends are not extended', () => {
  const value = append(item(), event('receipt', '2026-08-20', 50000))
  assert.equal(assessPayment(value, '2026-09-20').next.date, '2026-09-20')
  assert.equal(assessPayment(value, '2026-09-20').overdueYen, 0)
  assert.equal(assessPayment(value, '2026-09-21').overdueYen, 50000)
})
test('unlicensed payer is not automatically subjected to licensed-contractor deadlines', () => {
  const state = assessPayment(append(completed({ payerPermit: 'none' }), event('receipt', '2026-09-01', 50000)), '2026-10-22')
  assert.equal(state.inspection.due, null)
  assert.deepEqual(state.deadlines.map((d) => d.label), ['契約期日'])
  assert.ok(state.issues.some((issue) => issue.includes('許可なし')))
})
test('validates totals, statuses and stale revision writes', () => {
  assert.throws(() => item({ amountYen: -1 }))
  assert.throws(() => item({ schedule: [] }))
  assert.throws(() => item({ schedule: [{ date: '2026-02-29', amountYen: 100000 }] }))
  assert.throws(() => item({ schedule: [{ date: '2026-10-01', amountYen: 99999 }] }))
  assert.throws(() => item({ payerPermit: 'fake' }))
  const value = item()
  assert.throws(() => revisePaymentCase(value, value.id, { ...value.revisions[0], id: 'new', previousId: null }))
  assert.throws(() => revisePaymentCase(value, value.id, { ...value.revisions[0], id: 'new', previousId: value.revisions[0].id, ruleVersion: 'obsolete' }))
})
test('rejects future dates, duplicate events, overpayment and unsupported evidence', () => {
  const value = append(item(), event('payment', '2026-10-01', 90000))
  assert.throws(() => append(value, event('payment', '2026-10-01', 10001)))
  assert.throws(() => append(value, event('payment', '2026-10-23', 100)))
  assert.throws(() => append(value, event('payment', '2026-10-01', -1)))
  assert.throws(() => append(value, event('payment', '2026-10-01', 0.5)))
  assert.throws(() => append(value, event('payment', '2026-10-01', 100, { evidence: undefined })))
  assert.throws(() => append(value, event('payment', '2026-10-01', 100, { evidence: new Blob(['wrong'], { type: 'text/html' }) })))
  assert.throws(() => append(value, value.events[0]))
  assert.throws(() => append(item(), event('receipt', '2026-10-01', 100001)))
})
test('inspection needs completion notice; duplicate base dates must be corrected explicitly', () => {
  assert.throws(() => append(item(), event('inspection', '2026-10-01')))
  assert.throws(() => append(item(), event('completion', '2026-10-02'), event('inspection', '2026-10-01')))
  assert.throws(() => append(completed(), event('offer', '2026-09-02')))
  const state = assessPayment(append(item(), event('offer', '2026-09-01')), '2026-10-22')
  assert.ok(state.issues.some((issue) => issue.includes('完成検査')))
  assert.equal(state.deadlines.find((d) => d.id === 'fifty').provisional, true)
})
test('correction appends an event without deleting evidence or old values', () => {
  const paid = event('payment', '2026-10-01', 100000)
  const value = append(completed(), paid)
  const corrected = append(value, event('void', '2026-10-22', null, { voids: paid.id }))
  assert.equal(assessPayment(corrected, '2026-10-22').paidYen, 0)
  assert.equal(corrected.events.length, value.events.length + 1)
  assert.equal(corrected.events.find((e) => e.id === paid.id).evidence.size, paid.evidence.size)
  assert.throws(() => append(corrected, event('void', '2026-10-22', null, { voids: paid.id })))
  assert.throws(() => append(corrected, event('void', '2026-10-22', null, { voids: corrected.events.at(-1).id })))
  assert.equal(activeEvents(value).length, 4)
})
test('term revisions preserve all history and reject reductions below settled amounts', () => {
  const value = append(item(), event('payment', '2026-10-01', 90000))
  const revision = { ...record(), previousId: value.revisions[0].id, ruleVersion: PAYMENT_RULE_VERSION, terms: { ...value.revisions[0].terms, scope: '変更契約を追加した工事' } }
  const updated = revisePaymentCase(value, value.id, revision)
  assert.equal(updated.revisions.length, 2)
  assert.equal(updated.events.length, 1)
  assert.equal(updated.revisions[0].terms.scope, value.revisions[0].terms.scope)
  assert.throws(() => revisePaymentCase(value, value.id, { ...revision, terms: { ...revision.terms, amountYen: 80000, schedule: [{ date: '2026-12-31', amountYen: 80000 }] } }))
})
test('rule changes and inspection after offer never present confirmed legal dates', () => {
  const value = completed()
  value.revisions[0].ruleVersion = 'old'
  assert.ok(assessPayment(value, '2026-10-22').deadlines.every((deadline) => deadline.provisional))
  const inspectedLater = append(item(), event('completion', '2026-09-01'), event('offer', '2026-09-02'), event('inspection', '2026-09-03'))
  assert.equal(assessPayment(inspectedLater, '2026-10-22').deadlines.find((deadline) => deadline.id === 'fifty').provisional, true)
  assert.throws(() => append(item(), event('toString', '2026-09-01')))
})
