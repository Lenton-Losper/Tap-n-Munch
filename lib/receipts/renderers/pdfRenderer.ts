import { PDFDocument, PDFFont, PDFPage, StandardFonts, rgb } from 'pdf-lib'
import type { ReceiptLineItem, ReceiptPayment, ReceiptSnapshot } from '@/lib/receipts/issueReceipt'
import { formatPaymentLabel } from '@/lib/receipts/formatPaymentLabel'

/**
 * Pure PDF renderer for a receipt snapshot. Enforced boundary: this file must never
 * import a Supabase client or take an orderId -- it only knows how to turn the
 * already-assembled snapshot_json shape (plus caller-supplied document metadata) into PDF
 * bytes. Any DB/order/payment lookup belongs in lib/receipts/issueReceipt.ts, not here.
 *
 * Layout/constants mirror lib/documents/generate-document-pdf.ts (the existing invoice/
 * quote PDF generator) -- same page size, font embedding, palette, and table-drawing
 * approach, adapted for receipt content (no ship/bill-to, no bank details; adds a
 * payment-method section instead).
 */

// Portrait A4 (points)
const PAGE_WIDTH = 595.28
const PAGE_HEIGHT = 841.89
const MARGIN = 40
const FOOTER_AREA = 36

const BRAND_BLUE = rgb(46 / 255, 117 / 255, 182 / 255)
const TEXT_DARK = rgb(26 / 255, 26 / 255, 26 / 255)
const TEXT_MUTED = rgb(102 / 255, 102 / 255, 102 / 255)
const TEXT_FOOTER = rgb(153 / 255, 153 / 255, 153 / 255)
const ROW_ALT_BG = rgb(248 / 255, 250 / 255, 252 / 255)
const BORDER_LIGHT = rgb(238 / 255, 238 / 255, 238 / 255)
const BORDER_FOOTER = rgb(204 / 255, 204 / 255, 204 / 255)
const WHITE = rgb(1, 1, 1)

const BODY_SIZE = 9
const SMALL_SIZE = 8
const RESTAURANT_NAME_SIZE = 18
const DOC_TYPE_SIZE = 12
const DOC_META_SIZE = 9
const TABLE_HEADER_SIZE = 8
const TOTAL_LABEL_SIZE = 9
const TOTAL_VALUE_SIZE = 10
const TOTAL_GRAND_SIZE = 12
const PAYMENT_SIZE = 9
const FOOTER_SIZE = 7

const ROW_LINE_HEIGHT = 11
const ROW_PADDING_Y = 5
const MIN_ROW_HEIGHT = 18
const TABLE_HEADER_HEIGHT = 20

export interface PdfRenderOptions {
  documentNumber?: string
  issuedAt?: string
}

import { formatReceiptMoney } from '@/lib/receipts/renderers/formatReceiptMoney'

function formatMoney(value: number, currency = 'NAD'): string {
  return formatReceiptMoney(value, currency)
}

function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—'
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return '—'
  const day = String(date.getDate()).padStart(2, '0')
  const month = date.toLocaleString('en-GB', { month: 'short' })
  const year = date.getFullYear()
  return `${day} ${month} ${year}`
}

function wrapText(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const normalized = text.trim() || '—'
  const words = normalized.split(/\s+/)
  const lines: string[] = []
  let current = ''

  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word
    if (font.widthOfTextAtSize(candidate, size) <= maxWidth) {
      current = candidate
      continue
    }
    if (current) lines.push(current)
    if (font.widthOfTextAtSize(word, size) > maxWidth) {
      let chunk = ''
      for (const char of word) {
        const next = chunk + char
        if (font.widthOfTextAtSize(next, size) > maxWidth && chunk) {
          lines.push(chunk)
          chunk = char
        } else {
          chunk = next
        }
      }
      current = chunk
    } else {
      current = word
    }
  }
  if (current) lines.push(current)
  return lines.length > 0 ? lines : ['—']
}

function drawRightText(
  page: PDFPage,
  text: string,
  rightX: number,
  y: number,
  font: PDFFont,
  size: number,
  color: ReturnType<typeof rgb>,
) {
  const width = font.widthOfTextAtSize(text, size)
  page.drawText(text, { x: rightX - width, y, size, font, color })
}

