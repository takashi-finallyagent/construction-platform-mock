import { formatDay, localDate, phaseLabels, type FieldJob, type FieldPhoto, type PaperKind, paperLabels } from './model'
import type { NoticeInput, PaperLine } from './model'
export type { NoticeInput, PaperLine } from './model'

interface PdfPage { drawImage: (image: unknown, options: { x: number; y: number; width: number; height: number }) => void }
interface PdfDocument { embedPng: (bytes: Uint8Array) => Promise<unknown>; addPage: (size: number[]) => PdfPage; save: () => Promise<Uint8Array> }
declare global { interface Window { PDFLib?: { PDFDocument: { create: () => Promise<PdfDocument> } } } }

const FONT = '"Yu Gothic", "Meiryo", system-ui, sans-serif'
const WIDTH = 794
const HEIGHT = 1123

function sheet(title: string, job: FieldJob, pageNumber = 1) {
  const canvas = document.createElement('canvas')
  canvas.width = WIDTH * 2
  canvas.height = HEIGHT * 2
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('帳票を作成できませんでした。')
  ctx.scale(2, 2)
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, WIDTH, HEIGHT)
  ctx.fillStyle = '#192e2a'
  ctx.font = `bold 27px ${FONT}`
  ctx.fillText(title, 52, 74)
  ctx.fillStyle = '#61736c'
  ctx.font = `13px ${FONT}`
  ctx.fillText(job.company, 52, 103)
  ctx.textAlign = 'right'
  ctx.fillText(localDate(), WIDTH - 52, 103)
  ctx.textAlign = 'left'
  ctx.strokeStyle = '#176b5c'
  ctx.lineWidth = 2
  ctx.beginPath(); ctx.moveTo(52, 121); ctx.lineTo(WIDTH - 52, 121); ctx.stroke()
  ctx.font = `11px ${FONT}`
  ctx.fillText('建設業務台帳 / サンプル・端末保存版', 52, HEIGHT - 33)
  ctx.textAlign = 'right'; ctx.fillText(`${pageNumber}`, WIDTH - 52, HEIGHT - 33); ctx.textAlign = 'left'
  return { canvas, ctx }
}

function textLines(ctx: CanvasRenderingContext2D, value: string, width: number) {
  const lines: string[] = []
  let current = ''
  for (const char of value) {
    if (char === '\n' || ctx.measureText(current + char).width > width) {
      lines.push(current); current = char === '\n' ? '' : char
    } else current += char
  }
  if (current) lines.push(current)
  return lines
}
function wrap(ctx: CanvasRenderingContext2D, value: string, x: number, y: number, width: number, size = 16, lineHeight = 27) {
  ctx.font = `${size}px ${FONT}`
  ctx.fillStyle = '#263f36'
  for (const line of textLines(ctx, value, width)) { ctx.fillText(line, x, y); y += lineHeight }
  return y
}

function rows(ctx: CanvasRenderingContext2D, data: [string, string][], y = 165) {
  for (const [label, value] of data) {
    ctx.font = `15px ${FONT}`
    const height = Math.max(52, textLines(ctx, value, 500).length * 21 + 16)
    ctx.fillStyle = '#f0f5f2'; ctx.fillRect(52, y - 22, 156, height)
    ctx.fillStyle = '#52685b'; ctx.font = `14px ${FONT}`; ctx.fillText(label, 66, y + 7)
    wrap(ctx, value, 225, y + 7, 500, 15, 21)
    ctx.strokeStyle = '#dbe4de'; ctx.beginPath(); ctx.moveTo(52, y - 22 + height); ctx.lineTo(WIDTH - 52, y - 22 + height); ctx.stroke()
    y += height + 4
  }
  return y
}

async function toPdf(pages: HTMLCanvasElement[]) {
  if (!window.PDFLib) throw new Error('PDF作成機能を読み込めませんでした。画面を再読込してください。')
  await document.fonts.ready
  const doc = await window.PDFLib.PDFDocument.create()
  for (const canvas of pages) {
    const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((result) => result ? resolve(result) : reject(new Error('帳票の変換に失敗しました。')), 'image/png'))
    const image = await doc.embedPng(new Uint8Array(await blob.arrayBuffer()))
    doc.addPage([595.28, 841.89]).drawImage(image, { x: 0, y: 0, width: 595.28, height: 841.89 })
    canvas.width = 0; canvas.height = 0
  }
  const bytes = await doc.save()
  return new Blob([new Uint8Array(bytes).buffer], { type: 'application/pdf' })
}

