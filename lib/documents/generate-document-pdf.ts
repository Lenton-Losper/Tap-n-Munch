import { PDFDocument, PDFFont, PDFPage, StandardFonts, rgb } from 'pdf-lib'
import { formatPaymentLabel } from '@/lib/receipts/formatPaymentLabel'

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
const LABEL_SIZE = 7
const BUSINESS_NAME_SIZE = 16
const DOC_TYPE_SIZE = 14
const DOC_META_SIZE = 9
const SECTION_TITLE_SIZE = 10
const TABLE_HEADER_SIZE = 8
const TOTAL_LABEL_SIZE = 9
const TOTAL_VALUE_SIZE = 10
const TOTAL_GRAND_SIZE = 11
const FOOTER_SIZE = 7

const ROW_LINE_HEIGHT = 11
const ROW_PADDING_Y = 5
const MIN_ROW_HEIGHT = 18
const TABLE_HEADER_HEIGHT = 20
const PARTY_COL_GAP = 16

export type DocumentParty = {
  name?: string
  email?: string
  organization?: string
  /**
   * The party's postal/street address, free text, newlines allowed.
   *
   * IT WAS ALWAYS BEING STORED AND NEVER RENDERED. Every writer of this jsonb passes the party
   * object through verbatim (`trimParty` in app/api/admin/documents/route.ts and in
   * .../from-order/route.ts copy every key), and "Create invoice" on Order History has collected
   * a bill-to address since it shipped. `parseParty` dropped the key on the way back out and
   * `partyLines` had no branch for it, so the address sat in the database and appeared on no
   * invoice. An invoice that does not say who it is addressed to is not much of an invoice.
   */
  address?: string
  phone?: string
  customFields?: Record<string, string>
}

export type DocumentLineItem = {
  description: string
  quantity: number
  unit_price: number
  line_total: number
}

/** `business_documents.cancelled_line_items` (20260928140000): ordered, then not charged. */
export type DocumentCancelledLine = {
  description: string
  quantity: number
  unit_price: number
  line_total: number
  order_number: number | null
  reason: 'voided' | 'order_cancelled'
}

/** One `document_payments` row, as the renderer prints it. Loaded by the caller. */
export type DocumentPaymentLine = {
  amount: number
  method: string
  reference: string | null
  paid_at: string | null
}

/** Matches public.business_documents columns (see 20260705280000_business_documents.sql
 *  and 20260725200000_document_engine_credit_notes_lineage.sql for credit_note support). */
export type BusinessDocumentRow = {
  id: string
  restaurant_id: string
  document_type: 'quote' | 'invoice' | 'credit_note'
  document_number: string
  quote_id: string | null
  issued_at: string
  due_date: string | null
  reference_note: string | null
  business_name: string | null
  registration_number: string | null
  vat_number: string | null
  address: string | null
  phone: string | null
  logo_url: string | null
  bank_name: string | null
  bank_account_name: string | null
  bank_account_number: string | null
  bank_branch_code: string | null
  ship_to: DocumentParty
  bill_to: DocumentParty
  line_items: DocumentLineItem[]
  subtotal: number
  vat_amount: number
  total: number
  balance: number
  currency: string
  created_by: string
  created_at: string
  /** credit_note only: document_number of the invoice this credit note credits
   *  (business_documents.credited_by_id), resolved by the caller since this type
   *  is a flat rendering shape, not a DB-query result. */
  original_invoice_number?: string | null
  /** credit_note only: document_number of the replacement invoice issued alongside
   *  this credit note (the original invoice's corrected_by_id), resolved by the caller. */
  replacement_invoice_number?: string | null
  /** Invoice only: lines shown under "Cancelled — not charged". Never part of any total. */
  cancelled_line_items?: DocumentCancelledLine[]
  /** Invoice only: the document_payments rows, resolved by the caller (not a column). */
  payments?: DocumentPaymentLine[]
}

