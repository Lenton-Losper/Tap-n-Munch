import { PDFDocument, PDFFont, PDFPage, StandardFonts, rgb } from 'pdf-lib'
import { ReportData, ReportOrder } from './get-report-data'

// A4 landscape (points)
const PAGE_WIDTH = 841.89
const PAGE_HEIGHT = 595.28
const MARGIN = 40
const FOOTER_AREA = 28

const BRAND_BLUE = rgb(46 / 255, 117 / 255, 182 / 255)
const TEXT_DARK = rgb(26 / 255, 26 / 255, 26 / 255)
const TEXT_MUTED = rgb(102 / 255, 102 / 255, 102 / 255)
const TEXT_FOOTER = rgb(153 / 255, 153 / 255, 153 / 255)
const SUMMARY_BG = rgb(235 / 255, 243 / 255, 251 / 255)
const ROW_ALT_BG = rgb(248 / 255, 250 / 255, 252 / 255)
const BORDER_LIGHT = rgb(238 / 255, 238 / 255, 238 / 255)
const BORDER_FOOTER = rgb(204 / 255, 204 / 255, 204 / 255)
const WHITE = rgb(1, 1, 1)

const BODY_SIZE = 8
const HEADER_LABEL_SIZE = 7
const META_SIZE = 8
const BRAND_SIZE = 22
const RESTAURANT_SIZE = 13
const SUMMARY_VALUE_SIZE = 14
const FOOTER_SIZE = 7
const ROW_LINE_HEIGHT = 10
const ROW_PADDING_Y = 5
const MIN_ROW_HEIGHT = 16
const TABLE_HEADER_HEIGHT = 18

type ColumnKey =
  | 'orderNo'
  | 'time'
  | 'table'
  | 'customer'
  | 'items'
  | 'total'
  | 'payment'
  | 'status'

const COLUMNS: { key: ColumnKey; label: string; width: number }[] = [
  { key: 'orderNo', label: 'Order #', width: 0.07 },
  { key: 'time', label: 'Time', width: 0.13 },
  { key: 'table', label: 'Table', width: 0.07 },
  { key: 'customer', label: 'Customer', width: 0.1 },
  { key: 'items', label: 'Items', width: 0.3 },
  { key: 'total', label: 'Total', width: 0.1 },
  { key: 'payment', label: 'Payment', width: 0.12 },
  { key: 'status', label: 'Status', width: 0.11 },
]

const formatCurrency = (amount: number) => `N$${amount.toFixed(2)}`