function centeredText(
  page: PDFPage,
  text: string,
  centerX: number,
  y: number,
  font: PDFFont,
  size: number,
  color: ReturnType<typeof rgb>,
) {
  const width = font.widthOfTextAtSize(text, size)
  page.drawText(text, { x: centerX - width / 2, y, size, font, color })
}

function drawHeaderBlock(
  page: PDFPage,
  snapshot: ReceiptSnapshot,
  options: PdfRenderOptions,
  fonts: { regular: PDFFont; bold: PDFFont },
  yTop: number,
): number {
  const contentWidth = PAGE_WIDTH - MARGIN * 2
  const centerX = MARGIN + contentWidth / 2
  const rightX = MARGIN + contentWidth
  let y = yTop

  centeredText(page, snapshot.outlet.restaurant_name, centerX, y - RESTAURANT_NAME_SIZE, fonts.bold, RESTAURANT_NAME_SIZE, TEXT_DARK)
  y -= RESTAURANT_NAME_SIZE + 4

  if (snapshot.outlet.address) {
    centeredText(page, snapshot.outlet.address, centerX, y - SMALL_SIZE, fonts.regular, SMALL_SIZE, TEXT_MUTED)
    y -= SMALL_SIZE + 4
  }
  if (snapshot.outlet.vat_number) {
    centeredText(
      page,
      `VAT: ${snapshot.outlet.vat_number}`,
      centerX,
      y - SMALL_SIZE,
      fonts.regular,
      SMALL_SIZE,
      TEXT_MUTED,
    )
    y -= SMALL_SIZE + 4
  }
  if (!snapshot.outlet.address && !snapshot.outlet.vat_number) {
    y -= 10
  } else {
    y -= 10
  }

  centeredText(page, 'RECEIPT', centerX, y - DOC_TYPE_SIZE, fonts.bold, DOC_TYPE_SIZE, BRAND_BLUE)
  y -= DOC_TYPE_SIZE + 12

  if (options.documentNumber) {
    page.drawText(`#${options.documentNumber}`, {
      x: MARGIN,
      y: y - DOC_META_SIZE,
      size: DOC_META_SIZE,
      font: fonts.regular,
      color: TEXT_DARK,
    })
  }
  if (options.issuedAt) {
    drawRightText(page, `Issued: ${formatDate(options.issuedAt)}`, rightX, y - DOC_META_SIZE, fonts.regular, DOC_META_SIZE, TEXT_DARK)
  }
  y -= DOC_META_SIZE + 10

  page.drawLine({
    start: { x: MARGIN, y },
    end: { x: rightX, y },
    thickness: 1.5,
    color: BRAND_BLUE,
  })

  return y - 20
}

type TableRowLayout = {
  item: ReceiptLineItem
  rowIndex: number
  height: number
  nameLines: string[]
}

function layoutTableRows(items: ReceiptLineItem[], font: PDFFont, nameWidth: number): TableRowLayout[] {
  return items.map((item, rowIndex) => {
    const nameLines = wrapText(item.name, font, BODY_SIZE, nameWidth - 4)
    const maxLines = Math.max(1, nameLines.length)
    const height = Math.max(MIN_ROW_HEIGHT, maxLines * ROW_LINE_HEIGHT + ROW_PADDING_Y * 2)
    return { item, rowIndex, height, nameLines }
  })
}

