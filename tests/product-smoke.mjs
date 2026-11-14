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
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(database.hostname), 'Only a local fixture database is allowed')
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(new URL(config.origin).hostname), 'Only a local application is allowed')
const { chromium } = createRequire(import.meta.url)(values.playwright || 'playwright')
const output = path.resolve(values.out || path.join(root, 'outputs/product-qa-2026-10-23'))
const runStamp = new Date().toISOString().replace(/[:.]/g, '-')
await fs.mkdir(output, { recursive: true })
const pool = createPool(database.href)
const runId = randomBytes(10).toString('hex')
const emails = [`owner-${runId}@product-qa.invalid`, `viewer-${runId}@product-qa.invalid`]
const password = randomBytes(32).toString('base64url')
const secrets = [password, ...emails, process.env.DATABASE_ADMIN_URL, process.env.DATABASE_URL, config.secret, database.password].filter(Boolean)
const companies = [randomUUID(), randomUUID()]
const companyNames = ['統合試験 第一施工', '統合試験 第二施工']
const widths = [360, 390, 768, 1440]
const checks = []
const screenshots = []
const browserErrors = []
const consoleMessages = []
const pendingRoutes = new Set()
let browser, owner, viewer, activePage, failure, phase = 'setup', cleaned = false
const cleanError = error => {
  let message = `${error?.name || 'Error'}: ${error?.message || 'Operation failed'}`
  for (const secret of secrets) message = message.replaceAll(secret, '[redacted]')
  return message.slice(0, 5000)
}
const check = name => { checks.push(name); console.log(`PASS ${name}`) }
const input = { name: '共用玄関 修繕工事', customerName: '試験発注者', siteAddress: '東京都 統合試験専用所在地', workDescription: '共用玄関の修繕と動作確認。', plannedStart: '2026-11-01', plannedEnd: '2026-11-03' }
const jobsUrl = (company = companies[0]) => `${config.origin}/api/companies/${company}/jobs`
const button = (page, name) => page.getByRole('button', { name, exact: true })
const field = (page, name) => page.getByLabel(name, { exact: false })
function deferred() {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}
async function bounded(promise, label) {
  let timer
  try {
    return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Timed out: ${label}`)), 12000) })])
  } finally { clearTimeout(timer) }
}
async function settle(page) {
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
}
async function pageFor(context) {
  const page = await context.newPage()
  page.setDefaultTimeout(12000)
  page.on('pageerror', error => browserErrors.push(cleanError(error)))
  page.on('console', message => consoleMessages.push(message.text()))
  activePage = page
  return page
}
async function contextFor(state) {
  return browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce', serviceWorkers: 'block', ...(state ? { storageState: state } : {}) })
}
async function noOverflow(page) {
  const metrics = await page.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth, body: document.body.scrollWidth }))
  assert.ok(metrics.scroll <= metrics.width + 1 && metrics.body <= metrics.width + 1, `Horizontal overflow: ${JSON.stringify(metrics)}`)
}
async function capture(page, name) {
  await page.evaluate(() => window.scrollTo(0, 0))
  await settle(page)
  await noOverflow(page)
  await page.screenshot({ path: path.join(output, name), fullPage: true, animations: 'disabled', mask: [page.locator('input[type=password]'), page.locator('input[name=email]')] })
  screenshots.push(name)
}
async function captureWidths(page, state) {
  for (const width of widths) {
    await page.setViewportSize({ width, height: width < 768 ? 844 : 1000 })
    await capture(page, `${state}-${width}.png`)
  }
  await page.setViewportSize({ width: 1440, height: 1000 })
}
async function login(page, email) {
  await page.goto(`${config.origin}/product.html`)
  await page.getByRole('heading', { name: '工事台帳にログイン', exact: true }).waitFor()
  await field(page, 'メールアドレス').fill(email)
  await field(page, 'パスワード').fill(password)
  const response = page.waitForResponse(response => response.url().endsWith('/api/auth/sign-in/email') && response.request().method() === 'POST')
  await button(page, 'ログイン').click()
  const signedIn = await response
  if (signedIn.status() === 429) throw new Error('Login rate limit reached; wait for the server window before rerunning. No rate-limit records were modified.')
  assert.equal(signedIn.status(), 200, 'Real email sign-in must succeed')
}
async function selectCompany(page, index = 0) {
  await page.getByRole('heading', { name: '会社を選択', exact: true }).waitFor()
  await page.locator('.p-company-option').filter({ hasText: companyNames[index] }).click()
  await page.getByRole('heading', { name: /工事一覧/ }).waitFor()
  await page.locator('.p-loading').waitFor({ state: 'detached' })
}
async function list(page) {
  await button(page, '工事一覧に戻る').click()
  await page.getByRole('heading', { name: /工事一覧/ }).waitFor()
  await page.locator('.p-loading').waitFor({ state: 'detached' })
}
async function open(page, name) {
  await page.locator('.p-job-row').filter({ hasText: name }).click()
  await page.getByRole('heading', { name, exact: true }).waitFor()
}
async function wizard(page, data = input) {
  await button(page, '工事を登録').click()
  await field(page, '工事名').fill(data.name)
  await field(page, '発注者').fill(data.customerName)
  await button(page, '次へ').click()
  await field(page, '所在地').fill(data.siteAddress)
  await field(page, '施工内容').fill(data.workDescription)
  await button(page, '次へ').click()
  if (data.plannedStart) await field(page, '開始予定日').fill(data.plannedStart)
  if (data.plannedEnd) await field(page, '終了予定日').fill(data.plannedEnd)
}
async function createWithApi(context, body, company = companies[0]) {
  const response = await context.request.post(jobsUrl(company), { headers: { Origin: config.origin, 'Idempotency-Key': randomUUID() }, data: body })
  assert.equal(response.status(), 201, 'Fixture job creation through real API')
  return response.json()
}
async function readWithApi(context, jobId) {
  const response = await context.request.get(`${jobsUrl()}/${jobId}`)
  assert.equal(response.status(), 200)
  return response.json()
}
async function cleanup() {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const users = (await client.query('SELECT id FROM "user" WHERE email = ANY($1::text[])', [emails])).rows.map(row => row.id)
    // Every deletion is restricted to the randomly allocated fixture identities.
    for (const table of ['creation_requests', 'audit_events', 'jobs', 'memberships']) await client.query(`DELETE FROM ${table} WHERE company_id = ANY($1::uuid[])`, [companies])
    await client.query('DELETE FROM companies WHERE id = ANY($1::uuid[])', [companies])
    await client.query('DELETE FROM session WHERE "userId" = ANY($1::text[])', [users])
    await client.query('DELETE FROM account WHERE "userId" = ANY($1::text[])', [users])
    await client.query('DELETE FROM "user" WHERE id = ANY($1::text[])', [users])
    assert.equal((await client.query('SELECT count(*)::integer AS n FROM "user" WHERE email = ANY($1::text[])', [emails])).rows[0].n, 0)
    assert.equal((await client.query('SELECT count(*)::integer AS n FROM companies WHERE id = ANY($1::uuid[])', [companies])).rows[0].n, 0)
    await client.query('COMMIT')
    cleaned = true
  } catch (error) { await client.query('ROLLBACK'); throw error }
  finally { client.release() }
}

try {
  const health = await fetch(`${config.origin}/api/health`, { signal: AbortSignal.timeout(10000) })
  assert.equal(health.status, 200)
  assert.equal((await health.json()).status, 'ok')
  const auth = createAuth(pool, config, true)
  owner = (await auth.api.signUpEmail({ body: { email: emails[0], password, name: '統合試験 管理者' } })).user
  viewer = (await auth.api.signUpEmail({ body: { email: emails[1], password, name: '統合試験 閲覧者' } })).user
  await pool.query('INSERT INTO companies(id,name) VALUES($1,$2),($3,$4)', [companies[0], companyNames[0], companies[1], companyNames[1]])
  await pool.query("INSERT INTO memberships(company_id,user_id,role) VALUES($1,$2,'owner'),($3,$2,'manager'),($1,$4,'viewer')", [companies[0], owner.id, companies[1], viewer.id])
  browser = await chromium.launch({ executablePath: values.browser, headless: true })
  const ownerContext = await contextFor()
  const page = await pageFor(ownerContext)
  await page.goto(`${config.origin}/product.html`)
  await page.getByRole('heading', { name: '工事台帳にログイン' }).waitFor()
  await captureWidths(page, 'login')
  phase = 'login and company selection'
  await login(page, emails[0])
  await page.getByRole('heading', { name: '会社を選択' }).waitFor()
  const ownerState = await ownerContext.storageState()
  for (const cookie of ownerState.cookies) secrets.push(cookie.value)
  await captureWidths(page, 'company')
  await selectCompany(page)
  assert.ok(await page.getByText('このページの取得済み工事のみ検索', { exact: true }).isVisible())
  check('Real UI login, two-company selection and page-local search disclosure')

  phase = 'three-step registration'
  await button(page, '工事を登録').click()
  await button(page, '次へ').click()
  await page.getByText('工事名を入力してください。', { exact: true }).waitFor()
  assert.equal(await field(page, '工事名').getAttribute('maxlength'), '120')
  await field(page, '工事名').fill(input.name)
  await field(page, '発注者').fill(input.customerName)
  await captureWidths(page, 'create-step1')
  await button(page, '次へ').click()
  assert.equal(await field(page, '所在地').getAttribute('maxlength'), '250')
  assert.equal(await field(page, '施工内容').getAttribute('maxlength'), '2000')
  await field(page, '所在地').fill(input.siteAddress)
  await field(page, '施工内容').fill(input.workDescription)
  await captureWidths(page, 'create-step2')
  await button(page, '次へ').click()
  await field(page, '開始予定日').fill(input.plannedStart)
  await field(page, '終了予定日').fill('2026-10-31')
  await button(page, '登録する').click()
  await page.getByText('終了予定日は開始予定日以降にしてください。', { exact: true }).waitFor()
  await field(page, '終了予定日').fill(input.plannedEnd)
  await captureWidths(page, 'create-step3')
  const createdResponse = page.waitForResponse(r => r.url() === jobsUrl() && r.request().method() === 'POST')
  await button(page, '登録する').click()
  const created = await createdResponse
  assert.equal(created.status(), 201)
  const mainJob = await created.json()
  await page.getByRole('heading', { name: input.name, exact: true }).waitFor()
  assert.equal((await pool.query('SELECT version FROM jobs WHERE id=$1 AND company_id=$2', [mainJob.id, companies[0]])).rows[0].version, 1)
  await page.getByRole('region', { name: '次の作業', exact: true }).waitFor()
  await button(page, '契約前の確認へ進む').click()
  await page.locator('.c-classification > .c-heading').waitFor()
  assert.equal(await page.getByRole('tab', { name: '契約前の確認', exact: true }).getAttribute('aria-selected'), 'true')
  assert.equal((await pool.query('SELECT count(*)::int AS count FROM job_classifications WHERE job_id=$1 AND company_id=$2', [mainJob.id, companies[0]])).rows[0].count, 0, 'Opening the next task must not invent a saved answer')
  await page.getByRole('tab', { name: '基本情報', exact: true }).click()
  check('Newly registered job exposes one next-task action; it opens classification without writing answers')
  await page.reload()
  await selectCompany(page)
  await open(page, input.name)
  await captureWidths(page, 'detail')
  check('Three-step validation, real 201 creation and persistence across reload')

  phase = 'shared browser session and edit failure'
  const secondContext = await contextFor(ownerState)
  const second = await pageFor(secondContext)
  await second.goto(`${config.origin}/product.html`)
  await selectCompany(second)
  await open(second, input.name)
  await button(second, '編集').click()
  const competingText = '別ブラウザからの未保存入力を保持する。'
  await field(second, '施工内容').fill(competingText)
  activePage = page
  await button(page, '編集').click()
  const updatedText = '修繕後の動作確認と清掃まで実施。'
  await field(page, '施工内容').fill(updatedText)
  await ownerContext.setOffline(true)
  await button(page, '変更を保存').click()
  await page.getByText('入力内容は保持されています。', { exact: true }).waitFor()
  assert.equal(await field(page, '施工内容').inputValue(), updatedText)
  assert.equal((await pool.query('SELECT version FROM jobs WHERE id=$1', [mainJob.id])).rows[0].version, 1)
  await capture(page, 'edit-network-failure.png')
  await ownerContext.setOffline(false)
  await button(page, '変更を保存').click()
  await page.getByRole('heading', { name: input.name, exact: true }).waitFor()
  assert.equal((await readWithApi(ownerContext, mainJob.id)).workDescription, updatedText)
  check('Separate browser shares real stored job; failed edit preserves input and retries successfully')

  phase = 'optimistic conflict'
  activePage = second
  await button(second, '変更を保存').click()
  await second.getByText('保存内容が更新されています', { exact: true }).waitFor()
  assert.equal(await field(second, '施工内容').inputValue(), competingText)
  assert.ok(await button(second, '変更を保存').isDisabled())
  await captureWidths(second, 'conflict')
  second.once('dialog', dialog => dialog.dismiss())
  await button(second, '入力を破棄して最新データを再読込').click()
  assert.equal(await field(second, '施工内容').inputValue(), competingText)
  second.once('dialog', dialog => dialog.accept())
  await button(second, '入力を破棄して最新データを再読込').click()
  await second.waitForFunction(value => document.querySelector('textarea[name=workDescription]')?.value === value, updatedText)
  assert.ok(await button(second, '変更を保存').isDisabled())
  await field(second, '施工内容').fill(competingText)
  await button(second, '変更を保存').click()
  await second.getByRole('heading', { name: input.name, exact: true }).waitFor()
  assert.equal((await readWithApi(secondContext, mainJob.id)).version, 3)
  check('Real 409 preserves draft and blocks overwrite; discard confirmation fetches latest version')

  phase = 'audit history'
  const legacyFixture = await pool.query("UPDATE audit_events SET request_id='legacy:' || id::text, actor_name=$1 WHERE company_id=$2 AND target_id=$3 AND actor_id=$4 AND target_version=1 RETURNING id", ['統合試験 移行時担当者', companies[0], mainJob.id, owner.id])
  assert.equal(legacyFixture.rowCount, 1, 'Only the fixture creation event is marked as migrated history')
  await second.getByRole('tab', { name: '変更履歴' }).click()
  await second.locator('.p-audit-event').nth(2).waitFor()
  assert.equal(await second.locator('.p-audit-event').count(), 3)
  await second.locator('.p-audit-changes summary').first().click()
  assert.ok((await second.locator('.p-audit-list').innerText()).includes(updatedText))
  assert.ok((await second.locator('.p-audit-list').innerText()).includes(competingText))
  assert.ok(!(await second.locator('main').innerText()).includes('履歴全件'))
  assert.ok(await second.getByText('最初の履歴まで表示しました。', { exact: true }).isVisible())
  assert.equal(await second.locator('.p-audit-legacy').count(), 1)
  assert.ok((await second.locator('.p-audit-event').last().innerText()).includes('名前は移行時点（当時の名前は不明）'))
  assert.ok((await second.locator('.p-audit-event').last().innerText()).includes('統合試験 移行時担当者'))
  assert.equal(await second.locator('.p-audit-event').first().locator('.p-audit-legacy').count(), 0)
  assert.ok((await second.locator('.p-audit-event').first().innerText()).includes('統合試験 管理者'))
  await captureWidths(second, 'audit')
  check('Real audit shows actor, server time and before/after values without claiming complete history')
  check('Only legacy-prefixed fixture history labels actor name as migration-time and historical name as unknown; new snapshots stay unmarked')

  phase = 'PATCH response lost, retry conflict and current-content comparison'
  activePage = page
  await page.reload()
  await selectCompany(page)
  await open(page, input.name)
  await button(page, '編集').click()
  const lostPatchText = '応答消失後にサーバー保存内容と照合する入力。'
  await field(page, '施工内容').fill(lostPatchText)
  const patchStatuses = []
  const patchUrl = `${jobsUrl()}/${mainJob.id}`
  const lostPatchRoute = async route => {
    if (route.request().method() !== 'PATCH') return route.continue()
    const response = await route.fetch()
    patchStatuses.push(response.status())
    if (patchStatuses.length === 1) return route.abort('connectionreset')
    return route.fulfill({ response })
  }
  await page.route(patchUrl, lostPatchRoute)
  await button(page, '変更を保存').click()
  await page.getByText('更新結果は不明です', { exact: true }).waitFor()
  assert.equal(await field(page, '施工内容').inputValue(), lostPatchText)
  assert.equal((await readWithApi(ownerContext, mainJob.id)).version, 4)
  await button(page, '変更を保存').click()
  await page.waitForFunction(() => document.querySelector('button[type=submit]')?.disabled)
  await page.getByText('保存内容の版が変わっています。現在の保存内容を確認してください。', { exact: true }).waitFor()
  assert.deepEqual(patchStatuses, [200, 409])
  assert.ok(await page.getByText('更新結果は不明です', { exact: true }).isVisible())
  assert.equal(await field(page, '施工内容').inputValue(), lostPatchText)
  assert.ok(!(await page.getByRole('alert').innerText()).includes('未保存'))
  assert.ok(!(await page.getByRole('alert').innerText()).includes('保存されていません'))
  await page.unroute(patchUrl, lostPatchRoute)
  await capture(page, 'edit-response-lost.png')
  const failCurrentRead = route => route.abort('internetdisconnected')
  await page.route(patchUrl, failCurrentRead, { times: 1 })
  await button(page, '現在の保存内容を確認').click()
  await page.getByText('通信できませんでした。接続を確認して再試行してください。', { exact: true }).waitFor()
  assert.equal(await field(page, '施工内容').inputValue(), lostPatchText)
  assert.ok(await button(page, '変更を保存').isDisabled())
  await button(page, '現在の保存内容を確認').click()
  await page.getByText('現在の保存内容は入力と一致しています。', { exact: true }).waitFor()
  const comparison = page.getByRole('region', { name: '保存内容との比較' })
  assert.ok((await comparison.innerText()).includes(competingText))
  assert.ok((await comparison.innerText()).includes(lostPatchText))
  assert.ok((await comparison.innerText()).includes('この照合だけでは確定できません'))
  assert.ok(await button(page, '変更を保存').isDisabled())
  assert.equal((await readWithApi(ownerContext, mainJob.id)).version, 4)
  await captureWidths(page, 'edit-current-comparison')
  await button(page, '確認した版を基に編集を続ける').click()
  assert.equal(await field(page, '施工内容').inputValue(), lostPatchText)
  assert.ok(await button(page, '変更を保存').isDisabled())
  assert.equal((await readWithApi(ownerContext, mainJob.id)).version, 4)
  page.once('dialog', dialog => dialog.accept())
  await button(page, '工事詳細に戻る').click()
  await page.getByRole('heading', { name: input.name, exact: true }).waitFor()
  check('Committed PATCH with lost response and retry 409 remains unknown; failed GET preserves input, successful comparison requires explicit version acceptance without another write')

  phase = 'creation response lost and idempotent replay'
  activePage = page
  await list(page)
  const replayInput = { ...input, name: '応答喪失 再送試験工事' }
  await wizard(page, replayInput)
  const requests = []
  const entered = deferred(), release = deferred()
  pendingRoutes.add(release)
  const replayRoute = async route => {
    if (route.request().method() !== 'POST') return route.continue()
    requests.push({ key: route.request().headers()['idempotency-key'], body: route.request().postData() })
    if (requests.length === 1) { entered.resolve(); await release.promise }
    const response = await route.fetch()
    requests.at(-1).status = response.status()
    if (requests.length === 1) return route.abort('connectionreset')
    return route.fulfill({ response })
  }
  await page.route(jobsUrl(), replayRoute)
  await page.locator('form').evaluate(form => { form.requestSubmit(); form.requestSubmit() })
  await bounded(entered.promise, 'creation route')
  assert.ok(await button(page, '保存中').isDisabled())
  assert.equal(requests.length, 1, 'In-flight duplicate submit must be suppressed')
  release.resolve(); pendingRoutes.delete(release)
  await page.getByText('入力内容は保持されています。', { exact: true }).waitFor()
  assert.equal((await pool.query('SELECT count(*)::integer AS n FROM jobs WHERE company_id=$1 AND name=$2', [companies[0], replayInput.name])).rows[0].n, 1)
  await capture(page, 'create-response-lost.png')
  await button(page, '登録する').click()
  await page.getByRole('heading', { name: replayInput.name, exact: true }).waitFor()
  assert.equal(requests.length, 2)
  assert.equal(requests[0].key, requests[1].key)
  assert.equal(requests[0].body, requests[1].body)
  assert.deepEqual(requests.map(request => request.status), [201, 200])
  await page.unroute(jobsUrl(), replayRoute)
  assert.equal((await pool.query('SELECT count(*)::integer AS n FROM jobs WHERE company_id=$1 AND name=$2', [companies[0], replayInput.name])).rows[0].n, 1)
  check('Response lost after real commit: draft retained, duplicate submit suppressed, identical replay returns 200 and one job')

  phase = 'changed creation body allocates new key'
  await list(page)
  await wizard(page, { ...input, name: '入力変更 再送キー試験工事' })
  const changedRequests = []
  const changedRoute = async route => {
    if (route.request().method() !== 'POST') return route.continue()
    changedRequests.push({ key: route.request().headers()['idempotency-key'], body: route.request().postData() })
    if (changedRequests.length === 1) return route.abort('internetdisconnected')
    return route.continue()
  }
  await page.route(jobsUrl(), changedRoute)
  await button(page, '登録する').click()
  await page.getByText('入力内容は保持されています。', { exact: true }).waitFor()
  await field(page, '終了予定日').fill('2026-11-04')
  await button(page, '登録する').click()
  await page.getByRole('heading', { name: '入力変更 再送キー試験工事', exact: true }).waitFor()
  assert.notEqual(changedRequests[0].key, changedRequests[1].key)
  assert.notEqual(changedRequests[0].body, changedRequests[1].body)
  await page.unroute(jobsUrl(), changedRoute)
  check('Changing a failed creation draft allocates a new idempotency key')

  phase = 'pagination and long-content layouts'
  const longInput = { name: '長い工事名称'.repeat(20), customerName: '長い発注者名'.repeat(20), siteAddress: '長い所在地'.repeat(50), workDescription: '長い施工内容'.repeat(334).slice(0, 2000), plannedStart: null, plannedEnd: null }
  const longJob = await createWithApi(ownerContext, longInput)
  for (let index = 0; index < 50; index++) await createWithApi(ownerContext, { ...input, name: `ページング試験 ${String(index + 1).padStart(2, '0')}` })
  const total = (await ownerContext.request.get(`${jobsUrl()}?offset=0&limit=50`))
  assert.equal((await total.json()).total, 54)
  await list(page)
  assert.equal(await page.locator('.p-job-row').count(), 50)
  await captureWidths(page, 'list')
  await page.getByRole('searchbox', { name: 'このページ内を検索' }).fill(input.name)
  await page.getByText('一致する工事がありません', { exact: true }).waitFor()
  assert.ok(await page.getByText('このページの取得済み工事のみ検索', { exact: true }).isVisible())
  await button(page, '次のページ').click()
  await page.locator('.p-job-row').nth(3).waitFor()
  assert.equal(await page.locator('.p-job-row').count(), 4)
  assert.equal(await page.getByRole('searchbox').inputValue(), '')
  await open(page, longJob.name)
  await captureWidths(page, 'long-detail')
  await button(page, '編集').click()
  await captureWidths(page, 'long-editor')
  page.once('dialog', dialog => dialog.accept())
  await button(page, '工事詳細に戻る').click()
  await page.getByRole('heading', { name: longJob.name, exact: true }).waitFor()
  check('54 real jobs paginate 50/4; search scope is explicit; maximum-length fields and nullable dates fit all four widths')

  phase = 'stale company list response'
  let secondJob = await createWithApi(ownerContext, { ...input, name: '第二施工 専用工事' }, companies[1])
  const raceContext = await contextFor(ownerState)
  const race = await pageFor(raceContext)
  await race.goto(`${config.origin}/product.html`)
  await race.getByRole('heading', { name: '会社を選択' }).waitFor()
  const raceEntered = deferred(), raceRelease = deferred(), raceDone = deferred()
  pendingRoutes.add(raceRelease)
  const raceRoute = async route => {
    const response = await route.fetch()
    raceEntered.resolve()
    await raceRelease.promise
    try { await route.fulfill({ response }) } catch { /* The UI may already have aborted this obsolete request. */ }
    raceDone.resolve()
  }
  await race.route(`${jobsUrl()}?*`, raceRoute)
  await race.locator('.p-company-option').filter({ hasText: companyNames[0] }).click()
  await bounded(raceEntered.promise, 'company list route')
  await button(race, '会社を切り替え').click()
  await selectCompany(race, 1)
  await race.locator('.p-job-row').filter({ hasText: '第二施工 専用工事' }).waitFor()
  raceRelease.resolve(); pendingRoutes.delete(raceRelease)
  await bounded(raceDone.promise, 'obsolete company response')
  await settle(race)
  assert.equal(await race.locator('.p-job-row').count(), 1)
  assert.equal(await race.locator('.p-job-row').filter({ hasText: 'ページング試験' }).count(), 0)
  await capture(race, 'company-response-race.png')
  await race.unroute(`${jobsUrl()}?*`, raceRoute)
  check('Delayed real response from former company cannot replace the selected company list')

  phase = 'stale company detail response'
  await button(race, '会社を切り替え').click()
  await selectCompany(race)
  await button(race, '次のページ').click()
  await race.locator('.p-job-row').filter({ hasText: input.name }).waitFor()
  const detailEntered = deferred(), detailRelease = deferred(), detailDone = deferred()
  pendingRoutes.add(detailRelease)
  const detailRoute = async route => {
    const response = await route.fetch()
    detailEntered.resolve()
    await detailRelease.promise
    try { await route.fulfill({ response }) } catch { /* An obsolete detail response may be aborted by the UI. */ }
    detailDone.resolve()
  }
  await race.route(`${jobsUrl()}/${mainJob.id}`, detailRoute)
  await race.locator('.p-job-row').filter({ hasText: input.name }).click()
  await bounded(detailEntered.promise, 'company detail route')
  await button(race, '会社を切り替え').click()
  await selectCompany(race, 1)
  detailRelease.resolve(); pendingRoutes.delete(detailRelease)
  await bounded(detailDone.promise, 'obsolete detail response')
  await settle(race)
  assert.equal(await race.locator('.p-detail-grid').count(), 0)
  assert.equal(await race.locator('.p-job-row').count(), 1)
  await race.unroute(`${jobsUrl()}/${mainJob.id}`, detailRoute)
  check('Delayed detail response is discarded after company switch')

  phase = 'complete audit cursor pagination'
  for (let index = 0; index < 101; index++) {
    const response = await ownerContext.request.patch(`${jobsUrl(companies[1])}/${secondJob.id}`, { headers: { Origin: config.origin }, data: { ...input, name: secondJob.name, workDescription: `履歴上限試験 ${index + 1}`, version: secondJob.version } })
    assert.equal(response.status(), 200, 'History fixture update must use the real versioned API')
    secondJob = await response.json()
  }
  assert.equal((await pool.query('SELECT count(*)::integer AS n FROM audit_events WHERE target_id=$1', [secondJob.id])).rows[0].n, 102)
  await open(race, secondJob.name)
  const auditUrl = `${jobsUrl(companies[1])}/${secondJob.id}/audit`
  const auditResponse = () => race.waitForResponse(response => response.url().startsWith(`${auditUrl}?`) && response.request().method() === 'GET')
  const firstAuditResponse = auditResponse()
  await race.getByRole('tab', { name: '変更履歴' }).click()
  const firstPage = await (await firstAuditResponse).json()
  await race.locator('.p-audit-event').nth(49).waitFor()
  assert.equal(await race.locator('.p-audit-event').count(), 50)
  assert.equal(firstPage.nextCursor, '53')
  await race.locator('.p-audit-changes summary').first().click()
  const retainedFirst = await race.locator('.p-audit-event').first().innerText()
  const failedAuditUrls = []
  const failOlderHistory = async route => { failedAuditUrls.push(route.request().url()); await route.abort('internetdisconnected') }
  await race.route(`${auditUrl}?limit=50&cursor=53`, failOlderHistory, { times: 1 })
  await button(race, '以前の履歴を表示').click()
  await race.getByText('取得済みの履歴は保持されています。', { exact: true }).waitFor()
  assert.equal(await race.locator('.p-audit-event').count(), 50)
  assert.equal(await race.locator('.p-audit-event').first().innerText(), retainedFirst)
  await capture(race, 'audit-load-more-failure.png')
  const retryAuditResponse = auditResponse()
  await button(race, '履歴の取得を再試行').click()
  const retriedAudit = await retryAuditResponse
  assert.equal(retriedAudit.url(), failedAuditUrls[0])
  const secondPage = await retriedAudit.json()
  await race.locator('.p-audit-event').nth(99).waitFor()
  assert.equal(await race.locator('.p-audit-event').count(), 100)
  assert.equal(secondPage.nextCursor, '3')
  assert.equal(await race.locator('.p-audit-event').first().innerText(), retainedFirst)
  const lastAuditResponse = auditResponse()
  await button(race, '以前の履歴を表示').click()
  const lastPage = await (await lastAuditResponse).json()
  await race.locator('.p-audit-event').nth(101).waitFor()
  assert.equal(await race.locator('.p-audit-event').count(), 102)
  assert.equal(lastPage.nextCursor, null)
  const history = [...firstPage.events, ...secondPage.events, ...lastPage.events]
  assert.equal(new Set(history.map(event => event.id)).size, 102)
  assert.deepEqual(history.map(event => event.targetVersion), Array.from({ length: 102 }, (_, index) => 102 - index))
  assert.ok(history.every(event => typeof event.requestId === 'string' && event.requestId.length > 0))
  assert.equal(history.at(-1).action, 'job.created')
  assert.ok(await race.getByText('最初の履歴まで表示しました。', { exact: true }).isVisible())
  assert.equal(await button(race, '以前の履歴を表示').count(), 0)
  assert.equal(await race.locator('.p-audit-heading strong').filter({ hasText: '工事を登録' }).count(), 1)
  assert.ok((await race.locator('.p-audit-event').last().innerText()).includes('工事を登録'))
  assert.ok(!(await race.locator('main').innerText()).includes('最新100件まで'))
  await capture(race, 'audit-complete102.png')
  check('102 real audit records load 50/50/2 without duplicates through oldest creation; failed load-more retains existing pages and retries the same cursor')

  phase = 'company switch during audit load-more'
  await race.getByRole('tab', { name: '基本情報' }).click()
  await race.getByRole('tab', { name: '変更履歴' }).click()
  await race.locator('.p-audit-event').nth(49).waitFor()
  const auditEntered = deferred(), auditRelease = deferred(), auditDone = deferred()
  pendingRoutes.add(auditRelease)
  const auditRaceRoute = async route => {
    const response = await route.fetch()
    auditEntered.resolve()
    await auditRelease.promise
    try { await route.fulfill({ response }) } catch { /* Obsolete history fetch may have been aborted. */ }
    auditDone.resolve()
  }
  await race.route(`${auditUrl}?limit=50&cursor=53`, auditRaceRoute)
  await button(race, '以前の履歴を表示').click()
  await bounded(auditEntered.promise, 'audit load-more route')
  await button(race, '会社を切り替え').click()
  await selectCompany(race)
  auditRelease.resolve(); pendingRoutes.delete(auditRelease)
  await bounded(auditDone.promise, 'obsolete audit response')
  await settle(race)
  assert.equal(await race.locator('.p-audit-event').count(), 0)
  assert.equal(await race.locator('.p-job-row').count(), 50)
  await raceContext.close()
  check('Company switch cancels obsolete history pagination without exposing previous-company events')

  phase = 'viewer permissions'
  const viewerContext = await contextFor()
  const viewerPage = await pageFor(viewerContext)
  let viewerAuditRequests = 0
  viewerPage.on('request', request => { if (new URL(request.url()).pathname.endsWith('/audit')) viewerAuditRequests++ })
  await login(viewerPage, emails[1])
  await viewerPage.getByRole('heading', { name: /工事一覧/ }).waitFor()
  await viewerPage.locator('.p-job-row').first().waitFor()
  assert.equal(await viewerPage.getByRole('heading', { name: '会社を選択' }).count(), 0)
  assert.equal(await button(viewerPage, '工事を登録').count(), 0)
  await viewerPage.locator('.p-job-row').first().click()
  await viewerPage.locator('.p-detail-grid').waitFor()
  assert.equal(await button(viewerPage, '編集').count(), 0)
  assert.equal(await viewerPage.getByRole('tab', { name: '変更履歴' }).count(), 0)
  assert.equal(viewerAuditRequests, 0)
  await captureWidths(viewerPage, 'viewer')
  for (const [method, url, data] of [['POST', jobsUrl(), input], ['PATCH', `${jobsUrl()}/${mainJob.id}`, { ...input, version: 3 }], ['GET', `${jobsUrl()}/${mainJob.id}/audit`, undefined]]) {
    const response = await viewerContext.request.fetch(url, { method, headers: { Origin: config.origin, 'Idempotency-Key': randomUUID() }, ...(data ? { data } : {}) })
    assert.equal(response.status(), 403)
  }
  check('Single-company viewer skips selection; create/edit/audit controls absent and real endpoints reject all three operations')

  phase = '401 clears private UI'
  const expiredContext = await contextFor(ownerState)
  const expired = await pageFor(expiredContext)
  await expired.goto(`${config.origin}/product.html`)
  await selectCompany(expired)
  await expiredContext.clearCookies()
  const expiredResponse = expired.waitForResponse(r => r.url().includes(`/companies/${companies[0]}/jobs`))
  await button(expired, '一覧を再読み込み').click()
  assert.equal((await expiredResponse).status(), 401)
  await expired.getByRole('heading', { name: '工事台帳にログイン' }).waitFor()
  assert.equal(await expired.locator('.p-company-bar,.p-job-row,.p-detail-grid').count(), 0)
  assert.ok(!(await expired.locator('body').innerText()).includes(companyNames[0]))
  await capture(expired, 'expired-session.png')
  await expiredContext.addCookies(ownerState.cookies)
  await expired.goto(`${config.origin}/product.html`)
  await selectCompany(expired, 1)
  await open(expired, secondJob.name)
  await expired.getByRole('tab', { name: '変更履歴' }).click()
  await expired.locator('.p-audit-event').nth(49).waitFor()
  await expiredContext.clearCookies()
  const expiredAudit = expired.waitForResponse(response => response.url().startsWith(`${auditUrl}?`) && response.request().method() === 'GET')
  await button(expired, '以前の履歴を表示').click()
  assert.equal((await expiredAudit).status(), 401)
  await expired.getByRole('heading', { name: '工事台帳にログイン' }).waitFor()
  assert.equal(await expired.locator('.p-audit-event,.p-company-bar').count(), 0)
  assert.ok(!(await expired.locator('body').innerText()).includes(companyNames[1]))
  await expiredContext.close()
  check('Real 401 during list refresh or history pagination returns to login and removes all company data without modifying account or rate limits')

  phase = 'logout and storage isolation'
  activePage = page
  assert.deepEqual(await page.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length })), { local: 0, session: 0 })
  assert.deepEqual(await page.evaluate(async () => (await indexedDB.databases()).map(database => database.name)), [])
  assert.equal(await page.locator('.p-enter').first().evaluate(element => getComputedStyle(element).animationName), 'none')
  const signoutResponse = page.waitForResponse(r => r.url().endsWith('/api/auth/sign-out'))
  await button(page, 'ログアウト').click()
  assert.equal((await signoutResponse).status(), 200)
  await page.getByRole('heading', { name: '工事台帳にログイン' }).waitFor()
  assert.equal((await ownerContext.request.get(`${config.origin}/api/me`)).status(), 401)
  assert.equal(await page.locator('.p-company-bar,.p-job-row,.p-detail-grid').count(), 0)
  await second.reload()
  await second.getByRole('heading', { name: '工事台帳にログイン' }).waitFor()
  await capture(page, 'logout.png')
  assert.equal(browserErrors.length, 0, 'No browser runtime errors')
  assert.ok(!consoleMessages.some(message => secrets.some(secret => message.includes(secret))), 'Console must not contain credentials or session tokens')
  check('Real logout revokes reused session; no browser data stores, private UI, runtime errors or credential logging; reduced motion respected')
} catch (error) {
  failure = { phase, error: cleanError(error) }
  if (activePage && !activePage.isClosed()) {
    try { await capture(activePage, 'failure.png') } catch { /* Preserve the original test failure. */ }
  }
} finally {
  for (const pending of pendingRoutes) pending.resolve()
  try { await browser?.close() } catch (error) { failure ??= { phase: 'browser cleanup', error: cleanError(error) } }
  try { await cleanup() } catch (error) { failure ??= { phase: 'fixture cleanup', error: cleanError(error) } }
  await pool.end()
  const report = { ok: !failure && cleaned, checks, screenshots, browser: browser?.version(), fixtureCleanup: cleaned, runtimeErrors: browserErrors, ...(failure ? { failure } : {}), note: 'Real Chrome, API and local PostgreSQL. Only network failure/delay is injected. Random fixture credentials and session state remain in memory; rate-limit tables and existing development data are untouched. Mobile widths are emulated, not physical devices.' }
  await fs.writeFile(path.join(output, 'results.json'), JSON.stringify(report, null, 2))
  await fs.writeFile(path.join(output, `run-${runStamp}.json`), JSON.stringify(report, null, 2))
  console.log(JSON.stringify({ ok: report.ok, checks: checks.length, screenshots: screenshots.length, fixtureCleanup: cleaned, ...(failure ? { failure } : {}) }, null, 2))
  if (!report.ok) process.exitCode = 1
}
