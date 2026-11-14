import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import fs from 'node:fs/promises'
import path from 'node:path'
import { parseArgs } from 'node:util'
import sharp from 'sharp'
import { createAuth } from '../server/auth.ts'
import { readConfig } from '../server/config.ts'
import { createPool } from '../server/db.ts'
import { emptyClassification } from '../src/product/classification-model.ts'
import { storagePath, fileRoot } from '../server/file-storage.ts'

const root = path.resolve(import.meta.dirname, '..')
if (!process.env.DATABASE_ADMIN_URL) process.loadEnvFile(path.join(root, '.env'))
const { values } = parseArgs({ options: { playwright: { type: 'string' }, browser: { type: 'string' }, out: { type: 'string' } } })
const config = readConfig(), database = new URL(process.env.DATABASE_ADMIN_URL)
assert.equal(database.hostname, '127.0.0.1'); assert.equal(new URL(config.origin).hostname, '127.0.0.1')
const { chromium } = createRequire(import.meta.url)(values.playwright || 'playwright')
const output = path.resolve(values.out || path.join(root, 'outputs/workflow-qa-2026-10-26'))
await fs.mkdir(output, { recursive: true })
const pool = createPool(database.href), companyId = randomUUID(), otherCompany = randomUUID()
const runId = randomBytes(10).toString('hex'), password = randomBytes(32).toString('base64url')
const emails = [`owner-${runId}@workflow-qa.invalid`, `viewer-${runId}@workflow-qa.invalid`]
const secrets = [password, ...emails, config.secret, database.href, process.env.DATABASE_URL, database.password].filter(Boolean)
const checks = [], screenshots = [], errors = [], pdfs = [], layoutErrors = []
let browser, page, failure, cleaned = false, job, phase = 'setup'
const clean = error => secrets.reduce((s, secret) => s.replaceAll(secret, '[redacted]'), `${error?.name}: ${error?.message}`).slice(0, 4000)
const pass = name => { checks.push(name); console.log(`PASS ${name}`) }
const button = (scope, name) => scope.getByRole('button', { name, exact: true })
const field = (scope, name) => scope.getByLabel(name, { exact: true })
const endpoint = suffix => `${config.origin}/api/companies/${companyId}/jobs/${job.id}${suffix}`
const known = value => ({ state: 'known', value, reason: null })
const today = new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10)
async function getWorkflow(p = page) {
  const response = await p.context().request.get(endpoint('/workflow')); assert.equal(response.status(), 200)
  return response.json()
}
async function putWorkflow(view, data, p = page) {
  const response = await p.context().request.put(endpoint('/workflow'), { headers: { Origin: config.origin }, data: { version: view.version, jobVersion: view.jobVersion, classificationVersion: view.classificationVersion, data } })
  assert.ok([200, 201].includes(response.status()), await response.text()); return response.json()
}
async function saveBy(action) {
  const promise = page.waitForResponse(r => r.url() === endpoint('/workflow') && r.request().method() === 'PUT')
  await action(); const response = await promise
  assert.ok([200, 201].includes(response.status()), await response.text())
  await button(page, '業務記録を保存').waitFor()
  return response.json()
}
async function selectSection(name) {
  await page.getByRole('navigation', { name: '工事の進め方' }).getByRole('button', { name: new RegExp(name) }).click()
}
async function openJob(p = page) {
  await p.locator('.p-job-row').filter({ hasText: job.name }).click()
  await p.getByRole('tab', { name: '工事を進める', exact: true }).click()
  await p.locator('.w-steps').waitFor()
}
async function login(email) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true, permissions: ['camera'], timezoneId: 'Asia/Tokyo' })
  const p = await context.newPage(); p.setDefaultTimeout(12000)
  p.on('pageerror', e => errors.push(clean(e)))
  await p.goto(`${config.origin}/product.html`)
  await field(p, 'メールアドレス').fill(email); await field(p, 'パスワード').fill(password)
  const response = p.waitForResponse(r => r.url().endsWith('/api/auth/sign-in/email'))
  await button(p, 'ログイン').click(); assert.equal((await response).status(), 200, 'Login failed; rate limits are never cleared')
  await p.getByRole('heading', { name: /工事一覧/ }).waitFor()
  return p
}
async function pdf(action, name) {
  const wait = page.waitForEvent('download'); await action(); const download = await wait
  const target = path.join(output, `${name}.pdf`); await download.saveAs(target)
  assert.equal(await download.failure(), null)
  const bytes = await fs.readFile(target); assert.ok(bytes.length > 1000); assert.equal(bytes.subarray(0, 5).toString(), '%PDF-')
  pdfs.push(path.basename(target))
}
async function snapshot(name) {
  for (const width of [360, 390, 768, 1440]) {
    await page.setViewportSize({ width, height: width < 768 ? 844 : 1000 })
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    const metric = await page.evaluate(() => ({ document: document.documentElement.scrollWidth, body: document.body.scrollWidth, overflowing: [...document.querySelectorAll('body *')].filter(el => { const r = el.getBoundingClientRect(); return r.right > innerWidth + 1 && r.width > 0 && getComputedStyle(el).position !== 'absolute' }).slice(0, 12).map(el => ({ tag: el.tagName, class: el.className, width: el.getBoundingClientRect().width })) }))
    if (metric.document > width + 1 || metric.body > width + 1) {
      const ancestors = await page.locator('.wc-table-scroll,.wc-editor,.wc-workspace,.w-workflow').evaluateAll(elements => elements.map(el => ({ class: el.className, right: el.getBoundingClientRect().right, width: el.getBoundingClientRect().width, scroll: el.scrollWidth, overflow: getComputedStyle(el).overflowX, position: getComputedStyle(el).position })))
      layoutErrors.push({ name, width, ...metric, ancestors })
    }
    const filename = `${name}-${width}.png`; await page.screenshot({ path: path.join(output, filename), fullPage: true, animations: 'disabled' }); screenshots.push(filename)
  }
  await page.setViewportSize({ width: 1440, height: 1000 })
}
async function cleanup() {
  const ids = [companyId, otherCompany]
  const files = (await pool.query('SELECT storage_key FROM job_files WHERE company_id=ANY($1::uuid[])', [ids])).rows
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    // Owner-only cleanup is restricted to this run's synthetic company IDs.
    await client.query("SET LOCAL session_replication_role='replica'")
    const users = (await client.query('SELECT id FROM "user" WHERE email=ANY($1::text[])', [emails])).rows.map(r => r.id)
    for (const table of ['workflow_audit_events', 'job_workflows', 'job_files', 'classification_audit_events', 'job_classifications', 'creation_requests', 'audit_events', 'jobs', 'memberships']) await client.query(`DELETE FROM ${table} WHERE company_id=ANY($1::uuid[])`, [ids])
    await client.query('DELETE FROM companies WHERE id=ANY($1::uuid[])', [ids])
    for (const table of ['session', 'account']) await client.query(`DELETE FROM ${table} WHERE "userId"=ANY($1::text[])`, [users])
    await client.query('DELETE FROM "user" WHERE id=ANY($1::text[])', [users]); await client.query('COMMIT')
  } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
  for (const file of files) {
    const target = path.dirname(storagePath(file.storage_key)), allowed = fileRoot() + path.sep
    assert.ok(target.startsWith(allowed) && path.basename(target) === file.storage_key)
    await fs.rm(target, { recursive: true, force: true })
  }
  cleaned = true
}