function drawLineItemsTable(
  page: PDFPage,
  snapshot: ReceiptSnapshot,
  fonts: { regular: PDFFont; bold: PDFFont },
  yTop: number,
): number {
  const contentWidth = PAGE_WIDTH - MARGIN * 2
  const qtyWidth = 36
  const unitWidth = 80
  const totalWidth = 80
  const nameWidth = contentWidth - qtyWidth - unitWidth - totalWidth

  const qtyX = MARGIN
  const nameX = qtyX + qtyWidth
  const unitX = nameX + nameWidth
  const totalX = unitX + unitWidth
  const rightX = MARGIN + contentWidth

  let y = yTop - TABLE_HEADER_HEIGHT
  page.drawRectangle({ x: MARGIN, y, width: contentWidth, height: TABLE_HEADER_HEIGHT, color: BRAND_BLUE })

  const headers = [
    { label: 'Qty', x: qtyX + 4 },
    { label: 'Item', x: nameX + 4 },
    { label: 'Unit Price', x: unitX + 4 },
    { label: 'Total', x: totalX + 4 },
  ]
  for (const header of headers) {
    page.drawText(header.label, { x: header.x, y: y + 6, size: TABLE_HEADER_SIZE, font: fonts.bold, color: WHITE })
  }

  y -= 1
  const rows = layoutTableRows(snapshot.line_items, fonts.regular, nameWidth)

  for (const row of rows) {
    const yBottom = y - row.height

    if (row.rowIndex % 2 === 1) {
      page.drawRectangle({ x: MARGIN, y: yBottom, width: contentWidth, height: row.height, color: ROW_ALT_BG, borderColor: ROW_ALT_BG })
    }

    page.drawText(String(row.item.quantity), {
      x: qtyX + 4,
      y: y - ROW_PADDING_Y - BODY_SIZE,
      size: BODY_SIZE,
      font: fonts.regular,
      color: TEXT_DARK,
    })

    let nameY = y - ROW_PADDING_Y - BODY_SIZE
    for (const line of row.nameLines) {
      page.drawText(line, { x: nameX + 4, y: nameY, size: BODY_SIZE, font: fonts.regular, color: TEXT_DARK })
      nameY -= ROW_LINE_HEIGHT
    }

    const unitText = formatMoney(row.item.unit_price, snapshot.outlet.currency)
    const unitTextWidth = fonts.regular.widthOfTextAtSize(unitText, BODY_SIZE)
    page.drawText(unitText, {
      x: unitX + unitWidth - unitTextWidth - 4,
      y: y - ROW_PADDING_Y - BODY_SIZE,
      size: BODY_SIZE,
      font: fonts.regular,
      color: TEXT_DARK,
    })

    const lineTotalText = formatMoney(row.item.line_total, snapshot.outlet.currency)
    const lineTotalWidth = fonts.regular.widthOfTextAtSize(lineTotalText, BODY_SIZE)
    page.drawText(lineTotalText, {
      x: totalX + totalWidth - lineTotalWidth - 4,
      y: y - ROW_PADDING_Y - BODY_SIZE,
      size: BODY_SIZE,
      font: fonts.regular,
      color: TEXT_DARK,
    })

    page.drawLine({ start: { x: MARGIN, y: yBottom }, end: { x: rightX, y: yBottom }, thickness: 1, color: BORDER_LIGHT })

    y = yBottom
  }

  return y - 16
}

function drawTotalsBlock(
  page: PDFPage,
  snapshot: ReceiptSnapshot,
  fonts: { regular: PDFFont; bold: PDFFont },
  yTop: number,
): number {
  const contentWidth = PAGE_WIDTH - MARGIN * 2
  const rightX = MARGIN + contentWidth
  const labelX = rightX - 160

  const currency = snapshot.outlet.currency || 'NAD'
  const lines: { label: string; value: string; bold?: boolean; grand?: boolean }[] = [
    { label: 'Subtotal', value: formatMoney(snapshot.totals.subtotal, currency) },
    { label: 'VAT', value: formatMoney(snapshot.totals.vat, currency) },
  ]
  if (snapshot.totals.discount > 0) {
    lines.push({ label: 'Discount', value: `-${formatMoney(snapshot.totals.discount, currency)}` })
  }
  lines.push({
    label: 'Total',
    value: formatMoney(snapshot.totals.grand_total, currency),
    bold: true,
    grand: true,
  })

  let y = yTop
  for (const line of lines) {
    const size = line.grand ? TOTAL_GRAND_SIZE : line.bold ? TOTAL_VALUE_SIZE : TOTAL_LABEL_SIZE
    const font = line.bold ? fonts.bold : fonts.regular
    page.drawText(line.label, { x: labelX, y: y - size, size, font, color: TEXT_DARK })
    drawRightText(page, line.value, rightX, y - size, font, size, TEXT_DARK)
    y -= size + (line.grand ? 10 : 8)
  }

  return y - 4
}

/**
 * The customer's order-level note (#135), wrapped to the content width. Nothing is drawn for
 * a snapshot with no note, including every snapshot frozen before the field existed.
 */