function formatCurrency(amount: number, currency = 'NAD'): string {
  const value = Number(amount)
  const safe = Number.isFinite(value) ? value : 0
  const formatted = safe.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })
  return `${currency} ${formatted}`
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

/**
 * `maxWidth` is honoured for the ADDRESS ONLY, and that is not an oversight.
 *
 * Nothing in this block has ever been wrapped: a name or an email longer than the column simply
 * ran past it, and changing that now would move text on every invoice already issued. An address
 * is different -- it is the one field that is routinely longer than half a page and that arrives
 * with its own line breaks -- so it is broken on those breaks first and then wrapped to the column
 * with the same wrapText() the line-item descriptions use. Every other line is emitted exactly as
 * before, in exactly the order it was before.
 */
function partyLines(
  party: DocumentParty,
  font?: PDFFont,
  maxWidth?: number,
): string[] {
  const lines: string[] = []
  const name = String(party.name ?? '').trim()
  if (name) lines.push(name)
  const email = String(party.email ?? '').trim()
  if (email) lines.push(email)
  const organization = String(party.organization ?? '').trim()
  if (organization) lines.push(organization)
  const address = String(party.address ?? '').trim()
  if (address) {
    for (const segment of address.split(/\r?\n/)) {
      const trimmed = segment.trim()
      if (!trimmed) continue
      // Without a font we cannot measure, so the segment goes out whole rather than guessing.
      if (font && maxWidth && maxWidth > 0) {
        lines.push(...wrapText(trimmed, font, BODY_SIZE, maxWidth))
      } else {
        lines.push(trimmed)
      }
    }
  }
  const phone = String(party.phone ?? '').trim()
  if (phone) lines.push(phone)
  const customFields = party.customFields ?? {}
  for (const [label, value] of Object.entries(customFields)) {
    const trimmedLabel = label.trim()
    const trimmedValue = String(value ?? '').trim()
    if (trimmedLabel && trimmedValue) {
      lines.push(`${trimmedLabel}: ${trimmedValue}`)
    }
  }
  return lines.length > 0 ? lines : ['—']
}

function drawMutedLines(
  page: PDFPage,
  lines: string[],
  x: number,
  yTop: number,
  font: PDFFont,
  size: number,
  lineHeight: number,
): number {
  let y = yTop
  for (const line of lines) {
    page.drawText(line, { x, y: y - size, size, font, color: TEXT_MUTED })
    y -= lineHeight
  }
  return y
}

