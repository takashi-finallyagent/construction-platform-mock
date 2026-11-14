import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import fs from 'node:fs/promises'
import path from 'node:path'
import { parseArgs } from 'node:util'

const { values } = parseArgs({ options: { playwright: { type: 'string' }, browser: { type: 'string' }, out: { type: 'string' } } })
const require = createRequire(import.meta.url)
const { chromium } = require(values.playwright || 'playwright')
const root = path.resolve(import.meta.dirname, '..')
const output = path.resolve(values.out || path.join(root, 'test-results'))
await fs.mkdir(output, { recursive: true })
const origin = 'https://construction.test/construction-platform-mock/'
const failures = []
const checks = []
const browser = await chromium.launch({ executablePath: values.browser, downloadsPath: output, headless: true, args: ['--disable-gpu', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] })
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true, reducedMotion: 'reduce' })

async function routeBuild(context) {
  await context.route('https://construction.test/**', async (route) => {
    let name = decodeURIComponent(new URL(route.request().url()).pathname).replace('/construction-platform-mock/', '/')
    if (name === '/') name = '/index.html'
    const target = path.resolve(root, 'dist', `.${name}`)
    if (!target.startsWith(path.join(root, 'dist') + path.sep)) return route.abort()
    try {
      const body = await fs.readFile(target)
      const contentType = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' }[path.extname(target)] || 'application/octet-stream'
      await route.fulfill({ body, contentType })
    } catch { await route.fulfill({ status: 404, body: 'Not found' }) }
  })
}
async function records(page, store) {
  return page.evaluate(async (store) => {
    const db = await new Promise((resolve, reject) => { const r = indexedDB.open('construction-field-workspace', 1); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error) })
    try {
      return await new Promise((resolve, reject) => {
        const tx = db.transaction(store)
        const r = tx.objectStore(store).getAll()
        r.onsuccess = () => resolve(r.result.map(({ blob, ...record }) => ({ ...record, size: blob?.size })))
        r.onerror = () => reject(r.error)
      })
    } finally { db.close() }
  }, store)
}
async function goto(page, route) { await page.goto(`${origin}#${route}`); await page.locator('.field-page').waitFor(); await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))) }
async function capture(page, phase, job = 'sample-door') {
  await goto(page, `/sites/${job}/photos?capture=${phase}`)
  await page.getByRole('button', { name: '写真を撮影', exact: true }).click()
  await page.getByText('この工事に1枚保存しました', { exact: true }).waitFor()
  await page.getByRole('button', { name: '撮影を終了' }).click()
  await page.locator('.capture-screen').waitFor({ state: 'detached' })
  console.log(`Captured ${job} / ${phase}`)
}
async function pdf(page, button, name, minimumPages = 1) {
  // The restricted runner cancels OS downloads. Inspect the real Blob at the anchor boundary.
  await page.evaluate(() => {
    window.testDownload = null
    if (window.originalAnchorClick) return
    window.originalAnchorClick = HTMLAnchorElement.prototype.click
    const create = URL.createObjectURL.bind(URL)
    const blobs = new Map()
    URL.createObjectURL = (blob) => { const url = create(blob); blobs.set(url, blob); return url }
    HTMLAnchorElement.prototype.click = function () {
      if (this.download && blobs.has(this.href)) { window.testDownload = { blob: blobs.get(this.href), name: this.download }; return }
      window.originalAnchorClick.call(this)
    }
  })
  await button.click()
  await page.waitForFunction(() => window.testDownload)
  const target = path.join(output, name)
  const data = await page.evaluate(async () => ({ name: window.testDownload.name, bytes: Array.from(new Uint8Array(await window.testDownload.blob.arrayBuffer())) }))
  assert.ok(data.name.endsWith('.pdf'))
  const bytes = Buffer.from(data.bytes)
  await fs.writeFile(target, bytes)
  assert.equal(bytes.subarray(0, 5).toString(), '%PDF-')
  const count = await page.evaluate(async (base64) => (await window.PDFLib.PDFDocument.load(Uint8Array.from(atob(base64), c => c.charCodeAt(0)))).getPageCount(), bytes.toString('base64'))
  assert.ok(count >= minimumPages, `${name}: page count ${count}`)
  checks.push(`${name}: ${count} pages, ${bytes.length} bytes`)
}
async function screenshot(page, name) {
  await page.evaluate(() => window.scrollTo(0, 0))
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  await page.screenshot({ path: path.join(output, name), fullPage: true, animations: 'disabled' })
}
async function noOverflow(page) {
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), `Horizontal overflow at ${page.viewportSize().width}px`)
}

