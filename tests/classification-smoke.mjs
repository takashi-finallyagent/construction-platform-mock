import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import fs from 'node:fs/promises'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { createAuth } from '../server/auth.ts'
import { readConfig } from '../server/config.ts'
import { createPool } from '../server/db.ts'

const root = path.resolve(import.meta.dirname, '..')
if (!process.env.DATABASE_ADMIN_URL) process.loadEnvFile(path.join(root, '.env'))
const { values } = parseArgs({ options: { playwright: { type: 'string' }, browser: { type: 'string' }, out: { type: 'string' } } })
const config = readConfig()
const database = new URL(process.env.DATABASE_ADMIN_URL)
const local = host => ['127.0.0.1', 'localhost', '[::1]'].includes(host)
assert.ok(local(database.hostname) && local(new URL(config.origin).hostname), 'Only a local fixture database and application are permitted')
const { chromium } = createRequire(import.meta.url)(values.playwright || 'playwright')
const output = path.resolve(values.out || path.join(root, 'outputs/classification-qa-2026-10-23'))
await fs.mkdir(output, { recursive: true })
const pool = createPool(database.href)
const runId = randomBytes(10).toString('hex')
const emails = [`owner-${runId}@classification-qa.invalid`, `viewer-${runId}@classification-qa.invalid`]
const password = randomBytes(32).toString('base64url')
const secrets = [password, ...emails, config.secret, process.env.DATABASE_ADMIN_URL, process.env.DATABASE_URL, database.password].filter(Boolean)
const companies = [randomUUID(), randomUUID()]
const names = ['分類試験 第一施工', '分類試験 第二施工']
const checks = [], screenshots = [], runtimeErrors = [], consoleMessages = [], pending = new Set()
let browser, activePage, failure, cleaned = false, phase = 'setup'
const redact = error => {
  let value = `${error?.name || 'Error'}: ${error?.message || 'Operation failed'}`
  for (const secret of secrets) value = value.replaceAll(secret, '[redacted]')
  return value.slice(0, 4000)
}
const pass = name => { checks.push(name); console.log(`PASS ${name}`) }
const button = (page, name) => page.getByRole('button', { name, exact: true })
const field = (page, name) => page.getByLabel(name, { exact: true })
const tab = (page, name) => page.getByRole('tab', { name: /^[1-4]/.test(name) ? new RegExp(name.slice(1)) : name, exact: true })
const base = (jobId, companyId = companies[0]) => `${config.origin}/api/companies/${companyId}/jobs/${jobId}`
const classification = (jobId, companyId) => `${base(jobId, companyId)}/classification`
const input = { name: '分類試験 玄関修繕', customerName: '分類試験発注者', siteAddress: '東京都 分類試験専用所在地', workDescription: '玄関建具と配線の修繕', plannedStart: '2026-11-01', plannedEnd: '2026-11-03' }
async function makePage(state) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce', serviceWorkers: 'block', ...(state ? { storageState: state } : {}) })
  const page = await context.newPage(); page.setDefaultTimeout(12000); activePage = page
  page.on('pageerror', error => runtimeErrors.push(redact(error)))
  page.on('console', message => consoleMessages.push(message.text()))
  return page
}
async function login(page, email) {
  await page.goto(`${config.origin}/product.html`)
  await field(page, 'メールアドレス').fill(email); await field(page, 'パスワード').fill(password)
  const response = page.waitForResponse(r => r.url().endsWith('/api/auth/sign-in/email'))
  await button(page, 'ログイン').click()
  assert.equal((await response).status(), 200, 'Real login must succeed; no rate-limit rows are removed on failure')
}
async function company(page, index = 0) {
  await page.getByRole('heading', { name: '会社を選択', exact: true }).waitFor()
  await page.locator('.p-company-option').filter({ hasText: names[index] }).click()
  await page.getByRole('heading', { name: /工事一覧/ }).waitFor()
}
async function open(page, name = input.name) {
  await page.locator('.p-job-row').filter({ hasText: name }).click()
  await page.getByRole('heading', { name, exact: true }).waitFor()
}
async function classificationTab(page) {
  await tab(page, '契約前の確認').click()
  await page.locator('.c-classification > .c-heading').waitFor()
}
async function reopen(page, name = input.name) {
  await button(page, '工事一覧に戻る').click(); await open(page, name); await classificationTab(page)
}
async function get(context, jobId) {
  const response = await context.request.get(classification(jobId)); assert.equal(response.status(), 200)
  return response.json()
}
async function put(context, jobId, view, data = view.record.data) {
  const response = await context.request.put(classification(jobId), { headers: { Origin: config.origin }, data: { version: view.record?.version ?? 0, jobVersion: view.currentJob.version, data } })
  assert.ok([200, 201].includes(response.status()), `Real fixture classification PUT returned ${response.status()}`)
  return response.json()
}
async function save(page, expected = 200, action = '途中まで保存') {
  const response = page.waitForResponse(r => r.url().endsWith('/classification') && r.request().method() === 'PUT')
  await button(page, action).click()
  assert.equal((await response).status(), expected)
  if (expected < 300) await page.getByText('入力内容を保存しました。', { exact: true }).waitFor()
}
async function saveWithBusyGuard(page, jobId, expected) {
  let release, arrive
  const gate = new Promise(resolve => { release = resolve }), arrival = new Promise(resolve => { arrive = resolve })
  pending.add(release)
  await page.route(classification(jobId), async route => {
    const response = await route.fetch(); arrive(); await gate; await route.fulfill({ response })
  }, { times: 1 })
  const response = page.waitForResponse(r => r.url() === classification(jobId) && r.request().method() === 'PUT')
  await button(page, '保存して次へ').click(); await arrival
  assert.equal(await tab(page, '1工事条件').getAttribute('aria-selected'), 'true')
  assert.ok(await button(page, '保存して次へ').isDisabled())
  let guarded = false
  page.once('dialog', async dialog => { guarded = true; await dialog.dismiss() })
  await tab(page, '基本情報').click(); assert.ok(guarded, 'Saving unchanged answers also guards navigation')
  release(); pending.delete(release); assert.equal((await response).status(), expected)
  await page.locator('#c-step-panel-1').waitFor()
}
async function reveal(page, locator) {
  for (const details of await page.locator('details').filter({ has: locator }).all()) {
    if (await details.getAttribute('open') === null) await details.locator(':scope > summary').click()
  }
}
const known = value => ({ state: 'known', value, reason: null })
const unknown = () => ({ state: 'unknown', value: null, reason: null })
async function snapshot(page, name) {
  for (const width of [360, 390, 768, 1440]) {
    await page.setViewportSize({ width, height: width < 768 ? 844 : 1000 })
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    const metrics = await page.evaluate(() => ({ width: innerWidth, document: document.documentElement.scrollWidth, body: document.body.scrollWidth }))
    assert.ok(metrics.document <= width + 1 && metrics.body <= width + 1, `Overflow: ${JSON.stringify(metrics)}`)
    const filename = `${name}-${width}.png`
    await page.screenshot({ path: path.join(output, filename), fullPage: true, animations: 'disabled', mask: [page.locator('input[type=password],input[name=email]')] }); screenshots.push(filename)
  }
  await page.setViewportSize({ width: 1440, height: 1000 })
}
async function createJob(context, data, companyId = companies[0]) {
  const response = await context.request.post(`${config.origin}/api/companies/${companyId}/jobs`, { headers: { Origin: config.origin, 'Idempotency-Key': randomUUID() }, data })
  assert.equal(response.status(), 201); return response.json()
}
async function cleanup() {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const users = (await client.query('SELECT id FROM "user" WHERE email=ANY($1::text[])', [emails])).rows.map(r => r.id)
    for (const table of ['classification_audit_events', 'job_classifications', 'creation_requests', 'audit_events', 'jobs', 'memberships']) {
      const exists = (await client.query('SELECT to_regclass($1) IS NOT NULL AS present', [`public.${table}`])).rows[0].present
      if (exists) await client.query(`DELETE FROM ${table} WHERE company_id=ANY($1::uuid[])`, [companies])
    }
    await client.query('DELETE FROM companies WHERE id=ANY($1::uuid[])', [companies])
    for (const table of ['session', 'account']) await client.query(`DELETE FROM ${table} WHERE "userId"=ANY($1::text[])`, [users])
    await client.query('DELETE FROM "user" WHERE id=ANY($1::text[])', [users])
    assert.equal((await client.query('SELECT count(*)::integer AS n FROM companies WHERE id=ANY($1::uuid[])', [companies])).rows[0].n, 0)
    assert.equal((await client.query('SELECT count(*)::integer AS n FROM "user" WHERE email=ANY($1::text[])', [emails])).rows[0].n, 0)
    await client.query('COMMIT'); cleaned = true
  } catch (error) { await client.query('ROLLBACK'); throw error }
  finally { client.release() }
}