try {
  const auth = createAuth(pool, config, true), users = []
  for (const [index, email] of emails.entries()) users.push((await auth.api.signUpEmail({ body: { email, password, name: `業務試験${index}` } })).user)
  await pool.query("INSERT INTO companies(id,name) VALUES($1,'業務試験施工'),($2,'隔離試験施工')", [companyId, otherCompany])
  await pool.query("INSERT INTO memberships(company_id,user_id,role) VALUES($1,$2,'owner'),($1,$3,'viewer')", [companyId, users[0].id, users[1].id])
  browser = await chromium.launch({ executablePath: values.browser, headless: true, args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] })
  page = await login(emails[0])
  const jobResponse = await page.context().request.post(`${config.origin}/api/companies/${companyId}/jobs`, { headers: { Origin: config.origin, 'Idempotency-Key': randomUUID() }, data: { name: '業務試験 玄関修繕', customerName: '試験発注者', siteAddress: '東京都 試験専用住所', workDescription: '玄関扉修繕と動作確認', plannedStart: today, plannedEnd: today } })
  assert.equal(jobResponse.status(), 201); job = await jobResponse.json()
  const cd = emptyClassification()
  for (const [key, value] of Object.entries({ market: 'private', companyRole: 'prime_contractor', workKind: 'repair', targetKind: 'building' })) cd.context[key] = known(value)
  cd.workItems = [{ id: randomUUID(), description: '扉の修繕', tradeCandidates: known(['fittings']), relationship: known('independent'), parentItemId: null }]
  cd.amounts.contract = known({ yen: '11000', taxBasis: 'tax_included' })
  for (const key of ['suppliedMaterials', 'splitContracts', 'subcontracting']) cd.amounts[key] = known('no')
  for (const key of Object.keys(cd.conditions)) cd.conditions[key] = known('no')
  cd.permit.declaration = known('not_held')
  const cr = await page.context().request.put(endpoint('/classification'), { headers: { Origin: config.origin }, data: { version: 0, jobVersion: job.version, data: cd } })
  assert.equal(cr.status(), 201); const cv = await cr.json()
  const png = await sharp({ create: { width: 640, height: 480, channels: 3, background: '#276480' } }).png().toBuffer(), fileId = randomUUID()
  const fr = await page.context().request.put(endpoint(`/files/${fileId}`), { headers: { Origin: config.origin, 'Content-Type': 'image/png', 'x-file-name': encodeURIComponent('確認根拠.png'), 'x-file-kind': 'evidence' }, data: png })
  assert.equal(fr.status(), 201)
  await page.reload(); await openJob()
  phase = 'review'
  await page.locator('.w-issue-list').first().getByRole('button', { name: '記録する', exact: true }).first().click()
  await page.getByRole('combobox', { name: /^確認結果/ }).selectOption('confirmed'); await field(page, '記録内容').fill('試験資料を照合した記録')
  await page.locator('.w-evidence-list').getByLabel('確認根拠.png', { exact: true }).check()
  await saveBy(() => button(page, '確認結果を保存').click())
  let view = await getWorkflow(), data = structuredClone(view.data)
  for (const issue of cv.issues.filter(i => i.kind === 'review')) if (!data.reviews.some(r => r.issueId === issue.id)) data.reviews.push({ id: randomUUID(), issueId: issue.id, classificationVersion: cv.record.version, jobVersion: job.version, conclusion: 'confirmed', reviewedOn: today, evidenceIds: [fileId], note: '試験資料との照合' })
  await putWorkflow(view, data); await page.reload(); await openJob()
  pass('Real review UI appends evidence-backed record; remaining classification fixtures are seeded through the protected API')
  phase = 'estimate'
  await selectSection('見積・契約'); await button(page, '見積を追加').click()
  const estimate = page.getByTestId('estimate-editor')
  await field(estimate, '見積件名').fill('玄関扉修繕 見積'); await field(estimate, '見積発行日').fill(today)
  await field(estimate, '宛先').fill('試験発注者'); await field(estimate, '発行者').fill('業務試験施工')
  await field(estimate, '宛先住所').fill('東京都 発注者住所'); await field(estimate, '発行者住所').fill('東京都 施工者住所')
  await button(estimate, '行を追加').click()
  await field(estimate, '明細1 内容').fill('玄関扉修繕'); await field(estimate, '明細1 単位').fill('式'); await field(estimate, '明細1 単価').fill('10000')
  await button(estimate, '発行する').click(); await saveBy(() => button(estimate, '内容を固定して発行').click())
  assert.equal((await getWorkflow()).data.estimates[0].status, 'issued')
  await pdf(() => page.getByTitle('見積書PDFをダウンロード').click(), 'estimate'); await snapshot('estimate')
  pass('Estimate UI issues immutable itemized amounts and downloads a real PDF')
  phase = 'contract'
  await button(page, 'この見積から契約を作成').click()
  await field(page.getByTestId('contract-editor'), '契約名').fill('玄関修繕 契約書案')
  await field(page.getByTestId('contract-editor'), '契約相手方').fill('試験発注者')
  await saveBy(() => button(page.getByTestId('contract-editor'), '下書きを保存').click())
  view = await getWorkflow(); data = structuredClone(view.data)
  const contract = data.contracts[0]
  contract.effectiveDate = today
  for (const key of Object.keys(contract.terms)) contract.terms[key] = ['startDate', 'endDate', 'handoverDate'].includes(key) ? today : '双方が確認した条件（試験データ）'
  view = await putWorkflow(view, data)
  await page.reload(); await openJob(); await selectSection('見積・契約')
  await page.getByRole('group', { name: '書類の種類' }).getByRole('button', { name: /^契約 / }).click()
  await button(page.getByTestId('contract-editor'), '発行する').click(); await saveBy(() => button(page.getByTestId('contract-editor'), '内容を固定して発行').click())
  await pdf(() => page.getByTitle('契約書PDFをダウンロード').click(), 'contract'); await snapshot('contract')
  pass('Evidence-reviewed contract draft can be fixed through the UI; its PDF remains a contract proposal')
  phase = 'manual exchange'
  const exchange = page.getByRole('region', { name: '契約交換記録' })
  await exchange.locator('summary').filter({ hasText: '交換記録を追加' }).click()
  await field(exchange, '交換記録の日付').fill(today); await field(exchange, '交換の相手方').fill('試験発注者')
  await field(exchange, '交付の方向').selectOption('outgoing'); await field(exchange, '送付者').fill('施工会社 担当者')
  await field(exchange, '受取人').fill('発注者 担当者'); await field(exchange, '交付・送付方法').fill('手渡し')
  await field(exchange, '交換記録の内容・確認方法').fill('署名対象書面を手渡した担当者の記録')
  await exchange.getByRole('checkbox', { name: /確認根拠.png/ }).check()
  await saveBy(() => button(exchange, '交換記録を保存（追記）').click())
  assert.equal((await getWorkflow()).data.contractEvents.length, 1)
  pass('Manual contract exchange records actual sender, recipient, direction, method and evidence without claiming automatic consent')
  phase = 'two consecutive changes'
  const originalContract = (await getWorkflow()).data.contracts[0]
  for (let index = 1; index <= 2; index++) {
    await button(page, 'この契約から変更契約を作成').click()
    const editor = page.getByTestId('contract-editor')
    await field(editor, '契約日').fill(today)
    await field(editor, '変更後の全体額（円）').fill('11000')
    await field(editor, '工期への影響').fill('なし')
    await field(editor, '変更の内容・理由').fill(`施工範囲の説明変更 ${index}回目。全体額と工期は変更なし`)
    await button(editor, '発行する').click(); await saveBy(() => button(editor, '内容を固定して発行').click())
  }
  const changed = (await getWorkflow()).data.contracts
  assert.equal(changed.length, 3); assert.deepEqual(changed[0], originalContract)
  assert.ok(changed.slice(1).every(row => row.status === 'issued' && row.originalContractId === originalContract.id))
  assert.ok(changed[2].changeReason.includes(changed[1].id))
  pass('Two consecutive UI change contracts retain the initial root and preserve all previously issued contracts')
  phase = 'schedule and camera'
  await selectSection('工程・写真'); await page.getByTestId('schedule-add').click()
  await field(page.getByTestId('schedule-task'), '工程名').fill('玄関扉修繕')
  await saveBy(() => page.getByTestId('site-save').click())
  await pdf(() => page.getByTestId('schedule-pdf').click(), 'schedule')
  await page.getByTestId('site-open-camera').click(); await page.getByTestId('site-camera-capture').click()
  await page.getByTestId('photo-server-saved').waitFor(); await button(page, 'カメラを閉じる').click()
  assert.equal((await getWorkflow()).data.photos.length, 1)
  await page.getByTestId('site-open-camera').click()
  await page.context().setOffline(true); await page.getByTestId('site-camera-capture').click()
  await page.locator('[data-testid="photo-outbox-item"][data-durable="true"]').waitFor()
  await button(page, 'カメラを閉じる').click(); await page.context().setOffline(false)
  await page.reload(); await openJob(); await selectSection('工程・写真')
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="site-photo"]').length === 2)
  assert.equal((await getWorkflow()).data.photos.length, 2)
  await page.getByTestId('site-open-camera').click()
  await page.getByTestId('site-camera-dialog').getByRole('button', { name: '完成', exact: true }).click()
  await page.getByTestId('site-native-camera').setInputFiles({ name: '端末カメラ.png', mimeType: 'image/png', buffer: png })
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="site-photo"]').length === 3)
  await button(page, 'カメラを閉じる').click()
  const nativePhoto = (await getWorkflow()).data.photos.find(photo => photo.source === 'device-camera')
  assert.equal(nativePhoto.capturedAt, null); assert.equal(nativePhoto.phase, 'after')
  await snapshot('site')
  pass('Schedule persists; camera saves immediately; offline capture survives reload and sends exactly once to the same job')
  phase = 'deliverables'
  await selectSection('成果・掲示'); await page.getByTestId('deliverable-add').click()
  const notice = page.getByTestId('notice-editor')
  await field(notice, '連絡先電話番号').fill('03-0000-0000'); await field(notice, 'お知らせ本文').fill('玄関扉の修繕工事を実施します。通行の際は誘導に従ってください。')
  page.once('dialog', d => d.accept()); await saveBy(() => page.getByTestId('deliverable-issue').click())
  await pdf(() => page.getByTestId('notice-pdf').click(), 'notice')
  await page.getByRole('button', { name: /^写真台帳 \d/ }).click(); await page.getByTestId('deliverable-add').click()
  for (const checkbox of await page.getByTestId('report-photo-option').getByRole('checkbox').all()) await checkbox.check()
  page.once('dialog', d => d.accept()); await saveBy(() => page.getByTestId('deliverable-issue').click())
  await pdf(() => page.getByTestId('photo-report-pdf').click(), 'photos'); await snapshot('report')
  assert.equal((await getWorkflow()).data.reports[0].photoSnapshot.length, 3)
  pass('Resident notice and photo report issue fixed snapshots and produce protected-photo PDFs')
  phase = 'billing'
  await selectSection('請求・支払'); await button(page, '請求を追加').click()
  const invoice = page.getByTestId('invoice-editor')
  await field(invoice, '請求番号').fill('WF-001'); await field(invoice, '請求発行日').fill(today)
  await field(invoice, '請求宛先').fill('試験発注者'); await field(invoice, '請求発行者').fill('業務試験施工')
  await field(invoice, '対象の発行済み契約').selectOption(contract.id)
  await button(invoice, '契約の見積から明細をコピー').click()
  await field(invoice, '契約で定めた期日').fill(today)
  await invoice.locator('summary').filter({ hasText: '振込先・備考' }).click()
  await field(invoice, '振込先・支払方法の記載').fill('振込（試験口座）')
  await button(invoice, '発行する').click(); await saveBy(() => button(invoice, '内容を固定して発行').click())
  await pdf(() => page.getByTitle('請求書PDFをダウンロード').click(), 'invoice'); await snapshot('invoice')
  pass('Invoice uses the fixed contract estimate, explicit due date and real PDF')
  phase = 'payment and reversal'
  const payments = page.getByRole('region', { name: '入出金実績' })
  await field(payments, '入出金日').fill(today); await field(payments, '実績金額（円）').fill('5000'); await field(payments, '方法').fill('振込')
  await payments.getByRole('checkbox', { name: /確認根拠.png/ }).check()
  await saveBy(() => button(payments, '実績を保存（追記）').click())
  let paid = await getWorkflow(); assert.equal(paid.data.payments.length, 1); assert.equal(paid.data.payments[0].amountYen, '5000')
  await button(payments, 'この実績の取消記録を入力').click()
  await field(payments, '取消日').fill(today); await field(payments, '取消理由（必須）').fill('試験入力の訂正')
  await payments.getByRole('checkbox', { name: /確認根拠.png/ }).check()
  await saveBy(() => button(payments, '取消記録を保存（追記）').click())
  paid = await getWorkflow(); assert.equal(paid.data.payments.length, 2); assert.equal(paid.data.payments[1].reversesId, paid.data.payments[0].id)
  await page.getByRole('group', { name: '請求と工事実績' }).getByRole('button', { name: '完成・引渡し等', exact: true }).click()
  const milestones = page.getByRole('region', { name: '完成・引渡し等の記録' })
  await milestones.locator('summary').filter({ hasText: '実績記録を追加' }).click()
  await field(milestones, '実績の対象契約').selectOption(contract.id); await field(milestones, '工事実績の日付').fill(today)
  await field(milestones, '工事実績の備考').fill('完成を発注者へ通知した記録')
  await milestones.getByRole('checkbox', { name: /確認根拠.png/ }).check()
  await saveBy(() => button(milestones, '実績記録を保存（追記）').click())
  assert.equal((await getWorkflow()).data.milestones.length, 1)
  pass('Evidence-backed partial payment, documented reversal and completion milestone append without altering the originals')
  phase = 'workflow conflict'
  await selectSection('工程・写真')
  await field(page.getByTestId('schedule-task'), '工程名').fill('保持する入力')
  view = await getWorkflow(); data = structuredClone(view.data); data.tasks[0].note = '別担当者による更新'
  await putWorkflow(view, data)
  const conflict = page.waitForResponse(r => r.url() === endpoint('/workflow') && r.request().method() === 'PUT')
  await page.getByTestId('site-save').click(); assert.equal((await conflict).status(), 409)
  assert.equal(await field(page.getByTestId('schedule-task'), '工程名').inputValue(), '保持する入力')
  await button(page, '現在の業務記録を確認').click()
  await button(page, '入力を破棄して現在の内容を表示').waitFor()
  page.once('dialog', d => d.accept()); await button(page, '入力を破棄して現在の内容を表示').click()
  assert.equal(await field(page.getByTestId('schedule-task'), '工程名').inputValue(), '玄関扉修繕')
  assert.equal(await page.getByTestId('schedule-task').getByRole('textbox', { name: /工程の備考/ }).inputValue(), '別担当者による更新')
  pass('A real concurrent update returns 409, retains input, and requires explicit comparison before discarding it')
  phase = 'read-only and reload'
  await page.reload(); await openJob(); await selectSection('請求・支払')
  assert.equal((await getWorkflow()).data.invoices[0].status, 'issued')
  const viewer = await login(emails[1]); await openJob(viewer)
  await viewer.getByRole('navigation', { name: '工事の進め方' }).getByRole('button', { name: /工程・写真/ }).click()
  assert.ok(await viewer.getByTestId('site-open-camera').isDisabled())
  const readonly = await getWorkflow(viewer)
  const forbidden = await viewer.context().request.put(endpoint('/workflow'), { headers: { Origin: config.origin }, data: { version: readonly.version, jobVersion: readonly.jobVersion, classificationVersion: readonly.classificationVersion, data: readonly.data } })
  assert.equal(forbidden.status(), 403)
  const photoId = readonly.data.photos[0].fileId
  assert.equal((await viewer.context().request.get(endpoint(`/files/${photoId}`))).status(), 200)
  const anonymous = await browser.newContext()
  assert.equal((await anonymous.request.get(endpoint(`/files/${photoId}`))).status(), 401); await anonymous.close()
  assert.equal((await page.context().request.get(`${config.origin}/api/companies/${otherCompany}/jobs/${job.id}/files/${photoId}`)).status(), 404)
  assert.equal(errors.length, 0, JSON.stringify(errors))
  assert.equal(layoutErrors.length, 0, JSON.stringify(layoutErrors))
  pass('Reload retains issued data; viewers can read files but cannot mutate; anonymous and other-company file access fail')
} catch (error) {
  failure = { phase, error: clean(error) }
  if (page && !page.isClosed()) try { await page.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }) } catch { /* Preserve original error. */ }
} finally {
  try { await browser?.close() } catch (error) { failure ??= { phase: 'browser cleanup', error: clean(error) } }
  try { await cleanup() } catch (error) { failure ??= { phase: 'fixture cleanup', error: clean(error) } }
  await pool.end()
  const report = { ok: !failure && cleaned, checks, screenshots, pdfs, fixtureCleanup: cleaned, errors, layoutErrors, ...(failure ? { failure } : {}), note: 'Real local API, PostgreSQL and Chrome. Classification and contract terms are seeded through the protected API. Camera uses the Chrome fake device. Responsive emulation is not physical-phone verification. No auth rate limits or existing business data are cleared.' }
  await fs.writeFile(path.join(output, 'results.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify({ ok: report.ok, checks: checks.length, screenshots: screenshots.length, pdfs: pdfs.length, fixtureCleanup: cleaned, failure }, null, 2))
  if (!report.ok) process.exitCode = 1
}
