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
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true, reducedMotion: 'reduce' })
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 })
    for (const route of ['sites/site-yokohama', 'sites/site-yokohama/checks']) {
      await page.goto(`${values.url}#/${route}`)
      await page.locator('.field-page').waitFor()
      await page.evaluate(() => window.scrollTo(0, 0))
      await page.screenshot({ path: path.join(out, `live-${route.endsWith('checks') ? 'checks' : 'job'}-${width}.png`), animations: 'disabled' })
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1))
    }
  }
  await page.goto(`${values.url}#/sites/sample-door/paperwork?kind=order`)
  await page.locator('.paper-editor').waitFor()
  await page.evaluate(() => {
    window.pdfTexts = []
    const original = CanvasRenderingContext2D.prototype.fillText
    CanvasRenderingContext2D.prototype.fillText = function (...args) { window.pdfTexts.push(args[0]); return original.apply(this, args) }
  })
  const promise = page.waitForEvent('download')
  await page.getByRole('button', { name: 'PDFを発行・ダウンロード' }).click()
  const download = await promise
  assert.match(download.suggestedFilename(), /下書き/)
  const file = path.join(out, 'order-draft-live.pdf')
  await download.saveAs(file)
  assert.equal(await download.failure(), null)
  assert.equal((await fs.readFile(file)).subarray(0, 5).toString(), '%PDF-')
  const text = (await page.evaluate(() => window.pdfTexts)).join('\n')
  assert.match(text, /契約未成立の下書き/)
  assert.match(text, /法定支払期限との整合は未確認/)
  assert.doesNotMatch(text, /月末締め翌月末払い/)
  assert.deepEqual(errors, [])
  console.log(JSON.stringify({ ok: true, url: values.url, actualDownload: true, draftWarning: true, widths: [1440, 390] }))
} finally { await browser.close() }
