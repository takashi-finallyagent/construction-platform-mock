import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import fs from 'node:fs/promises'
import path from 'node:path'
import { parseArgs } from 'node:util'

const { values } = parseArgs({ options: { playwright: { type: 'string' }, browser: { type: 'string' }, out: { type: 'string' }, url: { type: 'string', default: 'http://127.0.0.1:5173/' } } })
const { chromium } = createRequire(import.meta.url)(values.playwright || 'playwright')
const out = path.resolve(values.out || 'test-results')
await fs.mkdir(out, { recursive: true })
const browser = await chromium.launch({ executablePath: values.browser, headless: true })
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true, reducedMotion: 'reduce' })
const page = await context.newPage()
const errors = []
page.on('pageerror', error => errors.push(error.message))
const evidence = { name: 'test-receipt.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4\nMock test evidence\n%%EOF') }
async function auditFields(note, attach = false) {
  await page.getByLabel('記録者', { exact: true }).fill('試験担当')
  await page.getByLabel('根拠・訂正理由', { exact: true }).fill(note)
  if (attach) await page.locator('input[type=file]').setInputFiles(evidence)
}
async function store() {
  return page.evaluate(async () => {
    const db = await new Promise((resolve, reject) => { const r = indexedDB.open('construction-field-workspace', 1); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error) })
    try { return await new Promise((resolve, reject) => { const r = db.transaction('workspace').objectStore('workspace').get('current'); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error) }) } finally { db.close() }
  })
}
async function screenshot(name) {
  await page.evaluate(() => window.scrollTo(0, 0))
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  await page.screenshot({ path: path.join(out, name), fullPage: true, animations: 'disabled' })
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `overflow: ${name}`)
}
try {
  await page.goto(`${values.url}#/sites/sample-door/payments`)
  await page.getByRole('button', { name: '取引を登録', exact: true }).waitFor()
  const today = await page.evaluate(() => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Tokyo' }).format(new Date()))
  const date = days => { const d = new Date(`${today}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10) }
  await page.getByRole('button', { name: '取引を登録', exact: true }).click()
  await page.getByLabel('下請業者名', { exact: true }).fill('検証用建具株式会社')
  await page.getByLabel('契約番号・担当工事', { exact: true }).fill('T-001 / 玄関ドア修繕')
  await page.getByLabel('税込契約総額（円）', { exact: true }).fill('100000')
  await page.getByLabel('支払う自社の建設業許可', { exact: true }).selectOption('special')
  await page.getByLabel('下請業者の特定建設業許可', { exact: true }).selectOption('no')
  await page.getByLabel('下請業者の区分', { exact: true }).selectOption('small')
  await page.getByRole('button', { name: '次へ', exact: true }).click()
  await page.getByLabel('支払期日の合意', { exact: true }).selectOption('agreed')
  await page.getByLabel('期日 1', { exact: true }).fill(date(-30))
  await page.getByLabel('支払額 1（円）', { exact: true }).fill('20000')
  await page.getByRole('button', { name: '分割支払を追加', exact: true }).click()
  await page.getByLabel('期日 2', { exact: true }).fill(date(30))
  await page.getByLabel('支払額 2（円）', { exact: true }).fill('80000')
  await page.getByLabel('引渡特約', { exact: true }).selectOption('none')
  await page.setViewportSize({ width: 360, height: 800 })
  await screenshot('payment-registration-360.png')
  await page.getByRole('button', { name: '次へ', exact: true }).click()
  await auditFields('契約原本の金額と支払日を確認した試験記録です。', true)
  await page.getByRole('button', { name: '取引条件を保存', exact: true }).click()
  await page.locator('.payment-overview').waitFor()
  const route = page.url()
  assert.match(await page.locator('.payment-overview').innerText(), /20,000/)

  async function add(label, days, amount, note, attach = false) {
    await page.getByRole('button', { name: label, exact: true }).click()
    await page.getByLabel('実績日', { exact: true }).fill(date(days))
    if (amount) await page.getByLabel('実績金額', { exact: true }).fill(String(amount))
    await auditFields(note, attach)
    await page.getByRole('button', { name: '実績を保存', exact: true }).click()
    await page.getByRole('status').filter({ hasText: '実績をこの端末に保存しました' }).waitFor()
    assert.equal(await page.getByRole('alert').count(), 0)
  }
  await add('完成通知を受けた', -55, null, '下請から完成通知を受信した日付を確認しました。')
  await add('検査を完了した', -54, null, '検査記録と完成通知を照合した試験データです。')
  await add('引渡しの申出を受けた', -50, null, '引渡しの申出メールの日付を確認した記録です。')
  await add('上位業者から入金があった', -60, 40000, '上位業者の出来高入金のうち本契約に対応する金額です。')
  await add('下請へ支払った', -40, 30000, '実行済み振込結果を照合した一部支払の試験です。', true)
  assert.match(await page.locator('.payment-overview').innerText(), /管理期限超過 ¥70,000/)
  await page.reload()
  await page.locator('.payment-overview').waitFor()
  assert.match(await page.locator('.payment-overview').innerText(), /管理期限超過 ¥70,000/)
  const persisted = await store()
  assert.equal(persisted.jobs.find(job => job.id === 'sample-door').paymentCases[0].events.length, 5)
  for (const width of [1440, 768, 390, 360]) {
    await page.setViewportSize({ width, height: 1000 })
    await screenshot(`payment-detail-${width}.png`)
  }

  // Reject a storage failure without reporting a payment or losing the pending form.
  await page.getByRole('button', { name: '下請へ支払った', exact: true }).click()
  await page.getByLabel('実績日', { exact: true }).fill(today)
  await page.getByLabel('実績金額', { exact: true }).fill('70000')
  await auditFields('残金の実行済み振込結果を照合した試験記録です。', true)
  await page.evaluate(() => {
    window.savedPut = IDBObjectStore.prototype.put
    IDBObjectStore.prototype.put = function (...args) { if (this.name === 'workspace') throw new DOMException('Injected quota error', 'QuotaExceededError'); return window.savedPut.apply(this, args) }
  })
  await page.getByRole('button', { name: '実績を保存', exact: true }).click()
  await page.getByRole('alert').waitFor()
  assert.equal(await page.getByLabel('実績金額', { exact: true }).inputValue(), '70000')
  assert.match(await page.locator('.payment-overview').innerText(), /管理期限超過 ¥70,000/)
  assert.equal(await page.getByRole('status').count(), 0)
  await page.evaluate(() => { IDBObjectStore.prototype.put = window.savedPut })
  await page.getByRole('button', { name: '実績を保存', exact: true }).click()
  await page.getByRole('status').filter({ hasText: '実績をこの端末に保存しました' }).waitFor()
  assert.match(await page.locator('.payment-overview').innerText(), /支払記録あり・遅延履歴あり/)
  assert.match(await page.locator('.payment-deadlines').innerText(), /期限時点の不足 ¥70,000/)
  await screenshot('payment-paid-late-360.png')

  await page.locator('.payment-history > summary').click()
  await page.getByRole('button', { name: 'この記録を訂正する', exact: true }).first().click()
  await auditFields('別契約の振込を誤って記録したため訂正対象とします。')
  await page.getByRole('button', { name: '訂正理由を保存', exact: true }).click()
  await page.getByRole('status').filter({ hasText: '実績をこの端末に保存しました' }).waitFor()
  assert.match(await page.locator('.payment-overview').innerText(), /管理期限超過 ¥70,000/)
  assert.match(await page.locator('.payment-history').innerText(), /訂正対象・現在の計算から除外/)

  await page.getByRole('button', { name: '取引条件を訂正', exact: true }).click()
  await page.getByLabel('契約番号・担当工事', { exact: true }).fill('T-001 / 工事範囲の名称訂正')
  await page.getByRole('button', { name: '3. 記録を残す', exact: true }).click()
  await auditFields('契約番号を維持して工事範囲の表示名称だけを訂正しました。')
  await page.getByRole('button', { name: '取引条件を保存', exact: true }).click()
  await page.getByRole('status').filter({ hasText: '取引条件の訂正を保存しました' }).waitFor()
  await page.reload()
  await page.locator('.payment-overview').waitFor()
  const saved = (await store()).jobs.find(job => job.id === 'sample-door').paymentCases[0]
  assert.equal(saved.events.length, 7)
  assert.equal(saved.revisions.length, 2)
  assert.ok(saved.revisions[0].evidence instanceof Object)
  await page.locator('.payment-history > summary').click()
  const downloadEvent = page.waitForEvent('download')
  await page.getByRole('button', { name: 'test-receipt.pdf', exact: true }).first().click()
  const download = await downloadEvent
  const downloaded = path.join(out, 'stored-evidence.pdf')
  await download.saveAs(downloaded)
  assert.equal(await download.failure(), null)
  assert.equal((await fs.readFile(downloaded)).subarray(0, 5).toString(), '%PDF-')
  await page.goto(`${values.url}#/sites/sample-door`)
  await page.getByText('工事の基本情報・これまでの記録', { exact: true }).click()
  await page.locator('.job-basics input[name=contact]').fill('試験連絡先 03-0000-1111')
  await page.getByRole('button', { name: '基本情報を保存', exact: true }).click()
  await page.getByRole('status').filter({ hasText: '基本情報をこの端末に保存しました' }).waitFor()
  assert.equal((await store()).jobs.find(job => job.id === 'sample-door').paymentCases[0].events.length, 7)

  // A finished job must remain in home alerts. Only this isolated test context is edited.
  await page.evaluate(async () => {
    const db = await new Promise(resolve => { const r = indexedDB.open('construction-field-workspace', 1); r.onsuccess = () => resolve(r.result) })
    await new Promise((resolve, reject) => {
      const tx = db.transaction('workspace', 'readwrite'); const store = tx.objectStore('workspace'); const request = store.get('current')
      request.onsuccess = () => { const data = request.result; data.jobs.find(job => job.id === 'sample-door').stage = 3; store.put(data, 'current') }
      tx.oncomplete = resolve; tx.onerror = () => reject(tx.error)
    }); db.close()
  })
  await page.goto(`${values.url}#/dashboard`)
  await page.reload()
  await page.locator('.payment-alerts').waitFor()
  assert.match(await page.locator('.payment-alerts').innerText(), /検証用建具株式会社/)
  await screenshot('payment-home-alert-360.png')
  await page.locator('.payment-alerts a').first().click()
  assert.equal(page.url(), route)
  assert.deepEqual(errors, [])
  const result = { ok: true, tests: ['progressive registration', 'split deadlines', 'notification/inspection/offer dates', 'partial receipt/payment', 'persistent reload', 'quota failure and retry', 'late payment history', 'append-only correction', 'term revision history', 'stored evidence download', 'job edits preserve payments', 'finished-job alert'], widths: [360, 390, 768, 1440] }
  await fs.writeFile(path.join(out, 'payment-results.json'), JSON.stringify(result, null, 2))
  console.log(JSON.stringify(result))
} catch (error) {
  await screenshot('payment-failure.png').catch(() => {})
  throw error
} finally { await context.close(); await browser.close() }