function drawHeaderBlock(
  page: PDFPage,
  document: BusinessDocumentRow,
  fonts: { regular: PDFFont; bold: PDFFont },
  yTop: number,
): number {
  const contentWidth = PAGE_WIDTH - MARGIN * 2
  const rightX = MARGIN + contentWidth
  let y = yTop

  const businessName = document.business_name?.trim() || '—'
  page.drawText(businessName, {
    x: MARGIN,
    y: y - BUSINESS_NAME_SIZE,
    size: BUSINESS_NAME_SIZE,
    font: fonts.bold,
    color: TEXT_DARK,
  })
  y -= BUSINESS_NAME_SIZE + 6

  const businessMeta: string[] = []
  if (document.address?.trim()) businessMeta.push(document.address.trim())
  if (document.phone?.trim()) businessMeta.push(document.phone.trim())
  if (document.registration_number?.trim()) {
    businessMeta.push(`Reg: ${document.registration_number.trim()}`)
  }
  if (document.vat_number?.trim()) {
    businessMeta.push(`VAT: ${document.vat_number.trim()}`)
  }
  y = drawMutedLines(page, businessMeta, MARGIN, y, fonts.regular, SMALL_SIZE, 11)

  const docTypeLabel =
    document.document_type === 'invoice'
      ? 'TAX INVOICE'
      : document.document_type === 'credit_note'
        ? 'CREDIT NOTE'
        : 'QUOTE'
  drawRightText(page, docTypeLabel, rightX, yTop - DOC_TYPE_SIZE, fonts.bold, DOC_TYPE_SIZE, BRAND_BLUE)

  let metaY = yTop - DOC_TYPE_SIZE - 14
  if (document.document_type === 'invoice') {
    // PAID / PARTIALLY PAID / UNPAID under the title -- Sprint 2026-09-28 brief.
    const state = invoicePaymentState(document).label
    drawRightText(page, state, rightX, metaY, fonts.bold, DOC_META_SIZE + 1, BRAND_BLUE)
    metaY -= 14
  }
  const metaLines = [`#${document.document_number}`, `Issued: ${formatDate(document.issued_at)}`]
  if (document.document_type === 'invoice' && document.due_date) {
    metaLines.push(`Due: ${formatDate(document.due_date)}`)
  }
  if (document.document_type === 'quote' && document.reference_note?.trim()) {
    metaLines.push(`Venue / Purpose: ${document.reference_note.trim()}`)
  }
  if (document.document_type === 'credit_note') {
    if (document.original_invoice_number) {
      metaLines.push(`Original Invoice: #${document.original_invoice_number}`)
    }
    if (document.replacement_invoice_number) {
      metaLines.push(`Replacement Invoice: #${document.replacement_invoice_number}`)
    }
    if (document.reference_note?.trim()) {
      metaLines.push(document.reference_note.trim())
    }
  }
  for (const line of metaLines) {
    drawRightText(page, line, rightX, metaY, fonts.regular, DOC_META_SIZE, TEXT_DARK)
    metaY -= 12
  }

  const blockBottom = Math.min(y, metaY) - 8
  page.drawLine({
    start: { x: MARGIN, y: blockBottom },
    end: { x: rightX, y: blockBottom },
    thickness: 1.5,
    color: BRAND_BLUE,
  })

  return blockBottom - 16
}

function drawPartyColumns(
  page: PDFPage,
  document: BusinessDocumentRow,
  fonts: { regular: PDFFont; bold: PDFFont },
  yTop: number,
): number {
  const contentWidth = PAGE_WIDTH - MARGIN * 2
  const colWidth = (contentWidth - PARTY_COL_GAP) / 2
  const leftX = MARGIN
  const rightX = MARGIN + colWidth + PARTY_COL_GAP

  let y = yTop
  page.drawText('Ship To', {
    x: leftX,
    y: y - SECTION_TITLE_SIZE,
    size: SECTION_TITLE_SIZE,
    font: fonts.bold,
    color: TEXT_DARK,
  })
  page.drawText('Bill To', {
    x: rightX,
    y: y - SECTION_TITLE_SIZE,
    size: SECTION_TITLE_SIZE,
    font: fonts.bold,
    color: TEXT_DARK,
  })
  y -= SECTION_TITLE_SIZE + 8

  const shipLines = partyLines(document.ship_to, fonts.regular, colWidth)
  const billLines = partyLines(document.bill_to, fonts.regular, colWidth)
  const maxLines = Math.max(shipLines.length, billLines.length)

  for (let i = 0; i < maxLines; i += 1) {
    const lineY = y - BODY_SIZE
    if (shipLines[i]) {
      page.drawText(shipLines[i], {
        x: leftX,
        y: lineY,
        size: BODY_SIZE,
        font: fonts.regular,
        color: TEXT_DARK,
      })
    }
    if (billLines[i]) {
      page.drawText(billLines[i], {
        x: rightX,
        y: lineY,
        size: BODY_SIZE,
        font: fonts.regular,
        color: TEXT_DARK,
      })
    }
    y -= ROW_LINE_HEIGHT
  }

  return y - 12
}

/**
 * WHERE THE PEN IS. A document can now run past one page -- a tab invoice lists every round, plus
 * a cancelled section and the payments received -- so the drawing functions share the current page
 * and ask for room before each row instead of drawing into the footer.
 */
type Cursor = {
  pdfDoc: PDFDocument
  page: PDFPage
  pages: PDFPage[]
  fonts: { regular: PDFFont; bold: PDFFont }
}

const CONTENT_FLOOR = MARGIN + FOOTER_AREA + 20