async function imageFromBlob(blob: Blob) {
  const url = URL.createObjectURL(blob)
  try {
    const image = new Image()
    await new Promise<void>((resolve, reject) => { image.onload = () => resolve(); image.onerror = () => reject(new Error('写真を読み込めませんでした。')); image.src = url })
    return image
  } finally { URL.revokeObjectURL(url) }
}

export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url; link.download = filename; document.body.append(link); link.click(); link.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 60000)
}

export function noticePreamble(title: string) {
  if (title.includes('中止')) return '下記の工事は中止となりました。予定していた作業は実施いたしません。'
  if (title.includes('延期')) return '下記の予定でご案内していた工事を延期いたします。変更後の日程は追記事項をご確認ください。'
  if (title.includes('日程変更')) return '工事の日程を下記のとおり変更いたします。変更前の日程は追記事項をご確認ください。'
  if (title.includes('完了')) return '下記の工事が完了いたしました。工事期間中のご理解とご協力に感謝申し上げます。'
  return '下記のとおり工事を実施いたします。ご理解とご協力をお願いいたします。'
}
export const noticeHasImpacts = (title: string) => !['中止', '延期', '完了'].some((word) => title.includes(word))
export const impactTexts: Record<string, string> = {
  noise: '作業中は工事音・振動が発生します。対象の日時は上記をご確認ください。',
  water: '上記の時間帯は断水します。必要な水を事前にご準備ください。',
  power: '上記の時間帯は対象設備が停電します。使用中の電気機器にご注意ください。',
  access: '作業区域周辺は通行が制限されます。現地の案内に従って通行してください。',
  elevator: '上記の時間帯はエレベーターの利用が制限されます。',
  dust: '粉じん・臭気が発生する場合があります。窓や洗濯物にご注意ください。',
  presence: '対象住戸への入室・お立会いが必要です。ご都合が合わない場合は担当者へご連絡ください。',
}
export async function noticePdf(job: FieldJob, input: NoticeInput) {
  let { canvas, ctx } = sheet(input.title, job)
  const pages = [canvas]
  const nextPage = () => { const page = sheet(input.title, job, pages.length + 1); canvas = page.canvas; ctx = page.ctx; pages.push(canvas) }
  let y = wrap(ctx, input.recipient, 52, 166, 690, 18)
  y = wrap(ctx, noticePreamble(input.title), 52, y + 25, 690)
  const periodLabel = input.title.includes('延期') || input.title.includes('中止') ? '当初予定期間' : input.title.includes('完了') ? '実施期間' : '作業期間'
  y = rows(ctx, [['建物・場所', `${job.building} / ${job.part}`], ['作業内容', input.work], [periodLabel, `${input.start} ～ ${input.end}`], ['作業時間', `${input.startTime} ～ ${input.endTime}`]], y + 40)
  y += 23
  const paragraphs = [...(noticeHasImpacts(input.title) ? input.impacts.map((key) => `・${impactTexts[key] ?? key}`) : []), input.extra].filter(Boolean)
  for (const paragraph of paragraphs) {
    ctx.font = `15px ${FONT}`
    const lines = textLines(ctx, paragraph, 690)
    for (const line of lines) {
      if (y > 1015) { nextPage(); y = 165 }
      ctx.font = `15px ${FONT}`; ctx.fillStyle = '#263f36'; ctx.fillText(line, 52, y); y += 24
    }
    y += 12
  }
  if (y > 880) { nextPage(); y = 165 }
  rows(ctx, [['施工会社', job.company], ['問い合わせ先', job.contact]], Math.max(y + 35, 850))
  return toPdf(pages)
}
export async function albumPdf(job: FieldJob, photos: FieldPhoto[]) {
  if (!photos.length) throw new Error('写真を撮影してから台帳を作成してください。')
  const cover = sheet('工事記録・写真台帳', job)
  rows(cover.ctx, [['提出先', job.client], ['建物', job.building], ['工事', job.name], ['部位・フロア', job.part], ['施工期間', `${job.start} ～ ${job.end}`], ['写真枚数', `${photos.length}枚`]])
  const phases = new Set(photos.map((photo) => photo.phase))
  wrap(cover.ctx, phases.has('before') && phases.has('after') ? '施工前・完成写真を含む記録' : '作成中：施工前または完成写真が不足しています。', 52, 580, 690)
  const pages = [cover.canvas]
  const ordered = [...photos].sort((a, b) => a.savedAt.localeCompare(b.savedAt))
  for (let i = 0; i < ordered.length; i += 3) {
    const page = sheet('工事写真', job, pages.length + 1)
    for (let j = 0; j < 3 && ordered[i + j]; j++) {
      const photo = ordered[i + j]
      const top = 149 + j * 293
      const image = await imageFromBlob(photo.blob)
      page.ctx.fillStyle = '#f2f5f3'; page.ctx.fillRect(52, top, 445, 265)
      const factor = Math.min(445 / image.width, 265 / image.height)
      page.ctx.drawImage(image, 52 + (445 - image.width * factor) / 2, top + (265 - image.height * factor) / 2, image.width * factor, image.height * factor)
      let y = wrap(page.ctx, `${i + j + 1} / ${phaseLabels[photo.phase]}`, 516, top + 23, 226, 17, 23)
      y = wrap(page.ctx, photo.part, 516, y + 8, 226, 12, 18)
      y = wrap(page.ctx, photo.caption, 516, y + 8, 226, 12, 18)
      wrap(page.ctx, photo.takenAt ? new Date(photo.takenAt).toLocaleString('ja-JP') : '撮影日時：未確認', 516, y + 8, 226, 10, 16)
    }
    pages.push(page.canvas)
  }
  return toPdf(pages)
}
export async function schedulePdf(job: FieldJob) {
  if (!job.tasks.length) throw new Error('工程を追加してください。')
  const pages: HTMLCanvasElement[] = []
  for (let offset = 0; offset < job.tasks.length; offset += 6) {
    const { canvas, ctx } = sheet('工事工程表', job, pages.length + 1)
    let y = wrap(ctx, `${job.building} / ${job.name}`, 52, 164, 690, 20) + 25
    for (const task of job.tasks.slice(offset, offset + 6)) {
      y = wrap(ctx, `${task.name}　［${task.status}］`, 52, y, 690, 17)
      y = wrap(ctx, `${task.start} ${task.startTime} ～ ${task.end} ${task.endTime}　${task.company}`, 52, y, 690, 13) + 20
    }
    pages.push(canvas)
  }
  return toPdf(pages)
}
export async function paperPdf(job: FieldJob, kind: PaperKind, lines: PaperLine[], dueDate: string) {
  if (lines.length > 6) throw new Error('1帳票につき明細は6行までです。')
  const draft = kind === 'order' || kind === 'receipt'
  const title = `${paperLabels[kind]}${draft ? '（下書き）' : ''}`
  let { canvas, ctx } = sheet(title, job)
  const pages = [canvas]
  let y = draft ? wrap(ctx, '契約未成立の下書き。約款・必要事項・双方の交付等を別途確認してください。', 52, 155, 690, 12, 20) + 15 : 169
  y = wrap(ctx, `${job.client} 御中`, 52, y, 690, 19)
  y = wrap(ctx, job.name, 52, y + 18, 690, 20) + 25
  let subtotal = 0
  for (const item of lines) {
    const amount = item.amount ?? Math.round(item.quantity * item.unitPrice)
    subtotal += amount
    y = wrap(ctx, item.name, 52, y, 470, 16)
    ctx.textAlign = 'right'; ctx.fillText(`¥${amount.toLocaleString('ja-JP')}`, 740, y - 27); ctx.textAlign = 'left'
    y = wrap(ctx, `${item.quantity} ${item.unit}${item.amount === null ? ` × ¥${item.unitPrice.toLocaleString('ja-JP')}` : '（一式金額）'}`, 52, y, 690, 12, 20) + 10
  }
  if (y + 330 > 1045) { const page = sheet(title, job, 2); canvas = page.canvas; ctx = page.ctx; pages.push(canvas); y = 165 }
  rows(ctx, [['小計', `¥${subtotal.toLocaleString('ja-JP')}`], ['消費税 10%', `¥${Math.round(subtotal * 0.1).toLocaleString('ja-JP')}`], ['合計', `¥${(subtotal + Math.round(subtotal * 0.1)).toLocaleString('ja-JP')}`], [kind === 'estimate' ? '有効期限' : '支払期限（入力値）', dueDate], ['支払条件', '別途合意が必要。法定支払期限との整合は未確認。']], Math.max(y + 18, 520))
  return toPdf(pages)
}

export function filename(job: FieldJob, title: string) {
  return `${localDate()}_${job.name}_${title}.pdf`.replace(/[\\/:*?"<>|]/g, '_')
}
export function noticeDefaults(job: FieldJob): NoticeInput {
  return { title: '工事のお知らせ', recipient: `${job.building}にお住まいの皆様へ`, start: job.start, end: job.end, startTime: '09:00', endTime: '17:00', work: job.name, impacts: ['noise'], extra: '天候・現場状況により日程が変更になる場合があります。' }
}
export const dayText = (start: string, end: string) => start === end ? formatDay(start) : `${formatDay(start)} ～ ${formatDay(end)}`