const formatDate = (iso: string) => {
  const d = new Date(iso)
  return d.toLocaleString('en-NA', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
}

function wrapParagraph(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
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

function wrapText(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const paragraphs = String(text ?? '').split('\n')
  const lines: string[] = []
  for (const paragraph of paragraphs) {
    lines.push(...wrapParagraph(paragraph, font, size, maxWidth))
  }
  return lines.length > 0 ? lines : ['—']
}

function formatStatusWithPayment(order: ReportOrder): string {
  const base = order.status || '—'
  if (order.paymentStatus === 'refunded') return `${base} (Refunded)`
  if (order.paymentStatus === 'partially_refunded') return `${base} (Partial Refund)`
  return base
}

function columnWidths(contentWidth: number): Record<ColumnKey, number> {
  const widths = {} as Record<ColumnKey, number>
  for (const col of COLUMNS) {
    widths[col.key] = contentWidth * col.width
  }
  return widths
}

function columnXPositions(contentWidth: number): Record<ColumnKey, number> {
  const widths = columnWidths(contentWidth)
  const positions = {} as Record<ColumnKey, number>
  let x = MARGIN
  for (const col of COLUMNS) {
    positions[col.key] = x
    x += widths[col.key]
  }
  return positions
}

function orderCellText(order: ReportOrder, key: ColumnKey): string {
  switch (key) {
    case 'orderNo':
      return `#${order.order_number}`
    case 'time':
      return formatDate(order.placed_at)
    case 'table':
      return order.table_number != null ? String(order.table_number) : '—'
    case 'customer':
      return order.customer_name ?? '—'
    case 'items':
      return order.items || '—'
    case 'total':
      if (Number(order.refundedAmount) > 0) {
        return `${formatCurrency(order.total)}\n-${formatCurrency(Number(order.refundedAmount))} refunded`
      }
      return formatCurrency(order.total)
    case 'payment':
      return order.payment_method ?? '—'
    case 'status':
      return formatStatusWithPayment(order)
    default:
      return '—'
  }
}

interface RowLayout {
  order: ReportOrder
  rowIndex: number
  height: number
  cells: Record<ColumnKey, string[]>
}

function layoutRows(
  orders: ReportOrder[],
  font: PDFFont,
  widths: Record<ColumnKey, number>,
): RowLayout[] {
  return orders.map((order, rowIndex) => {
    const cells = {} as Record<ColumnKey, string[]>
    let maxLines = 1
    for (const col of COLUMNS) {
      const lines = wrapText(orderCellText(order, col.key), font, BODY_SIZE, widths[col.key] - 4)
      cells[col.key] = lines
      maxLines = Math.max(maxLines, lines.length)
    }
    const height = Math.max(MIN_ROW_HEIGHT, maxLines * ROW_LINE_HEIGHT + ROW_PADDING_Y * 2)
    return { order, rowIndex, height, cells }
  })
}

function drawHeaderBlock(
  page: PDFPage,
  report: ReportData,
  fonts: { regular: PDFFont; bold: PDFFont },
  yTop: number,
): number {
  const contentWidth = PAGE_WIDTH - MARGIN * 2
  let y = yTop

  page.drawText('FlashTap', {
    x: MARGIN,
    y: y - BRAND_SIZE,
    size: BRAND_SIZE,
    font: fonts.bold,
    color: BRAND_BLUE,
  })
  y -= BRAND_SIZE + 4

  page.drawText(report.restaurant.name, {
    x: MARGIN,
    y: y - RESTAURANT_SIZE,
    size: RESTAURANT_SIZE,
    font: fonts.bold,
    color: TEXT_DARK,
  })
  y -= RESTAURANT_SIZE + 4

  const meta = `Period: ${report.filters.startDate} to ${report.filters.endDate}   Generated: ${formatDate(report.generatedAt)}`
  page.drawText(meta, {
    x: MARGIN,
    y: y - META_SIZE,
    size: META_SIZE,
    font: fonts.regular,
    color: TEXT_MUTED,
  })
  y -= META_SIZE + 8

  page.drawLine({
    start: { x: MARGIN, y },
    end: { x: MARGIN + contentWidth, y },
    thickness: 2,
    color: BRAND_BLUE,
  })

  return y - 12
}

function drawSummaryCards(
  page: PDFPage,
  report: ReportData,
  fonts: { regular: PDFFont; bold: PDFFont },
  yTop: number,
): number {
  const contentWidth = PAGE_WIDTH - MARGIN * 2
  const gap = 12
  const cardWidth = (contentWidth - gap * 2) / 3
  const cardHeight = 44
  const cards = [
    { label: 'TOTAL REVENUE', value: formatCurrency(report.summary.totalRevenue) },
    { label: 'TOTAL ORDERS', value: String(report.summary.totalOrders) },
    { label: 'AVERAGE ORDER VALUE', value: formatCurrency(report.summary.averageOrderValue) },
  ]

  let y = yTop - cardHeight
  cards.forEach((card, index) => {
    const x = MARGIN + index * (cardWidth + gap)
    page.drawRectangle({
      x,
      y,
      width: cardWidth,
      height: cardHeight,
      color: SUMMARY_BG,
      borderColor: SUMMARY_BG,
    })
    page.drawText(card.label, {
      x: x + 10,
      y: y + cardHeight - 14,
      size: HEADER_LABEL_SIZE,
      font: fonts.regular,
      color: TEXT_MUTED,
    })
    page.drawText(card.value, {
      x: x + 10,
      y: y + 12,
      size: SUMMARY_VALUE_SIZE,
      font: fonts.bold,
      color: TEXT_DARK,
    })
  })

  return y - 16
}

function drawTableHeader(
  page: PDFPage,
  fonts: { regular: PDFFont; bold: PDFFont },
  yTop: number,
  contentWidth: number,
  positions: Record<ColumnKey, number>,
  widths: Record<ColumnKey, number>,
): number {
  const y = yTop - TABLE_HEADER_HEIGHT
  page.drawRectangle({
    x: MARGIN,
    y,
    width: contentWidth,
    height: TABLE_HEADER_HEIGHT,
    color: BRAND_BLUE,
  })

  for (const col of COLUMNS) {
    page.drawText(col.label, {
      x: positions[col.key] + 4,
      y: y + 5,
      size: HEADER_LABEL_SIZE,
      font: fonts.bold,
      color: WHITE,
    })
  }

  return y - 1
}

function drawTableRow(
  page: PDFPage,
  layout: RowLayout,
  fonts: { regular: PDFFont; bold: PDFFont },
  yTop: number,
  contentWidth: number,
  positions: Record<ColumnKey, number>,
  widths: Record<ColumnKey, number>,
): number {
  const yBottom = yTop - layout.height

  if (layout.rowIndex % 2 === 1) {
    page.drawRectangle({
      x: MARGIN,
      y: yBottom,
      width: contentWidth,
      height: layout.height,
      color: ROW_ALT_BG,
      borderColor: ROW_ALT_BG,
    })
  }

  for (const col of COLUMNS) {
    const lines = layout.cells[col.key]
    let textY = yTop - ROW_PADDING_Y - BODY_SIZE
    for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
      const line = lines[lineIndex]
      const isRefundLine = col.key === 'total' && lineIndex > 0
      page.drawText(line, {
        x: positions[col.key] + 4,
        y: textY,
        size: isRefundLine ? HEADER_LABEL_SIZE : BODY_SIZE,
        font: fonts.regular,
        color: isRefundLine ? TEXT_MUTED : TEXT_DARK,
      })
      textY -= ROW_LINE_HEIGHT
    }
  }

  page.drawLine({
    start: { x: MARGIN, y: yBottom },
    end: { x: MARGIN + contentWidth, y: yBottom },
    thickness: 1,
    color: BORDER_LIGHT,
  })

  return yBottom
}

function drawFooter(page: PDFPage, font: PDFFont, pageNumber: number, totalPages: number) {
  const y = MARGIN - 4
  page.drawLine({
    start: { x: MARGIN, y: y + FOOTER_AREA - 8 },
    end: { x: PAGE_WIDTH - MARGIN, y: y + FOOTER_AREA - 8 },
    thickness: 1,
    color: BORDER_FOOTER,
  })
  page.drawText('FlashTap — Confidential', {
    x: MARGIN,
    y,
    size: FOOTER_SIZE,
    font,
    color: TEXT_FOOTER,
  })
  const pageLabel = `Page ${pageNumber} of ${totalPages}`
  const labelWidth = font.widthOfTextAtSize(pageLabel, FOOTER_SIZE)
  page.drawText(pageLabel, {
    x: PAGE_WIDTH - MARGIN - labelWidth,
    y,
    size: FOOTER_SIZE,
    font,
    color: TEXT_FOOTER,
  })
}

interface PagePlan {
  rows: RowLayout[]
  includeHeader: boolean
  includeSummary: boolean
}

function buildPagePlans(rows: RowLayout[]): PagePlan[] {
  const contentWidth = PAGE_WIDTH - MARGIN * 2
  const minY = MARGIN + FOOTER_AREA
  const plans: PagePlan[] = []

  let index = 0
  let isFirst = true

  while (index < rows.length) {
    let y = PAGE_HEIGHT - MARGIN
    if (isFirst) {
      y -= 78 // header block
      y -= 60 // summary cards
    }
    y = drawTableHeaderVirtual(y)
    const pageRows: RowLayout[] = []

    while (index < rows.length) {
      const row = rows[index]
      if (y - row.height < minY) break
      pageRows.push(row)
      y -= row.height
      index += 1
    }

    if (pageRows.length === 0 && index < rows.length) {
      // Force at least one row per page to avoid infinite loop on oversized rows
      pageRows.push(rows[index])
      index += 1
    }

    plans.push({
      rows: pageRows,
      includeHeader: isFirst,
      includeSummary: isFirst,
    })
    isFirst = false
  }

  if (plans.length === 0) {
    plans.push({ rows: [], includeHeader: true, includeSummary: true })
  }

  return plans
}

function drawTableHeaderVirtual(yTop: number): number {
  return yTop - TABLE_HEADER_HEIGHT - 1
}

export async function generatePdfBytes(report: ReportData): Promise<Uint8Array> {
  const pdfDoc = await PDFDocument.create()
  const regular = await pdfDoc.embedFont(StandardFonts.Helvetica)
  const bold = await pdfDoc.embedFont(StandardFonts.HelveticaBold)
  const fonts = { regular, bold }

  const contentWidth = PAGE_WIDTH - MARGIN * 2
  const widths = columnWidths(contentWidth)
  const positions = columnXPositions(contentWidth)
  const rowLayouts = layoutRows(report.orders, regular, widths)
  const pagePlans = buildPagePlans(rowLayouts)
  const totalPages = pagePlans.length

  pagePlans.forEach((plan, pageIndex) => {
    const page = pdfDoc.addPage([PAGE_WIDTH, PAGE_HEIGHT])
    let y = PAGE_HEIGHT - MARGIN

    if (plan.includeHeader) {
      y = drawHeaderBlock(page, report, fonts, y)
    }
    if (plan.includeSummary) {
      y = drawSummaryCards(page, report, fonts, y)
    }

    y = drawTableHeader(page, fonts, y, contentWidth, positions, widths)

    for (const row of plan.rows) {
      y = drawTableRow(page, row, fonts, y, contentWidth, positions, widths)
    }

    drawFooter(page, regular, pageIndex + 1, totalPages)
  })

  return pdfDoc.save()
}

export async function generatePdfBlob(report: ReportData): Promise<Blob> {
  const bytes = await generatePdfBytes(report)
  const copy = new Uint8Array(bytes.byteLength)
  copy.set(bytes)
  return new Blob([copy], { type: 'application/pdf' })
}