function newPage(cursor: Cursor): number {
  cursor.page = cursor.pdfDoc.addPage([PAGE_WIDTH, PAGE_HEIGHT])
  cursor.pages.push(cursor.page)
  return PAGE_HEIGHT - MARGIN
}

/** `y` if `height` more fits above the footer, else the top of a fresh page. */
function ensureRoom(cursor: Cursor, y: number, height: number): number {
  return y - height < CONTENT_FLOOR ? newPage(cursor) : y
}

type TableRow = { quantity: string; description: string; unit: string; total: string }

type TableRowLayout = {
  row: TableRow
  rowIndex: number
  height: number
  descriptionLines: string[]
}

function layoutTableRows(rows: TableRow[], font: PDFFont, descriptionWidth: number): TableRowLayout[] {
  return rows.map((row, rowIndex) => {
    const descriptionLines = wrapText(row.description, font, BODY_SIZE, descriptionWidth - 4)
    const maxLines = Math.max(1, descriptionLines.length)
    const height = Math.max(MIN_ROW_HEIGHT, maxLines * ROW_LINE_HEIGHT + ROW_PADDING_Y * 2)
    return { row, rowIndex, height, descriptionLines }
  })
}

function drawTable(
  cursor: Cursor,
  options: {
    headers: [string, string, string, string]
    headerColor: ReturnType<typeof rgb>
    rows: TableRow[]
    textColor: ReturnType<typeof rgb>
  },
  yTop: number,
): number {
  const { fonts } = cursor
  const contentWidth = PAGE_WIDTH - MARGIN * 2
  const qtyWidth = 36
  const unitWidth = 72
  const totalWidth = 72
  const descWidth = contentWidth - qtyWidth - unitWidth - totalWidth

  const qtyX = MARGIN
  const descX = qtyX + qtyWidth
  const unitX = descX + descWidth
  const totalX = unitX + unitWidth
  const rightX = MARGIN + contentWidth

  const drawHeader = (top: number): number => {
    const y = top - TABLE_HEADER_HEIGHT
    cursor.page.drawRectangle({
      x: MARGIN,
      y,
      width: contentWidth,
      height: TABLE_HEADER_HEIGHT,
      color: options.headerColor,
    })
    const xs = [qtyX, descX, unitX, totalX]
    options.headers.forEach((label, i) => {
      cursor.page.drawText(label, {
        x: xs[i] + 4,
        y: y + 6,
        size: TABLE_HEADER_SIZE,
        font: fonts.bold,
        color: WHITE,
      })
    })
    return y - 1
  }

  let y = drawHeader(ensureRoom(cursor, yTop, TABLE_HEADER_HEIGHT + MIN_ROW_HEIGHT))
  const rows = layoutTableRows(options.rows, fonts.regular, descWidth)

  for (const layout of rows) {
    if (y - layout.height < CONTENT_FLOOR) {
      y = drawHeader(newPage(cursor))
    }
    const page = cursor.page
    const yBottom = y - layout.height

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

    const baseline = y - ROW_PADDING_Y - BODY_SIZE
    page.drawText(layout.row.quantity, {
      x: qtyX + 4,
      y: baseline,
      size: BODY_SIZE,
      font: fonts.regular,
      color: options.textColor,
    })

    let descY = baseline
    for (const line of layout.descriptionLines) {
      page.drawText(line, {
        x: descX + 4,
        y: descY,
        size: BODY_SIZE,
        font: fonts.regular,
        color: options.textColor,
      })
      descY -= ROW_LINE_HEIGHT
    }

    drawRightText(page, layout.row.unit, unitX + unitWidth - 4, baseline, fonts.regular, BODY_SIZE, options.textColor)
    drawRightText(page, layout.row.total, totalX + totalWidth - 4, baseline, fonts.regular, BODY_SIZE, options.textColor)

    page.drawLine({
      start: { x: MARGIN, y: yBottom },
      end: { x: rightX, y: yBottom },
      thickness: 1,
      color: BORDER_LIGHT,
    })

    y = yBottom
  }

  return y - 16
}

