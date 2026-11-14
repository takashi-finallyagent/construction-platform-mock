import type { Job } from './api'
import type { SitePhoto } from './workflow-model'

const WIDTH = 794, HEIGHT = 1123, LEFT = 48, BOTTOM = 1040
const FONT = '"Yu Gothic", "Meiryo", system-ui, sans-serif'
let library: Promise<void> | null = null
function loadLibrary(): Promise<void> {
  if (window.PDFLib) return Promise.resolve()
  if (!library) library = new Promise<void>((resolve, reject) => {
    const script = document.createElement('script')
    script.src = `${import.meta.env.BASE_URL}vendor/pdf-lib.min.js`
    script.onload = () => window.PDFLib ? resolve() : reject(new Error('PDF作成機能を読み込めませんでした。'))
    script.onerror = () => { library = null; script.remove(); reject(new Error('PDF作成機能を読み込めませんでした。再試行してください。')) }
    document.head.append(script)
  })
  return library
}
function lines(ctx: CanvasRenderingContext2D, text: string, width: number): string[] {
  const output: string[] = []
  let line = ''
  for (const char of text) {
    if (char === '\n' || ctx.measureText(line + char).width > width) { output.push(line); line = char === '\n' ? '' : char }
    else line += char
  }
  output.push(line)
  return output
}
function page(title: string, job: Job, number: number, footer: string) {
  const canvas = document.createElement('canvas')
  canvas.width = WIDTH * 2; canvas.height = HEIGHT * 2
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('帳票の描画を開始できませんでした。')
  ctx.scale(2, 2); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, WIDTH, HEIGHT)
  ctx.fillStyle = '#153b34'; ctx.font = `bold 22px ${FONT}`
  const heading = lines(ctx, title, WIDTH - LEFT * 2)
  heading.forEach((line, index) => ctx.fillText(line, LEFT, 55 + index * 28))
  let y = 80 + heading.length * 28
  ctx.font = `12px ${FONT}`; ctx.fillStyle = '#50665f'
  for (const line of lines(ctx, `${job.name} / ${job.siteAddress}`, WIDTH - LEFT * 2)) { ctx.fillText(line, LEFT, y); y += 19 }
  ctx.strokeStyle = '#146457'; ctx.beginPath(); ctx.moveTo(LEFT, y); ctx.lineTo(WIDTH - LEFT, y); ctx.stroke()
  ctx.font = `10px ${FONT}`; ctx.fillStyle = '#53665f'
  const foot = lines(ctx, footer, WIDTH - LEFT * 2 - 60).slice(0, 2)
  foot.forEach((line, index) => ctx.fillText(line, LEFT, HEIGHT - 39 + index * 14))
  ctx.textAlign = 'right'; ctx.fillText(String(number), WIDTH - LEFT, HEIGHT - 28); ctx.textAlign = 'left'
  return { canvas, ctx, y: y + 28 }
}
async function pdf(pages: HTMLCanvasElement[]): Promise<Blob> {
  await loadLibrary(); await document.fonts.ready
  const pdfDocument = await window.PDFLib!.PDFDocument.create()
  try {
    for (const canvas of pages) {
      const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(result => result ? resolve(result) : reject(new Error('帳票の変換に失敗しました。')), 'image/png'))
      const image = await pdfDocument.embedPng(new Uint8Array(await blob.arrayBuffer()))
      pdfDocument.addPage([595.28, 841.89]).drawImage(image, { x: 0, y: 0, width: 595.28, height: 841.89 })
      canvas.width = 0; canvas.height = 0
    }
    return new Blob([new Uint8Array(await pdfDocument.save()).buffer], { type: 'application/pdf' })
  } finally { for (const canvas of pages) { canvas.width = 0; canvas.height = 0 } }
}
export async function documentPdf(title: string, job: Job, rows: [string, string][], footer = '工事台帳') {
  await document.fonts.ready
  let current = page(title, job, 1, footer)
  const pages = [current.canvas]
  for (const [label, text] of rows) {
    current.ctx.font = `bold 13px ${FONT}`
    if (current.y > BOTTOM - 60) { current = page(title, job, pages.length + 1, footer); pages.push(current.canvas) }
    current.ctx.fillStyle = '#153b34'; current.ctx.fillText(label, LEFT, current.y); current.y += 23
    current.ctx.font = `14px ${FONT}`
    const wrapped = lines(current.ctx, text || '記載なし', WIDTH - LEFT * 2 - 12)
    for (const line of wrapped) {
      if (current.y > BOTTOM) { current = page(title, job, pages.length + 1, footer); pages.push(current.canvas); current.ctx.font = `14px ${FONT}` }
      current.ctx.fillStyle = '#243a34'; current.ctx.fillText(line, LEFT + 8, current.y); current.y += 22
    }
    current.y += 14
  }
  return pdf(pages)
}
export async function photoReportPdf(title: string, job: Job, photos: SitePhoto[], fileUrl: (id: string) => string) {
  if (!photos.length) throw new Error('台帳に含める写真を選んでください。')
  if (photos.length > 100) throw new Error('写真台帳は1冊100枚までです。分けて作成してください。')
  await document.fonts.ready
  const cover = page(title, job, 1, '工事台帳 / 写真原本は非公開保管先に保持')
  const phases = new Set(photos.map(p => p.phase))
  cover.ctx.font = `16px ${FONT}`; cover.ctx.fillStyle = '#243a34'
  cover.ctx.fillText(`写真 ${photos.length}枚`, LEFT, cover.y)
  cover.ctx.fillText(phases.has('before') && phases.has('after') ? '施工前・完成写真を含む記録' : '施工前・完成写真の不足を確認してください。', LEFT, cover.y + 35)
  const pages = [cover.canvas]
  for (let index = 0; index < photos.length; index += 3) {
    const sheet = page(title, job, pages.length + 1, '工事台帳 / 撮影日時未確認は登録時刻と区別')
    pages.push(sheet.canvas)
    for (let offset = 0; offset < 3 && photos[index + offset]; offset++) {
      const photo = photos[index + offset]
      const response = await fetch(fileUrl(photo.fileId), { credentials: 'same-origin', cache: 'no-store' })
      if (!response.ok) throw new Error('写真の取得に失敗しました。認証と通信を確認して再試行してください。')
      const bitmap = await createImageBitmap(await response.blob(), { imageOrientation: 'from-image' })
      try {
        const rowHeight = Math.min(287, (BOTTOM - sheet.y) / 3)
        if (rowHeight < 120) throw new Error('工事名・所在地・台帳名が長すぎて写真を配置できません。台帳名を短くしてください。')
        const top = sheet.y + offset * rowHeight
        const boxWidth = 438, boxHeight = Math.min(246, rowHeight - 24), scale = Math.min(boxWidth / bitmap.width, boxHeight / bitmap.height)
        sheet.ctx.fillStyle = '#f0f3f1'; sheet.ctx.fillRect(LEFT, top, boxWidth, boxHeight)
        sheet.ctx.drawImage(bitmap, LEFT + (boxWidth - bitmap.width * scale) / 2, top + (boxHeight - bitmap.height * scale) / 2, bitmap.width * scale, bitmap.height * scale)
        const labels = [`${index + offset + 1}. ${{ before: '施工前', during: '施工中', after: '完成' }[photo.phase]}`, photo.caption, photo.capturedAt ? new Date(photo.capturedAt).toLocaleString('ja-JP') : '撮影日時: 未確認']
        let y = top + 20
        sheet.ctx.font = `12px ${FONT}`; sheet.ctx.fillStyle = '#243a34'
        for (const text of labels) for (const line of lines(sheet.ctx, text, 205)) {
          if (y > top + boxHeight) throw new Error('写真の説明が長すぎます。台帳用の説明を短くしてください。')
          sheet.ctx.fillText(line, LEFT + boxWidth + 14, y); y += 18
        }
      } finally { bitmap.close() }
    }
  }
  return pdf(pages)
}
export function downloadDocument(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob), link = document.createElement('a')
  link.href = url; link.download = [...name].map(char => char.charCodeAt(0) < 32 || /[\\/:*?"<>|]/.test(char) ? '_' : char).join('')
  document.body.append(link); link.click(); link.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 60000)
}
