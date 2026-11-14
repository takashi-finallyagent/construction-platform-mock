// Pure JSON Schema: shared by browser, API and migration 005's limited SQL validator.
type Schema = Record<string, unknown>
const text = (maxLength = 2000): Schema => ({ type: 'string', maxLength })
const choice = (...values: string[]): Schema => ({ type: 'string', enum: values })
const nullable = (s: Schema): Schema => ({ anyOf: [s, { type: 'null' }] })
const object = (properties: Record<string, Schema>): Schema => ({ type: 'object', additionalProperties: false, required: Object.keys(properties), properties })
const array = (items: Schema, maxItems = 200): Schema => ({ type: 'array', maxItems, items })
export const workflowUuid = { type: 'string', pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' }
const ids = { ...array(workflowUuid), uniqueItems: true }
const integer = { type: 'integer' }
const date = { type: 'string', pattern: '^([12][0-9]{3}-[0-9]{2}-[0-9]{2}|)$' }
const timestamp = { type: 'string', pattern: '^[12][0-9]{3}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\\.[0-9]{1,3})?Z$' }
const money = { type: 'string', pattern: '^(0|[1-9][0-9]{0,11})$' }
const job = object({ id: workflowUuid, companyId: workflowUuid, version: integer, name: text(120), siteAddress: text(250), customerName: text(120),
  workDescription: text(), plannedStart: nullable(date), plannedEnd: nullable(date), createdAt: timestamp, updatedAt: timestamp, createdBy: text(200) })
const publication = { status: choice('draft','issued'), issuedAt: nullable(timestamp), issuedBy: nullable(text(200)),
  basis: nullable(object({ job, classificationVersion: nullable(integer) })) }
const line = object({ id: workflowUuid, description: text(500), category: choice('material','labor','welfare','safety','retirement','other'),
  quantity: { type: 'string', pattern: '^(0|[1-9][0-9]{0,8})(\\.[0-9]{1,2})?$' }, unit: text(30), unitPrice: money })
const priced = { items: array(line, 100), taxRate: choice('10','8','0'), rounding: choice('floor','round','ceil') }
const evidence = { evidenceIds: ids, note: text() }
export const photoSchema = object({ id: workflowUuid, fileId: workflowUuid, phase: choice('before','during','after'), caption: text(1000),
  capturedAt: nullable(timestamp), source: choice('camera','device-camera','upload') })
export const contractTermKeys = ['scope','exclusions','startDate','endDate','handoverDate','workingHours','nonWorkingDays','paymentTerms',
  'inspectionTerms','changeTerms','priceChangeTerms','suppliedTerms','thirdPartyDamageTerms','forceMajeureTerms','delayTerms','defectTerms','disputeTerms','riskNotice']
export const workflowSchema = object({
  schemaVersion: { type: 'integer', enum: [1] },
  reviews: array(object({ id: workflowUuid, issueId: { type: 'string', minLength: 1, maxLength: 300 }, classificationVersion: integer, jobVersion: integer,
    conclusion: choice('confirmed','not_applicable','needs_action'), reviewedOn: date, ...evidence })),
  estimates: array(object({ id: workflowUuid, ...publication, title: text(200), recipient: text(200), recipientAddress: text(500), issuer: text(200),
    issuerAddress: text(500), issuedOn: date, validUntil: nullable(date), ...priced, notes: text() })),
  contracts: array(object({ id: workflowUuid, ...publication, title: text(200), estimateId: workflowUuid, kind: choice('initial','change'),
    originalContractId: nullable(workflowUuid), changeReason: text(), effectiveDate: nullable(date), partyRole: choice('receiving','ordering'),
    counterparty: text(200), terms: object(Object.fromEntries(contractTermKeys.map(k => [k, text()]))) })),
  contractEvents: array(object({ id: workflowUuid, contractId: workflowUuid, type: choice('delivered','accepted','change_requested','cancelled'),
    eventDate: date, counterparty: text(200), ...evidence })),
  tasks: array(object({ id: workflowUuid, title: text(200), company: text(200), startsOn: date, endsOn: date, status: choice('planned','active','done'), note: text() })),
  photos: array(photoSchema),
  notices: array(object({ id: workflowUuid, ...publication, kind: choice('construction','change','delay','cancel','complete'), title: text(200),
    recipient: text(200), startsOn: date, endsOn: date, timeFrom: { type: 'string', pattern: '^([0-2][0-9]:[0-5][0-9]|)$' },
    timeTo: { type: 'string', pattern: '^([0-2][0-9]:[0-5][0-9]|)$' }, impacts: array(text(300),20), contactName: text(200), contactPhone: text(100), message: text(4000) })),
  reports: array(object({ id: workflowUuid, ...publication, title: text(200), photoIds: ids, photoSnapshot: nullable(array(photoSchema)), notes: text() })),
  invoices: array(object({ id: workflowUuid, ...publication, number: text(100), direction: choice('receivable','payable'), contractId: workflowUuid,
    recipient: text(200), issuer: text(200), issuedOn: date, dueOn: date, bank: text(1000), registrationNumber: text(100), ...priced, notes: text() })),
  payments: array(object({ id: workflowUuid, invoiceId: workflowUuid, type: choice('payment','reversal'), reversesId: nullable(workflowUuid),
    paidOn: date, amountYen: money, method: text(200), reference: text(300), ...evidence })),
  milestones: array(object({ id: workflowUuid, contractId: workflowUuid, type: choice('completion_notice','inspection','handover_offer','handover','upstream_receipt'),
    eventDate: date, amountYen: nullable(money), ...evidence })),
  laborInsurance: object({ arrangement: choice('unknown','blanket','individual'), principalName: text(200), insuranceNumber: text(100),
    startsOn: nullable(date), endsOn: nullable(date), ...evidence }),
})