function drawLineItemsTable(cursor: Cursor, document: BusinessDocumentRow, yTop: number): number {
  const currency = document.currency || 'NAD'
  return drawTable(
    cursor,
    {
      headers: ['Qty', 'Description', 'Unit Price', 'Total'],
      headerColor: BRAND_BLUE,
      textColor: TEXT_DARK,
      rows: document.line_items.map((item) => ({
        quantity: String(item.quantity),
        description: item.description,
        unit: formatCurrency(item.unit_price, currency),
        total: formatCurrency(item.line_total, currency),
      })),
    },
    yTop,
  )
}

/**
 * "CANCELLED — NOT CHARGED". Lines that were ordered and then voided, or belonged to a cancelled
 * order, in their own table with their own heading, muted, and with a charged column that says
 * 0.00. They are never in `line_items`, so nothing here can reach the subtotal, the VAT or the total;
 * the section exists so a customer comparing the invoice with what they remember ordering can see
 * the dish was taken off, rather than wondering where it went.
 */
function drawCancelledSection(cursor: Cursor, document: BusinessDocumentRow, yTop: number): number {
  const cancelled = document.cancelled_line_items ?? []
  if (cancelled.length === 0) return yTop
  const currency = document.currency || 'NAD'

  let y = ensureRoom(cursor, yTop, SECTION_TITLE_SIZE + 8 + TABLE_HEADER_HEIGHT + MIN_ROW_HEIGHT)
  cursor.page.drawText('Cancelled — not charged', {
    x: MARGIN,
    y: y - SECTION_TITLE_SIZE,
    size: SECTION_TITLE_SIZE,
    font: cursor.fonts.bold,
    color: TEXT_DARK,
  })
  y -= SECTION_TITLE_SIZE + 6

  return drawTable(
    cursor,
    {
      headers: ['Qty', 'Item', 'Value', 'Charged'],
      headerColor: TEXT_MUTED,
      textColor: TEXT_MUTED,
      rows: cancelled.map((line) => {
        const why = line.reason === 'order_cancelled' ? 'order cancelled' : 'voided'
        const order = line.order_number != null ? ` · order #${line.order_number}` : ''
        return {
          quantity: String(line.quantity),
          description: `${line.description} (${why}${order})`,
          unit: formatCurrency(line.line_total, currency),
          total: formatCurrency(0, currency),
        }
      }),
    },
    y,
  )
}

/** paid / partially paid / unpaid, from the document's own total and balance. */
export function invoicePaymentState(document: Pick<BusinessDocumentRow, 'total' | 'balance'>): {
  label: 'PAID' | 'PARTIALLY PAID' | 'UNPAID'
  amountPaid: number
  outstanding: number
} {
  const totalCents = Math.round((Number(document.total) || 0) * 100)
  const balanceCents = Math.round((Number(document.balance) || 0) * 100)
  const outstandingCents = Math.max(0, balanceCents)
  const paidCents = Math.max(0, totalCents - balanceCents)
  const label =
    totalCents > 0 && outstandingCents === 0 ? 'PAID' : paidCents > 0 ? 'PARTIALLY PAID' : 'UNPAID'
  return { label, amountPaid: paidCents / 100, outstanding: outstandingCents / 100 }
}