try {
  const health = await fetch(`${config.origin}/api/health`, { signal: AbortSignal.timeout(10000) }); assert.equal(health.status, 200)
  assert.equal((await pool.query("SELECT to_regclass('public.job_classifications') IS NOT NULL AND to_regclass('public.classification_audit_events') IS NOT NULL AS ready")).rows[0].ready, true, 'Parent must apply the classification migration before this integration test')
  const auth = createAuth(pool, config, true)
  const owner = (await auth.api.signUpEmail({ body: { email: emails[0], password, name: '分類試験 管理者' } })).user
  const viewer = (await auth.api.signUpEmail({ body: { email: emails[1], password, name: '分類試験 閲覧者' } })).user
  await pool.query('INSERT INTO companies(id,name) VALUES($1,$2),($3,$4)', [companies[0], names[0], companies[1], names[1]])
  await pool.query("INSERT INTO memberships(company_id,user_id,role) VALUES($1,$2,'owner'),($3,$2,'manager'),($1,$4,'viewer')", [companies[0], owner.id, companies[1], viewer.id])
  browser = await chromium.launch({ executablePath: values.browser, headless: true })
  const page = await makePage(); await login(page, emails[0]); await company(page)
  const ownerContext = page.context(); const ownerState = await ownerContext.storageState()
  for (const cookie of ownerState.cookies) secrets.push(cookie.value)
  const job = await createJob(ownerContext, input)
  const secondJob = await createJob(ownerContext, { ...input, name: '分類試験 第二工事' }, companies[1])
  const emptyJob = await createJob(ownerContext, { ...input, name: '分類試験 未保存' })
  await button(page, '一覧を再読み込み').click(); await open(page); await classificationTab(page)
  const second = await makePage(ownerState); await second.goto(`${config.origin}/product.html`); await company(second); await open(second); await classificationTab(second)
  activePage = page
  phase = 'unanswered and initial concurrent save'
  assert.equal(await field(page, '工事の区分').inputValue(), 'unanswered')
  assert.equal(await page.locator('.c-form select').count(), 4, 'Enumerated answers each use one select')
  assert.ok(await field(page, '工事の区分').locator('option[value=unanswered]').isDisabled())
  assert.equal((await get(ownerContext, job.id)).record, null, 'Opening inputs never invents saved answers')
  await field(page, '工事の区分').selectOption('unknown'); await save(page, 201)
  let view = await get(ownerContext, job.id)
  assert.equal(view.record.data.context.market.state, 'unknown'); assert.equal(view.record.data.context.workKind.state, 'unanswered')
  await field(second, '工事の区分').selectOption('private'); await save(second, 409)
  assert.equal(await field(second, '工事の区分').inputValue(), 'private')
  assert.ok(await button(second, '途中まで保存').isDisabled())
  await button(second, '現在の保存内容を確認').click()
  await second.getByRole('heading', { name: '編集開始時の回答', exact: true }).waitFor()
  assert.ok((await second.getByRole('region', { name: '保存結果の照合' }).innerText()).includes('未入力'))
  await button(second, '比較を確認し、保持した入力で編集を続ける').click(); await save(second)
  assert.equal((await get(ownerContext, job.id)).record.version, 2)
  pass('Unanswered/unknown are distinct; one-select enumeration; first version-0 conflict retains input and requires explicit comparison')

  phase = 'inline errors, trade search and Unicode limits'
  await reopen(page)
  await field(page, '当社の立場').selectOption('prime_contractor'); await field(page, '工事の目的').selectOption('repair'); await field(page, '施工対象').selectOption('building')
  await tab(page, '2施工範囲').click(); await button(page, '施工範囲を追加').click()
  await button(page, '途中まで保存').click()
  assert.equal(await field(page, '施工範囲 1の施工内容').getAttribute('aria-invalid'), 'true')
  assert.ok(await page.getByText('施工内容を入力してください。不要な施工範囲は削除できます。', { exact: true }).isVisible())
  const supplementary = String.fromCodePoint(0x20bb7)
  const unicodeDescription = supplementary.repeat(300)
  await field(page, '施工範囲 1の施工内容').fill(unicodeDescription)
  assert.equal([...(await field(page, '施工範囲 1の施工内容').inputValue())].length, 300)
  assert.equal(await page.getByLabel(/回答状態/).count(), 0, 'No state dropdown before direct input')
  assert.equal(await page.locator('.c-trade-results button').count(), 0, 'No static list of 29 trades')
  await field(page, '施工範囲 1の候補業種を検索').fill('建具'); await button(page, '建具工事').click()
  await button(page, '建具工事を外す').click(); await save(page)
  assert.equal((await get(ownerContext, job.id)).record.data.workItems[0].tradeCandidates.state, 'unanswered', 'Removing the final candidate never creates a known empty array')
  await field(page, '施工範囲 1の候補業種を検索').fill('建具'); await button(page, '建具工事').click()
  await field(page, '施工範囲 1の関係').selectOption('ancillary'); await button(page, '途中まで保存').click()
  assert.equal(await field(page, '施工範囲 1の附帯先').getAttribute('aria-invalid'), 'true')
  await field(page, '施工範囲 1の関係').selectOption('primary'); await snapshot(page, 'work-items')
  assert.equal(await page.locator('.c-classification [role=alert]').count(), 0, 'Correcting the inputs clears the outdated validation notice')
  await tab(page, '3金額と許可').click()
  await field(page, '当社が受ける今回の請負額の金額').fill('1')
  await field(page, '当社が受ける今回の請負額の金額').fill(''); await button(page, '途中まで保存').click()
  assert.equal(await field(page, '当社が受ける今回の請負額の金額').getAttribute('aria-invalid'), 'true')
  await field(page, '当社が受ける今回の請負額の金額').fill('1,000'); await button(page, '途中まで保存').click()
  assert.ok(await page.getByText(/円単位の半角数字/).first().isVisible())
  await field(page, '当社が受ける今回の請負額の金額').fill('0')
  await field(page, '発注者からの材料支給').selectOption('no')
  await field(page, '関連する分割契約').selectOption('no'); await field(page, '当社からの下請発注').selectOption('no')
  for (const label of ['支給材料の価額', '支給材料の運送費', '関連する分割契約額（今回分を除く）', '当社が発注する下請契約額の合計']) assert.equal(await field(page, `${label}の金額`).count(), 0)
  const unicodeReason = supplementary.repeat(300)
  await field(page, '建設業許可の保有申告').selectOption('held')
  await button(page, '許可の対象と考える工事を後で確認する').click()
  await reveal(page, field(page, '許可に関する補足'))
  await field(page, '許可に関する補足').fill(`  ${supplementary.repeat(1000)}  `)
  await snapshot(page, 'amounts')
  await tab(page, '4関連条件').click()
  assert.equal(await field(page, '電気工事を含む').inputValue(), 'unanswered')
  await field(page, '電気工事を含む').selectOption('unknown'); await field(page, '建設廃棄物が発生する').selectOption('yes')
  const unicodeNote = supplementary.repeat(2000)
  await field(page, '補足').fill(unicodeNote)
  await save(page)
  view = await get(ownerContext, job.id)
  assert.equal(view.record.data.workItems[0].description, unicodeDescription)
  assert.equal(view.record.data.amounts.contract.value.yen, '0')
  assert.equal(view.record.data.amounts.contract.value.taxBasis, 'tax_included', 'New input is explicitly labeled tax inclusive')
  assert.equal(view.record.data.amounts.suppliedMaterialValue.state, 'unanswered', 'Parent no never invents an NA answer')
  assert.equal([...view.record.data.permit.note].length, 1000, 'Unicode code-point limit is measured after trim, as on the server')
  assert.equal(view.record.data.note, unicodeNote)
  const legacy = structuredClone(view.record.data)
  legacy.amounts.contract.value.taxBasis = 'unknown'
  legacy.amounts.suppliedMaterialValue = { state: 'not_applicable', value: null, reason: unicodeReason }
  legacy.amounts.suppliedMaterialTransport = unknown()
  view = await put(ownerContext, job.id, view, legacy)
  await reopen(page); await tab(page, '4関連条件').click()
  assert.equal(await field(page, '補足').inputValue(), unicodeNote)
  await tab(page, '3金額と許可').click()
  await reveal(page, field(page, '許可に関する補足'))
  assert.equal(await field(page, '許可に関する補足').inputValue(), supplementary.repeat(1000), 'The exact permit-note label remains usable after remounting saved text')
  assert.equal(await field(page, '当社が受ける今回の請負額の税区分').inputValue(), 'unknown')
  await field(page, '当社が受ける今回の請負額の金額').fill('1'); await save(page)
  assert.equal((await get(ownerContext, job.id)).record.data.amounts.contract.value.taxBasis, 'unknown', 'Editing old money never reinterprets unknown tax as inclusive')
  await button(page, '保存した確認事項を見る').click()
  await page.getByRole('region', { name: '資料で確認する事項', exact: true }).locator('details > summary').click()
  assert.ok(await page.getByRole('link', { name: '環境省：排出事業者責任', exact: true }).isVisible())
  await snapshot(page, 'related-and-issues')
  await button(page, '回答を編集').click()
  await tab(page, '3金額と許可').click(); await field(page, '発注者からの材料支給').selectOption('yes'); await button(page, '途中まで保存').click()
  assert.equal(await field(page, '支給材料の価額の対象外の理由').getAttribute('aria-invalid'), 'true')
  assert.equal(await field(page, '支給材料の価額の対象外の理由').inputValue(), unicodeReason)
  await field(page, '発注者からの材料支給').selectOption('no')
  await reveal(page, field(page, '支給材料の価額の対象外の理由'))
  await field(page, '支給材料の価額の対象外の理由').fill(''); await button(page, '途中まで保存').click()
  assert.ok(await page.getByText('対象外とした理由を入力してください。', { exact: true }).isVisible())
  await field(page, '支給材料の価額の対象外の理由').fill(unicodeReason)
  await field(page, '発注者からの材料支給').selectOption('no')
  await save(page)
  assert.equal((await get(ownerContext, job.id)).record.data.amounts.suppliedMaterialValue.reason, unicodeReason)
  pass('Field-local errors identify descriptions/trades/parent/money/NA contradictions; valid astral-character limits, zero money and four answer states round-trip through real API/PG')

  phase = 'dirty navigation and keyboard'
  await tab(page, '4関連条件').click(); await field(page, '補足').fill('移動前の未保存入力')
  for (const action of [() => tab(page, '基本情報').click(), () => tab(page, '変更履歴').click(), () => button(page, '編集').click(), () => button(page, '工事一覧に戻る').click(), () => button(page, '会社を切り替え').click(), () => button(page, 'ログアウト').click()]) {
    let prompted = false
    page.once('dialog', async dialog => { prompted = true; await dialog.dismiss() })
    await action(); assert.ok(prompted, 'Every data-losing navigation asks before discarding')
    assert.equal(await field(page, '補足').inputValue(), '移動前の未保存入力')
  }
  await save(page)
  await tab(page, '4関連条件').focus(); await page.keyboard.press('Home')
  assert.equal(await tab(page, '1工事条件').getAttribute('aria-selected'), 'true')
  await snapshot(page, 'context')
  assert.equal(await page.locator('.p-enter').first().evaluate(el => getComputedStyle(el).animationName), 'none')
  pass('Dirty guards cover both main tabs, basic edit, back, company switch and logout; keyboard stage navigation and reduced motion work at 360/390/768/1440 widths')

  phase = 'stale job basis'
  const before = await get(ownerContext, job.id)
  const patch = await ownerContext.request.patch(base(job.id), { headers: { Origin: config.origin }, data: { ...input, siteAddress: '変更後の分類試験所在地', version: before.currentJob.version } })
  assert.equal(patch.status(), 200)
  await reopen(page)
  assert.ok(await button(page, '途中まで保存').isDisabled())
  const review = page.getByRole('region', { name: '工事前提の再確認' })
  assert.ok((await review.innerText()).includes(input.siteAddress)); assert.ok((await review.innerText()).includes('変更後の分類試験所在地'))
  await snapshot(page, 'stale-basis')
  assert.equal((await get(ownerContext, job.id)).record.basisJob.version, before.record.basisJob.version)
  await button(page, '工事情報を再確認し、回答を見直す').click()
  assert.equal((await get(ownerContext, job.id)).record.version, before.record.version, 'Acknowledging a new basis does not PUT automatically')
  await save(page)
  view = await get(ownerContext, job.id); assert.equal(view.record.basisJob.version, before.currentJob.version + 1)
  assert.ok(!view.staleReasons.includes('job_changed'))
  pass('Job edits preserve original basis, show old/current values, stop save and require an explicit reviewed save')

  phase = 'committed response loss'
  await tab(page, '4関連条件').click(); await field(page, '補足').fill('応答消失の確認')
  let committed = false
  await page.route(classification(job.id), async route => {
    if (route.request().method() !== 'PUT') return route.continue()
    const response = await route.fetch(); assert.equal(response.status(), 200); committed = true; await route.abort('failed')
  }, { times: 1 })
  await button(page, '保存して確認事項へ').click(); await page.getByRole('heading', { name: '保存結果は不明です', exact: true }).waitFor(); assert.ok(committed)
  assert.equal(await page.locator('.c-results').count(), 0, 'Uncertain writes never advance to the results screen')
  assert.equal(await field(page, '補足').inputValue(), '応答消失の確認'); assert.ok(await button(page, '途中まで保存').isDisabled())
  await button(page, '現在の保存内容を確認').click(); await page.getByRole('heading', { name: '直前の送信内容', exact: true }).waitFor()
  await snapshot(page, 'lost-response-comparison')
  const committedVersion = (await get(ownerContext, job.id)).record.version
  await button(page, '比較を確認し、保持した入力で編集を続ける').click()
  assert.equal((await get(ownerContext, job.id)).record.version, committedVersion)
  await save(page); assert.equal((await get(ownerContext, job.id)).record.version, committedVersion + 1)
  pass('Real committed PUT with response loss retains input, blocks retries, compares start/sent/current/input, and resumes only on explicit action')

  phase = 'first version-0 response loss'
  const firstLoss = await createJob(ownerContext, { ...input, name: '分類試験 初回応答消失' })
  await button(page, '工事一覧に戻る').click(); await open(page, firstLoss.name); await classificationTab(page)
  await field(page, '工事の区分').selectOption('unknown')
  let firstCommitted = false
  await page.route(classification(firstLoss.id), async route => {
    const response = await route.fetch(); assert.equal(response.status(), 201); firstCommitted = true; await route.abort('failed')
  }, { times: 1 })
  await button(page, '途中まで保存').click(); await page.getByRole('heading', { name: '保存結果は不明です', exact: true }).waitFor()
  assert.ok(firstCommitted); assert.ok(await button(page, '途中まで保存').isDisabled())
  await button(page, '現在の保存内容を確認').click(); await page.getByRole('heading', { name: '編集開始時の回答', exact: true }).waitFor()
  assert.equal((await get(ownerContext, firstLoss.id)).record.version, 1)
  await button(page, '比較を確認し、保持した入力で編集を続ける').click(); await save(page)
  assert.equal((await get(ownerContext, firstLoss.id)).record.version, 2)
  assert.equal(await field(page, '工事の区分').inputValue(), 'unknown')
  await button(page, '工事一覧に戻る').click(); await open(page); await classificationTab(page)
  pass('First version-0 PUT with committed response loss also retains unknown input and cannot be retried until explicit comparison')

  phase = 'guided save and conditional inputs'
  const guided = await createJob(ownerContext, { ...input, name: '分類試験 入力導線' })
  await button(page, '工事一覧に戻る').click(); await open(page, guided.name)
  await button(page, '契約前の確認へ進む').click(); await page.locator('.c-classification > .c-heading').waitFor()
  await field(page, '工事の区分').selectOption('private'); await field(page, '当社の立場').selectOption('prime_contractor')
  await field(page, '工事の目的').selectOption('repair'); await field(page, '施工対象').selectOption('building')
  await saveWithBusyGuard(page, guided.id, 201)
  assert.equal(await page.locator('#c-step-panel-1').evaluate(el => document.activeElement === el), true)
  await button(page, '施工範囲を追加').click(); await field(page, '施工範囲 1の施工内容').fill('玄関建具の修繕')
  await field(page, '施工範囲 1の候補業種を検索').fill('建具'); await button(page, '建具工事').click()
  await field(page, '施工範囲 1の関係').selectOption('primary'); await save(page, 200, '保存して次へ')
  await field(page, '当社が受ける今回の請負額の金額').fill('5000000')
  for (const label of ['発注者からの材料支給', '関連する分割契約', '当社からの下請発注']) await field(page, label).selectOption('no')
  await field(page, '建設業許可の保有申告').selectOption('not_held')
  assert.equal(await field(page, '許可の対象と考える工事を検索').count(), 0)
  assert.equal(await field(page, '支給材料の価額の対象外の理由').count(), 0)
  await snapshot(page, 'guided-amounts')
  await save(page, 200, '保存して次へ')
  for (const label of ['電気工事を含む', '既存の建物・工作物に手を加える', '解体・撤去を含む', '特定建設資材を扱う', '建設廃棄物が発生する', '構造を変更する']) await field(page, label).selectOption(label === '既存の建物・工作物に手を加える' ? 'yes' : 'no')
  await save(page, 200, '保存して確認事項へ')
  await page.getByRole('heading', { name: '回答を保存しました', exact: true }).waitFor()
  assert.ok(await page.getByText('未入力 0件 · 未確認 0件', { exact: true }).isVisible())
  assert.ok(await button(page, '確認記録・見積へ進む').isVisible())
  assert.equal(await page.locator('.c-results h3').evaluate(el => document.activeElement === el), true)
  let guidedView = await get(ownerContext, guided.id)
  assert.ok(guidedView.issues.some(i => i.code === 'PERMIT_REVIEW'))
  assert.ok(guidedView.issues.some(i => i.code === 'AMOUNT_BASIS_REVIEW'))
  assert.equal(guidedView.record.data.amounts.suppliedMaterialValue.state, 'unanswered')
  await snapshot(page, 'guided-results')
  await button(page, '基本情報に戻る').click(); await page.locator('.p-detail-grid').waitFor()
  await button(page, '契約前の確認へ進む').click(); await page.locator('.c-classification > .c-heading').waitFor()
  assert.equal((await get(ownerContext, guided.id)).record.version, guidedView.record.version)
  await saveWithBusyGuard(page, guided.id, 200)
  guidedView = await get(ownerContext, guided.id)
  pass('Save-and-next waits for confirmed persistence, guards busy navigation, skips no-children and reaches an honest results screen with a working return action')

  phase = 'legacy tax, child preservation and next field focus'
  const historical = structuredClone(guidedView.record.data)
  historical.amounts.contract.value.taxBasis = 'unknown'
  historical.amounts.subcontracting = known('yes'); historical.amounts.subcontractTotal = known({ yen: '123', taxBasis: 'tax_excluded' })
  historical.permit.declaration = known('held'); historical.permit.reportedTrades = known(['fittings'])
  historical.conditions.electricalWork = unknown()
  guidedView = await put(ownerContext, guided.id, guidedView, historical)
  await reopen(page, guided.name); await button(page, '保存した確認事項を見る').click()
  assert.ok(await page.getByText('未入力 0件 · 未確認 2件', { exact: true }).isVisible())
  await button(page, '確認して入力').click()
  assert.equal(await field(page, '当社が受ける今回の請負額の税区分').evaluate(el => document.activeElement === el), true)
  await field(page, '当社が受ける今回の請負額の金額').fill('888')
  await field(page, '当社が発注する下請契約額の合計の金額').fill('124')
  await field(page, '当社からの下請発注').selectOption('no'); await button(page, '途中まで保存').click()
  assert.equal(await field(page, '当社が発注する下請契約額の合計の金額').getAttribute('aria-invalid'), 'true')
  assert.equal(await field(page, '当社が発注する下請契約額の合計の金額').inputValue(), '124')
  await field(page, '当社からの下請発注').selectOption('yes')
  await field(page, '建設業許可の保有申告').selectOption('not_held'); await button(page, '途中まで保存').click()
  assert.ok(await field(page, '許可の対象と考える工事を検索').isVisible())
  assert.ok(await button(page, '建具工事を外す').isVisible())
  await field(page, '建設業許可の保有申告').selectOption('held'); await save(page)
  guidedView = await get(ownerContext, guided.id)
  assert.deepEqual(guidedView.record.data.amounts.contract.value, { yen: '888', taxBasis: 'unknown' })
  assert.deepEqual(guidedView.record.data.amounts.subcontractTotal.value, { yen: '124', taxBasis: 'tax_excluded' })
  await button(page, '保存した確認事項を見る').click()
  await page.locator('.c-pending-list > summary').click(); await button(page, '電気工事を含む').click()
  assert.equal(await field(page, '電気工事を含む').evaluate(el => document.activeElement === el), true)
  await button(page, '工事一覧に戻る').click(); await open(page); await classificationTab(page)
  pass('Old tax values survive remount and editing; parent/permit changes never erase existing answers; remaining-input actions focus exact tax and condition fields')

  phase = 'classification history pagination'
  view = await get(ownerContext, job.id)
  while (view.record.version < 102) view = await put(ownerContext, job.id, view, { ...view.record.data, note: `履歴試験 ${view.record.version + 1}` })
  await reopen(page); await button(page, '回答の変更履歴').click()
  await page.locator('[data-classification-version]').nth(49).waitFor()
  const expectedVersions = view.record.version
  view = await put(ownerContext, job.id, view, { ...view.record.data, note: 'ページ取得中に追加した版' })
  await page.route(`${classification(job.id)}/audit?*`, route => route.abort('failed'), { times: 1 })
  await button(page, '以前の回答履歴を表示').click(); await button(page, '回答履歴の取得を再試行').waitFor()
  assert.equal(await page.locator('[data-classification-version]').count(), 50)
  await button(page, '回答履歴の取得を再試行').click(); await page.locator('[data-classification-version]').nth(99).waitFor()
  await button(page, '以前の回答履歴を表示').click(); await page.getByText('最初の回答履歴まで表示しました。', { exact: true }).waitFor()
  const versions = await page.locator('[data-classification-version]').evaluateAll(elements => elements.map(el => Number(el.getAttribute('data-classification-version'))))
  assert.deepEqual(versions, Array.from({ length: expectedVersions }, (_, index) => expectedVersions - index))
  await page.locator('[data-classification-version="1"] > details > summary').click()
  assert.ok((await page.locator('[data-classification-version="1"]').innerText()).includes('未確認'))
  assert.ok(!(await page.locator('[data-classification-version="1"]').innerText()).includes('schemaVersion'))
  await snapshot(page, 'history')
  pass('102 historical versions paginate 50/50/2 without gaps while a new version is inserted; failed page retains entries and retries; answers use Japanese labels')

  phase = 'abnormal response isolation'
  const real = await get(ownerContext, job.id)
  for (const [name, mutate] of [['company', v => { v.companyId = companies[1] }], ['job', v => { v.jobId = secondJob.id }], ['schema', v => { v.record.data.schemaVersion = 999 }], ['record company', v => { v.record.companyId = companies[1] }]]) {
    phase = `abnormal response isolation: ${name}`
    await tab(page, '基本情報').click()
    const malformed = structuredClone(real); mutate(malformed)
    // StrictMode can abort the first mount GET; inject every GET until this case is observed.
    const respond = route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(malformed) })
    await page.route(classification(job.id), respond)
    try {
      const response = page.waitForResponse(r => r.url() === classification(job.id) && r.request().method() === 'GET')
      await tab(page, '契約前の確認').click()
      assert.deepEqual(await (await response).json(), malformed, 'The browser receives the intended malformed response')
      await page.getByText('確認事項の応答形式を確認できません。再読込してください。', { exact: true }).waitFor()
      assert.equal(await page.locator('.c-form,.c-summary').count(), 0); assert.equal(await button(page, '途中まで保存').count(), 0)
    } finally { await page.unroute(classification(job.id), respond) }
  }
  await tab(page, '基本情報').click()
  const future = structuredClone(real); future.currentCatalogVersion = 'future-unknown-catalog'
  const futureResponse = route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(future) })
  await page.route(classification(job.id), futureResponse)
  try {
    await classificationTab(page); assert.ok(await button(page, '途中まで保存').isDisabled()); assert.ok(await field(page, '工事の区分').isDisabled())
    await page.getByText(/業種カタログが更新されています。再読込するまで保存できません/).waitFor()
  } finally { await page.unroute(classification(job.id), futureResponse) }
  await tab(page, '基本情報').click(); await classificationTab(page)
  pass('Abnormal company/job/record-company/schema responses expose no answers; unknown current catalog disables editing and writes (only these abnormal responses are fulfilled)')

  phase = 'late company response and viewer'
  let release, arrived
  const gate = new Promise(resolve => { release = resolve }); const fetched = new Promise(resolve => { arrived = resolve }); pending.add(release)
  await tab(page, '基本情報').click()
  const delayedResponse = async route => { const response = await route.fetch(); arrived(); await gate; try { await route.fulfill({ response }) } catch { /* Navigation may cancel the request. */ } }
  await page.route(classification(job.id), delayedResponse)
  await tab(page, '契約前の確認').click(); await fetched
  await button(page, '会社を切り替え').click(); await company(page, 1); await open(page, secondJob.name); await classificationTab(page)
  release(); pending.delete(release)
  await page.unroute(classification(job.id), delayedResponse)
  assert.equal(await field(page, '工事の区分').inputValue(), 'unanswered')
  assert.ok(!(await page.locator('.c-classification').innerText()).includes('ページ取得中に追加した版'))
  const viewerPage = await makePage(); await login(viewerPage, emails[1]); await open(viewerPage); await classificationTab(viewerPage)
  assert.equal(await viewerPage.locator('.c-form,.c-history').count(), 0); assert.equal(await button(viewerPage, '途中まで保存').count(), 0)
  assert.equal(await tab(viewerPage, '変更履歴').count(), 0)
  const readOnly = await get(viewerPage.context(), job.id)
  assert.equal((await viewerPage.context().request.put(classification(job.id), { headers: { Origin: config.origin }, data: { version: readOnly.record.version, jobVersion: readOnly.currentJob.version, data: readOnly.record.data } })).status(), 403)
  assert.equal((await viewerPage.context().request.get(`${classification(job.id)}/audit`)).status(), 403)
  await snapshot(viewerPage, 'viewer')
  await button(viewerPage, '工事一覧に戻る').click(); await open(viewerPage, emptyJob.name)
  await button(viewerPage, '確認事項を見る').click()
  await viewerPage.getByText('保存した回答はありません。', { exact: true }).waitFor()
  assert.equal(await viewerPage.locator('.c-form,.c-history,.c-next-input').count(), 0)
  pass('Late response cannot overwrite another company; viewer sees answers with no edit/history controls and real API denies both operations')

  phase = '401 and storage cleanup'
  await tab(viewerPage, '基本情報').click(); await viewerPage.context().clearCookies(); await tab(viewerPage, '契約前の確認').click()
  await viewerPage.getByRole('heading', { name: '工事台帳にログイン', exact: true }).waitFor()
  assert.equal(await viewerPage.locator('.c-classification,.p-company-bar').count(), 0)
  assert.deepEqual(await page.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length })), { local: 0, session: 0 })
  assert.deepEqual(await page.evaluate(async () => (await indexedDB.databases()).map(d => d.name)), [])
  assert.equal(runtimeErrors.length, 0)
  assert.ok(!consoleMessages.some(message => secrets.some(secret => message.includes(secret))), 'No fixture credentials or session cookies in console')
  pass('Real expired session clears company UI; classification stores no browser data and logs no credentials or runtime errors')
} catch (error) {
  failure = { phase, error: redact(error) }
  if (activePage && !activePage.isClosed()) try { await activePage.screenshot({ path: path.join(output, 'failure.png'), fullPage: true, mask: [activePage.locator('input[type=password],input[name=email]')] }) } catch { /* Preserve original failure. */ }
} finally {
  for (const release of pending) release()
  try { await browser?.close() } catch (error) { failure ??= { phase: 'browser cleanup', error: redact(error) } }
  try { await cleanup() } catch (error) { failure ??= { phase: 'fixture cleanup', error: redact(error) } }
  await pool.end()
  const report = { ok: !failure && cleaned, checks, screenshots, fixtureCleanup: cleaned, runtimeErrors, ...(failure ? { failure } : {}), note: 'Real Chrome, API and local PostgreSQL. Only network failures/delays and explicitly malformed-response cases are injected. Random fixtures are removed; existing business data, rate limits and server configuration are untouched. Responsive widths are emulated, not physical phone tests.' }
  await fs.writeFile(path.join(output, 'results.json'), JSON.stringify(report, null, 2))
  await fs.writeFile(path.join(output, `run-${Date.now()}.json`), JSON.stringify(report, null, 2))
  console.log(JSON.stringify({ ok: report.ok, checks: checks.length, screenshots: screenshots.length, fixtureCleanup: cleaned, ...(failure ? { failure } : {}) }, null, 2))
  if (!report.ok) process.exitCode = 1
}