function drawOrderNoteBlock(
  page: PDFPage,
  snapshot: ReceiptSnapshot,
  fonts: { regular: PDFFont; bold: PDFFont },
  yTop: number,
): number {
  const note =
    typeof snapshot.order_instructions === 'string' ? snapshot.order_instructions.trim() : ''
  if (!note) return yTop

  const contentWidth = PAGE_WIDTH - MARGIN * 2
  let y = yTop

  page.drawLine({ start: { x: MARGIN, y }, end: { x: MARGIN + contentWidth, y }, thickness: 1, color: BORDER_LIGHT })
  y -= 16

  page.drawText('ORDER NOTE', { x: MARGIN, y: y - SMALL_SIZE, size: SMALL_SIZE, font: fonts.bold, color: TEXT_MUTED })
  y -= SMALL_SIZE + 8

  for (const line of wrapText(note, fonts.regular, BODY_SIZE, contentWidth)) {
    page.drawText(line, { x: MARGIN, y: y - BODY_SIZE, size: BODY_SIZE, font: fonts.regular, color: TEXT_DARK })
    y -= ROW_LINE_HEIGHT
  }

  return y - 8
}

function drawPaymentsBlock(
  page: PDFPage,
  payments: ReceiptPayment[],
  fonts: { regular: PDFFont; bold: PDFFont },
  yTop: number,
  currency = 'NAD',
): number {
  if (payments.length === 0) return yTop

  const contentWidth = PAGE_WIDTH - MARGIN * 2
  const rightX = MARGIN + contentWidth
  let y = yTop

  page.drawLine({ start: { x: MARGIN, y }, end: { x: rightX, y }, thickness: 1, color: BORDER_LIGHT })
  y -= 16

  page.drawText('PAYMENT', { x: MARGIN, y: y - SMALL_SIZE, size: SMALL_SIZE, font: fonts.bold, color: TEXT_MUTED })
  y -= SMALL_SIZE + 8

  for (const payment of payments) {
    const label = formatPaymentLabel(payment.method, payment.masked_reference)
    page.drawText(label, { x: MARGIN, y: y - PAYMENT_SIZE, size: PAYMENT_SIZE, font: fonts.regular, color: TEXT_DARK })
    drawRightText(
      page,
      formatMoney(payment.amount, currency),
      rightX,
      y - PAYMENT_SIZE,
      fonts.regular,
      PAYMENT_SIZE,
      TEXT_DARK,
    )
    y -= PAYMENT_SIZE + 8
  }

  return y - 8
}

function drawFooter(page: PDFPage, font: PDFFont) {
  const contentWidth = PAGE_WIDTH - MARGIN * 2
  const centerX = MARGIN + contentWidth / 2
  const y = MARGIN + FOOTER_AREA - 10

  page.drawLine({ start: { x: MARGIN, y: y + 14 }, end: { x: MARGIN + contentWidth, y: y + 14 }, thickness: 1, color: BORDER_FOOTER })

  centeredText(page, 'Thank you for dining with us.', centerX, y, font, FOOTER_SIZE + 1, TEXT_MUTED)
  centeredText(page, 'FlashTap — Receipt', centerX, y - 12, font, FOOTER_SIZE, TEXT_FOOTER)
}

export async function renderReceiptPdf(
  snapshot: ReceiptSnapshot,
  options: PdfRenderOptions = {},
): Promise<Uint8Array> {
  const pdfDoc = await PDFDocument.create()
  const regular = await pdfDoc.embedFont(StandardFonts.Helvetica)
  const bold = await pdfDoc.embedFont(StandardFonts.HelveticaBold)
  const fonts = { regular, bold }

  const page = pdfDoc.addPage([PAGE_WIDTH, PAGE_HEIGHT])
  let y = PAGE_HEIGHT - MARGIN

  y = drawHeaderBlock(page, snapshot, options, fonts, y)
  y = drawLineItemsTable(page, snapshot, fonts, y)
  y = drawTotalsBlock(page, snapshot, fonts, y)
  y = drawOrderNoteBlock(page, snapshot, fonts, y)
  y = drawPaymentsBlock(page, snapshot.payments, fonts, y, snapshot.outlet?.currency ?? 'NAD')

  const minContentY = MARGIN + FOOTER_AREA + 20
  if (y < minContentY) {
    console.error('[renderReceiptPdf] content may have overflowed the page', {
      restaurantName: snapshot.outlet.restaurant_name,
      documentNumber: options.documentNumber,
      finalY: y,
    })
  }

  drawFooter(page, regular)

  return pdfDoc.save()
}