function drawTotalsBlock(cursor: Cursor, document: BusinessDocumentRow, yTop: number): number {
  const { fonts } = cursor
  const contentWidth = PAGE_WIDTH - MARGIN * 2
  const rightX = MARGIN + contentWidth
  const labelX = rightX - 160
  const currency = document.currency || 'NAD'
  const vatAmount = Number(document.vat_amount) || 0

  const lines: { label: string; value: string; bold?: boolean; grand?: boolean }[] = [
    { label: 'Subtotal', value: formatCurrency(document.subtotal, currency) },
  ]
  if (vatAmount > 0) {
    lines.push({ label: 'VAT', value: formatCurrency(vatAmount, currency) })
  }
  lines.push({
    label: document.document_type === 'credit_note' ? 'Total Credited' : 'Total',
    value: formatCurrency(document.total, currency),
    bold: true,
    grand: true,
  })
  if (document.document_type === 'invoice') {
    /**
     * TOTAL, PAID, OUTSTANDING -- Sprint 2026-09-28 brief (answers open question 4 of the
     * 2026-09-13 decisions). All three derive from the row's own total and balance, and balance is
     * the document engine's (total − recorded payments), so they cannot disagree with each other.
     */
    const state = invoicePaymentState(document)
    lines.push({ label: 'Amount paid', value: formatCurrency(state.amountPaid, currency) })
    lines.push({
      label: 'Amount outstanding',
      value: formatCurrency(state.outstanding, currency),
      bold: true,
    })
  }

  let y = ensureRoom(cursor, yTop, lines.length * (TOTAL_GRAND_SIZE + 10))
  for (const line of lines) {
    const size = line.grand ? TOTAL_GRAND_SIZE : line.bold ? TOTAL_VALUE_SIZE : TOTAL_LABEL_SIZE
    const font = line.bold ? fonts.bold : fonts.regular
    cursor.page.drawText(line.label, {
      x: labelX,
      y: y - size,
      size,
      font,
      color: TEXT_DARK,
    })
    drawRightText(cursor.page, line.value, rightX, y - size, font, size, TEXT_DARK)
    y -= size + (line.grand ? 10 : 8)
  }

  return y - 8
}

/**
 * PAYMENTS RECEIVED: method and reference, the way a receipt prints them (formatPaymentLabel:
 * cash shows no reference, a gateway reference is masked to its last four). Amounts are the
 * document_payments rows, which were written from the financial projection -- never a gateway
 * event's amount split across the orders it covered.
 */
function drawPaymentsSection(cursor: Cursor, document: BusinessDocumentRow, yTop: number): number {
  const payments = document.document_type === 'invoice' ? document.payments ?? [] : []
  if (payments.length === 0) return yTop
  const { fonts } = cursor
  const currency = document.currency || 'NAD'
  const rightX = PAGE_WIDTH - MARGIN

  let y = ensureRoom(cursor, yTop, SECTION_TITLE_SIZE + 8 + ROW_LINE_HEIGHT * Math.min(payments.length, 3))
  cursor.page.drawText('Payments received', {
    x: MARGIN,
    y: y - SECTION_TITLE_SIZE,
    size: SECTION_TITLE_SIZE,
    font: fonts.bold,
    color: TEXT_DARK,
  })
  y -= SECTION_TITLE_SIZE + 8

  for (const payment of payments) {
    y = ensureRoom(cursor, y, ROW_LINE_HEIGHT + 2)
    const reference = String(payment.reference ?? '').trim()
    const label = formatPaymentLabel(payment.method, reference ? maskPaymentReference(reference) : '')
    const date = payment.paid_at ? ` · ${formatDate(payment.paid_at)}` : ''
    cursor.page.drawText(`${label}${date}`, {
      x: MARGIN,
      y: y - BODY_SIZE,
      size: BODY_SIZE,
      font: fonts.regular,
      color: TEXT_DARK,
    })
    drawRightText(
      cursor.page,
      formatCurrency(payment.amount, currency),
      rightX,
      y - BODY_SIZE,
      fonts.regular,
      BODY_SIZE,
      TEXT_DARK,
    )
    y -= ROW_LINE_HEIGHT + 2
  }

  return y - 8
}

/** Last four visible -- the same masking receipts apply, so a customer sees one reference shape. */
export function maskPaymentReference(value: string): string {
  const trimmed = value.trim()
  if (trimmed.length <= 4) return '*'.repeat(trimmed.length)
  return '*'.repeat(trimmed.length - 4) + trimmed.slice(-4)
}