try {
  await routeBuild(context)
  const page = await context.newPage()
  page.on('pageerror', (error) => failures.push(error.message))
  await goto(page, '/dashboard')
  assert.equal(await page.locator('.field-sidebar .sidebar-link').count(), 3)
  await screenshot(page, 'home-desktop.png')
  await noOverflow(page)
  checks.push('Three main navigation entries; desktop layout')

  for (const phase of ['before', 'during', 'after']) await capture(page, phase)
  let photos = await records(page, 'photos')
  assert.deepEqual(photos.map(p => p.phase).sort(), ['after', 'before', 'during'])
  assert.ok(photos.every(p => p.jobId === 'sample-door' && p.size > 1000 && p.takenAt))
  await page.reload()
  await page.locator('.photo-card').first().waitFor()
  assert.equal(await page.locator('.photo-card').count(), 3)
  await screenshot(page, 'photos-desktop.png')
  await pdf(page, page.getByRole('button', { name: '台帳PDF', exact: true }), 'photo-album.pdf', 2)
  checks.push('Camera frames saved to correct job and phase; three photos survive reload')

  await goto(page, '/sites/sample-door/photos?capture=during')
  await page.evaluate(() => {
    window.originalPut = IDBObjectStore.prototype.put
    IDBObjectStore.prototype.put = function (...args) { if (this.name === 'photos') throw new DOMException('Injected quota error', 'QuotaExceededError'); return window.originalPut.apply(this, args) }
  })
  await page.getByRole('button', { name: '写真を撮影', exact: true }).click()
  await page.getByRole('button', { name: '保存を再試行', exact: true }).waitFor()
  assert.equal(await page.getByText('この工事に1枚保存しました', { exact: true }).count(), 0)
  assert.equal((await records(page, 'photos')).length, 3)
  assert.ok(await page.getByRole('button', { name: '撮影を終了' }).isDisabled())
  await page.evaluate(() => history.back())
  await page.getByText('未保存の写真があります。保存の再試行、写真の退避、または破棄を選んでください。', { exact: true }).waitFor()
  assert.equal(await page.locator('.capture-screen').count(), 1)
  await screenshot(page, 'camera-save-failure.png')
  await page.evaluate(() => { IDBObjectStore.prototype.put = window.originalPut })
  await page.getByRole('button', { name: '保存を再試行', exact: true }).click()
  await page.getByText('この工事に1枚保存しました', { exact: true }).waitFor()
  await page.getByRole('button', { name: '撮影を終了' }).click()
  assert.equal((await records(page, 'photos')).length, 4)
  checks.push('Quota error: no false success, pending photo retained, retry produces one record')

  await goto(page, '/sites')
  const other = await page.locator('.job-list-item').nth(1).getAttribute('href')
  const otherId = other.split('/').at(-1)
  await capture(page, 'before', otherId)
  await goto(page, '/sites/sample-door/photos')
  assert.equal(await page.locator('.photo-card').count(), 4)
  await page.getByRole('button', { name: '施工前', exact: true }).click()
  assert.equal(await page.locator('.photo-card').count(), 1)
  await page.getByRole('button', { name: 'すべて', exact: true }).click()
  checks.push('Photos isolated by job; phase filter')

  await goto(page, '/sites/sample-door/timeline')
  await page.getByRole('button', { name: '工程を追加', exact: true }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByLabel('作業名', { exact: true }).fill('追加工事・最終検査')
  await dialog.getByLabel('終了時刻', { exact: true }).fill('08:00')
  await dialog.getByRole('button', { name: '工程を保存' }).click()
  await dialog.getByRole('alert').waitFor()
  await dialog.getByLabel('終了時刻', { exact: true }).fill('17:30')
  await dialog.getByRole('button', { name: '工程を保存' }).click()
  await dialog.waitFor({ state: 'detached' })
  await page.getByLabel('追加工事・最終検査の状態').selectOption('完了')
  await page.reload()
  await page.getByText('追加工事・最終検査', { exact: true }).waitFor()
  assert.equal(await page.getByLabel('追加工事・最終検査の状態').inputValue(), '完了')
  await pdf(page, page.getByRole('button', { name: '工程表PDF', exact: true }), 'schedule.pdf')
  await page.getByRole('button', { name: '週の工程表', exact: true }).click()
  await screenshot(page, 'schedule-desktop.png')
  checks.push('Schedule date/time validation, add, status, reload, week view and PDF')

  await goto(page, '/sites/sample-door/notice')
  for (const checkbox of await page.getByRole('checkbox').all()) await checkbox.check()
  await page.getByLabel('追記事項', { exact: true }).fill('近隣の皆様へのお願い事項です。\n'.repeat(11))
  await pdf(page, page.getByRole('button', { name: 'PDFを発行・ダウンロード' }), 'notice-all-impacts.pdf', 2)
  await page.getByLabel('お知らせの種類').selectOption('工事中止のお知らせ')
  assert.ok((await page.locator('.notice-preview').innerText()).includes('実施いたしません'))
  assert.equal(await page.locator('.notice-impact').count(), 0)
  await page.getByLabel('中止理由・連絡事項').fill('発注者の都合により中止します。')
  await pdf(page, page.getByRole('button', { name: 'PDFを発行・ダウンロード' }), 'notice-cancel.pdf')
  await page.reload()
  await page.getByLabel('お知らせの種類').waitFor()
  assert.equal(await page.getByLabel('お知らせの種類').inputValue(), '工事中止のお知らせ')
  checks.push('Notice pagination, correct cancellation wording, no irrelevant impacts, saved values')

  await goto(page, '/sites/sample-door/paperwork?kind=estimate')
  await page.getByLabel('金額（円）', { exact: true }).fill('65000')
  await page.getByRole('link', { name: '請求書', exact: true }).click()
  assert.equal(await page.getByLabel('金額（円）', { exact: true }).inputValue(), '65000')
  await pdf(page, page.getByRole('button', { name: 'PDFを発行・ダウンロード' }), 'invoice.pdf')
  await page.reload()
  await page.getByLabel('金額（円）', { exact: true }).waitFor()
  assert.equal(await page.getByLabel('金額（円）', { exact: true }).inputValue(), '65000')
  await page.getByRole('link', { name: '御見積書', exact: true }).click()
  assert.equal(await page.getByLabel('金額（円）', { exact: true }).inputValue(), '65000')
  await page.getByLabel('金額の入力方法').selectOption('unit')
  await page.getByLabel('数量', { exact: true }).fill('2')
  await page.getByLabel('単価（円）', { exact: true }).fill('10000')
  assert.ok((await page.locator('.paper-totals').innerText()).includes('22,000'))
  checks.push('Paperwork shares fixed amounts across kinds and reload; quantity-price calculation')

  await goto(page, '/documents?tab=issued')
  assert.equal(await page.locator('.document-row').count(), 5)
  await page.getByRole('button', { name: '作成する', exact: true }).click()
  await pdf(page, page.locator('.template-list > button').first(), 'notice-blank-template.pdf')
  checks.push('Issued PDF history and common blank notice template')

  await goto(page, '/sites?new=1')
  const register = page.getByRole('dialog')
  await register.getByLabel('建物名', { exact: true }).fill('検証用サンプルビル')
  await register.getByLabel('工事名', { exact: true }).fill('検証用修繕工事')
  await register.getByLabel('部屋・部位', { exact: true }).fill('3階 / 廊下')
  await register.getByLabel('提出先', { exact: true }).fill('検証用管理会社')
  await register.getByRole('button', { name: '登録して開く' }).click()
  await page.getByRole('heading', { name: '検証用修繕工事', exact: true }).waitFor()
  const newId = new URL(page.url()).hash.split('/')[2].split('?')[0]
  await page.getByRole('button', { name: '2 受注・準備', exact: true }).click()
  assert.equal((await records(page, 'workspace'))[0].jobs.find(j => j.id === newId).stage, 0)
  assert.equal(await page.getByRole('button', { name: '受注・準備へ進む', exact: true }).isDisabled(), true)
  await page.locator('summary').filter({ hasText: '工事の基本情報' }).click()
  await page.getByLabel('施工会社', { exact: true }).fill('検証用施工会社')
  await page.getByLabel('問い合わせ先', { exact: true }).fill('担当：検証用 / 000-000-0000')
  await page.getByRole('button', { name: '基本情報を保存', exact: true }).click()
  await page.getByText('基本情報をこの端末に保存しました', { exact: true }).waitFor()
  await page.reload()
  await page.getByRole('heading', { name: '検証用修繕工事', exact: true }).waitFor()
  const storedJob = (await records(page, 'workspace'))[0].jobs.find(j => j.id === newId)
  assert.equal(storedJob.company, '検証用施工会社')
  assert.equal(storedJob.stage, 0)
  checks.push('New job cannot advance without review; stage browsing and company/contact edits persist')

  await goto(page, `/sites/${newId}/checks`)
  await page.getByLabel('工事の所在地', { exact: true }).fill('神奈川県横浜市 サンプル住所')
  await page.getByLabel('自社の立場', { exact: true }).selectOption('prime')
  await page.getByLabel('発注者の区分', { exact: true }).selectOption('private')
  await page.getByRole('button', { name: '保存して次の条件へ' }).click()
  await page.getByLabel('法令上の工事分類', { exact: true }).selectOption('other')
  await page.getByLabel('該当業種・具体的な工事内容', { exact: true }).fill('管工事／給排水管の更新')
  await page.getByLabel('自社の請負金額', { exact: false }).fill('5000000')
  await page.getByLabel('別途支給される材料', { exact: false }).fill('0')
  await page.getByLabel('同一工事の分割契約', { exact: false }).fill('0')
  await page.getByRole('button', { name: '保存して次の条件へ' }).click()
  await page.getByLabel('自社から別の業者', { exact: false }).selectOption('no')
  await page.getByLabel('既存建物・工作物', { exact: false }).selectOption('yes')
  await page.getByRole('button', { name: '工事条件を保存', exact: true }).click()
  await page.locator('.compliance-review').waitFor()
  await screenshot(page, 'compliance-desktop.png')
  for (let index = 0; index < 3; index++) {
    const form = page.locator('.compliance-review form')
    await form.getByLabel('確認した担当者', { exact: true }).fill('検証担当者')
    await form.getByLabel('確認結果', { exact: true }).selectOption('documented')
    await form.getByLabel('確認した内容', { exact: false }).fill('自動試験用の記録。実在の工事の法令審査ではありません。')
    if (index === 2) await form.getByLabel('契約書類の双方交付日', { exact: true }).fill(await form.getByLabel('確認日', { exact: true }).inputValue())
    await form.locator('input[type=file]').setInputFiles(path.join(output, 'photo-album.pdf'))
    await form.getByRole('button', { name: '確認記録を保存', exact: true }).click()
    await page.getByRole('status').filter({ hasText: `（${index + 1}件）` }).waitFor()
  }
  await page.reload()
  await page.locator('.compliance-review').waitFor()
  const reviewed = (await records(page, 'workspace'))[0].jobs.find(j => j.id === newId)
  assert.equal(reviewed.complianceReviews.length, 3)
  await goto(page, `/sites/${newId}`)
  await page.getByRole('button', { name: '受注・準備へ進む', exact: true }).click()
  await page.getByText('現在：受注・準備', { exact: true }).waitFor()
  assert.equal(await page.getByRole('button', { name: '施工へ進む', exact: true }).isDisabled(), true)
  await goto(page, `/sites/${newId}/checks`)
  await page.locator('.compliance-profile > summary').click()
  await page.getByRole('button', { name: '2 工種・金額', exact: true }).click()
  await page.getByLabel('自社の請負金額', { exact: false }).fill('5100000')
  await page.getByRole('button', { name: '保存して次の条件へ' }).click()
  await page.locator('.compliance-review .field-eyebrow').filter({ hasText: '再確認が必要' }).waitFor()
  assert.equal((await records(page, 'workspace'))[0].jobs.find(j => j.id === newId).complianceReviews.length, 3)
  await page.setViewportSize({ width: 390, height: 844 })
  await page.locator('.compliance-profile > summary').click()
  await noOverflow(page)
  await screenshot(page, 'compliance-mobile.png')
  checks.push('Profile wizard, evidence reviews persist, one-step gate, prior-stage recheck and history preserved on price change')

  await page.goto(`${origin}#/transactions`)
  await page.getByRole('button', { name: '登録', exact: true }).click()
  await page.getByText('人工・応援は取引実態の審査が必要です。', { exact: false }).waitFor()
  assert.equal(await page.getByText('内容を確認しました', { exact: true }).count(), 0)
  checks.push('Legacy assistance registration cannot bypass review with a checkbox')

  for (const width of [390, 360, 768, 1440]) {
    await page.setViewportSize({ width, height: width < 768 ? 844 : 1000 })
    for (const [route, name] of [['/dashboard', 'home'], ['/sites/sample-door', 'job'], ['/sites/sample-door/checks', 'checks-profile'], [`/sites/${newId}/checks`, 'checks-review'], ['/sites/sample-door/photos', 'photos'], ['/sites/sample-door/notice', 'notice'], ['/sites/sample-door/timeline', 'schedule'], ['/sites/sample-door/paperwork?kind=estimate', 'paper'], ['/documents', 'documents']]) {
      await goto(page, route)
      await noOverflow(page)
      if (width === 390) await screenshot(page, `${name}-mobile.png`)
    }
  }
  checks.push('No page-level horizontal overflow at 360, 390, 768 and 1440 px')

  const denied = await browser.newContext({ viewport: { width: 390, height: 844 }, acceptDownloads: true })
  await routeBuild(denied)
  await denied.addInitScript(() => { navigator.mediaDevices.getUserMedia = async () => { throw new DOMException('Denied in test', 'NotAllowedError') } })
  const fallback = await denied.newPage()
  fallback.on('pageerror', e => failures.push(e.message))
  await goto(fallback, '/sites/sample-door/photos?capture=before')
  await fallback.getByRole('button', { name: '端末のカメラで撮る', exact: true }).waitFor()
  const image = await page.evaluate(async () => {
    const db = await new Promise(resolve => { const r = indexedDB.open('construction-field-workspace', 1); r.onsuccess = () => resolve(r.result) })
    const photos = await new Promise(resolve => { const r = db.transaction('photos').objectStore('photos').getAll(); r.onsuccess = () => resolve(r.result) })
    db.close(); return Array.from(new Uint8Array(await photos[0].blob.arrayBuffer()))
  })
  await fallback.locator('input[type=file]').setInputFiles({ name: 'device.jpg', mimeType: 'image/jpeg', buffer: Buffer.from(image) })
  await fallback.getByText('この工事に1枚保存しました', { exact: true }).waitFor()
  const native = await records(fallback, 'photos')
  assert.equal(native[0].source, 'device-camera')
  assert.equal(native[0].takenAt, null)
  await screenshot(fallback, 'camera-fallback-mobile.png')
  checks.push('Permission denied: native camera fallback auto-saves; capture timestamp stays unconfirmed')
  await denied.close()
  assert.deepEqual(failures, [])
  checks.push('No browser runtime errors')
  await fs.writeFile(path.join(output, 'results.json'), JSON.stringify({ ok: true, checks, browser: browser.version(), note: 'Built files served by Playwright interception; fake camera, not a physical smartphone test.' }, null, 2))
  console.log(JSON.stringify({ ok: true, checks }, null, 2))
} catch (error) {
  const page = context.pages().at(-1)
  if (page) {
    await screenshot(page, 'failure.png')
    console.error(await page.locator('body').innerText())
  }
  throw error
} finally { await browser.close() }