function drawFooter(
  page: PDFPage,
  document: BusinessDocumentRow,
  font: PDFFont,
  pageNumber: number,
  pageCount: number,
) {
  const contentWidth = PAGE_WIDTH - MARGIN * 2
  const rightX = MARGIN + contentWidth
  let y = MARGIN + FOOTER_AREA - 10

  page.drawLine({
    start: { x: MARGIN, y: y + 10 },
    end: { x: rightX, y: y + 10 },
    thickness: 1,
    color: BORDER_FOOTER,
  })

  const bankName = document.bank_name?.trim()
  const bankAccountNumber = document.bank_account_number?.trim()
  /**
   * A credit note isn't asking for payment -- never show payment instructions on one. Nor is an
   * invoice with nothing outstanding: "Kindly make payment" on a PAID invoice invites paying twice.
   */
  const asksForPayment =
    document.document_type === 'quote' ||
    (document.document_type === 'invoice' && invoicePaymentState(document).outstanding > 0)
  if (asksForPayment && bankName && bankAccountNumber) {
    const branch = document.bank_branch_code?.trim() || '—'
    const paymentLine = `Kindly make payment to: ${bankName}, Account ${bankAccountNumber}, Branch ${branch}, Reference: ${document.document_number}`
    const wrapped = wrapText(paymentLine, font, FOOTER_SIZE, contentWidth)
    for (const line of wrapped) {
      page.drawText(line, {
        x: MARGIN,
        y,
        size: FOOTER_SIZE,
        font,
        color: TEXT_MUTED,
      })
      y -= 9
    }
    y -= 2
  }

  page.drawText('FlashTap — Confidential', {
    x: MARGIN,
    y,
    size: FOOTER_SIZE,
    font,
    color: TEXT_FOOTER,
  })
  drawRightText(page, `Page ${pageNumber} of ${pageCount}`, rightX, y, font, FOOTER_SIZE, TEXT_FOOTER)
}

/**
 * The table/order/tab reference on an INVOICE ("FlashTap tab · table 4 · orders #154, #155"). Quotes
 * and credit notes already print their reference_note in the header meta; an invoice never did, so
 * an invoice raised from a tab could not be tied back to the table it billed. Wrapped across the
 * full width, because a tab's list of orders is longer than the header column.
 */
function drawReferenceLine(cursor: Cursor, document: BusinessDocumentRow, yTop: number): number {
  const note = document.reference_note?.trim()
  if (document.document_type !== 'invoice' || !note) return yTop
  const lines = wrapText(`Reference: ${note}`, cursor.fonts.regular, BODY_SIZE, PAGE_WIDTH - MARGIN * 2)
  let y = yTop
  for (const line of lines) {
    cursor.page.drawText(line, {
      x: MARGIN,
      y: y - BODY_SIZE,
      size: BODY_SIZE,
      font: cursor.fonts.regular,
      color: TEXT_MUTED,
    })
    y -= ROW_LINE_HEIGHT
  }
  return y - 8
}

export async function generateDocumentPdfBytes(
  document: BusinessDocumentRow,
): Promise<Uint8Array> {
  const pdfDoc = await PDFDocument.create()
  const regular = await pdfDoc.embedFont(StandardFonts.Helvetica)
  const bold = await pdfDoc.embedFont(StandardFonts.HelveticaBold)
  const fonts = { regular, bold }

  const page = pdfDoc.addPage([PAGE_WIDTH, PAGE_HEIGHT])
  const cursor: Cursor = { pdfDoc, page, pages: [page], fonts }
  let y = PAGE_HEIGHT - MARGIN

  y = drawHeaderBlock(page, document, fonts, y)
  y = drawPartyColumns(page, document, fonts, y)
  y = drawReferenceLine(cursor, document, y)
  y = drawLineItemsTable(cursor, document, y)
  y = drawCancelledSection(cursor, document, y)
  y = drawTotalsBlock(cursor, document, y)
  drawPaymentsSection(cursor, document, y)

  cursor.pages.forEach((p, index) => drawFooter(p, document, regular, index + 1, cursor.pages.length))

  return pdfDoc.save()
}
