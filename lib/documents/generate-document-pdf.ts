import { PDFDocument, PDFFont, PDFPage, StandardFonts, rgb } from 'pdf-lib'

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
  phone?: string
  customFields?: Record<string, string>
}

export type DocumentLineItem = {
  description: string
  quantity: number
  unit_price: number
  line_total: number
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

function partyLines(party: DocumentParty): string[] {
  const lines: string[] = []
  const name = String(party.name ?? '').trim()
  if (name) lines.push(name)
  const email = String(party.email ?? '').trim()
  if (email) lines.push(email)
  const organization = String(party.organization ?? '').trim()
  if (organization) lines.push(organization)
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

  const shipLines = partyLines(document.ship_to)
  const billLines = partyLines(document.bill_to)
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

type TableRowLayout = {
  item: DocumentLineItem
  rowIndex: number
  height: number
  descriptionLines: string[]
}

function layoutTableRows(
  items: DocumentLineItem[],
  font: PDFFont,
  descriptionWidth: number,
): TableRowLayout[] {
  return items.map((item, rowIndex) => {
    const descriptionLines = wrapText(item.description, font, BODY_SIZE, descriptionWidth - 4)
    const maxLines = Math.max(1, descriptionLines.length)
    const height = Math.max(MIN_ROW_HEIGHT, maxLines * ROW_LINE_HEIGHT + ROW_PADDING_Y * 2)
    return { item, rowIndex, height, descriptionLines }
  })
}

function drawLineItemsTable(
  page: PDFPage,
  document: BusinessDocumentRow,
  fonts: { regular: PDFFont; bold: PDFFont },
  yTop: number,
): number {
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

  let y = yTop - TABLE_HEADER_HEIGHT
  page.drawRectangle({
    x: MARGIN,
    y,
    width: contentWidth,
    height: TABLE_HEADER_HEIGHT,
    color: BRAND_BLUE,
  })

  const headers = [
    { label: 'Qty', x: qtyX + 4 },
    { label: 'Description', x: descX + 4 },
    { label: 'Unit Price', x: unitX + 4 },
    { label: 'Total', x: totalX + 4 },
  ]
  for (const header of headers) {
    page.drawText(header.label, {
      x: header.x,
      y: y + 6,
      size: TABLE_HEADER_SIZE,
      font: fonts.bold,
      color: WHITE,
    })
  }

  y -= 1
  const rows = layoutTableRows(document.line_items, fonts.regular, descWidth)
  const currency = document.currency || 'NAD'

  for (const row of rows) {
    const yBottom = y - row.height

    if (row.rowIndex % 2 === 1) {
      page.drawRectangle({
        x: MARGIN,
        y: yBottom,
        width: contentWidth,
        height: row.height,
        color: ROW_ALT_BG,
        borderColor: ROW_ALT_BG,
      })
    }

    const qtyText = String(row.item.quantity)
    page.drawText(qtyText, {
      x: qtyX + 4,
      y: y - ROW_PADDING_Y - BODY_SIZE,
      size: BODY_SIZE,
      font: fonts.regular,
      color: TEXT_DARK,
    })

    let descY = y - ROW_PADDING_Y - BODY_SIZE
    for (const line of row.descriptionLines) {
      page.drawText(line, {
        x: descX + 4,
        y: descY,
        size: BODY_SIZE,
        font: fonts.regular,
        color: TEXT_DARK,
      })
      descY -= ROW_LINE_HEIGHT
    }

    const unitText = formatCurrency(row.item.unit_price, currency)
    const unitTextWidth = fonts.regular.widthOfTextAtSize(unitText, BODY_SIZE)
    page.drawText(unitText, {
      x: unitX + unitWidth - unitTextWidth - 4,
      y: y - ROW_PADDING_Y - BODY_SIZE,
      size: BODY_SIZE,
      font: fonts.regular,
      color: TEXT_DARK,
    })

    const lineTotalText = formatCurrency(row.item.line_total, currency)
    const lineTotalWidth = fonts.regular.widthOfTextAtSize(lineTotalText, BODY_SIZE)
    page.drawText(lineTotalText, {
      x: totalX + totalWidth - lineTotalWidth - 4,
      y: y - ROW_PADDING_Y - BODY_SIZE,
      size: BODY_SIZE,
      font: fonts.regular,
      color: TEXT_DARK,
    })

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

function drawTotalsBlock(
  page: PDFPage,
  document: BusinessDocumentRow,
  fonts: { regular: PDFFont; bold: PDFFont },
  yTop: number,
): number {
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
    lines.push({
      label: 'Balance',
      value: formatCurrency(document.balance, currency),
      bold: true,
    })
  }

  let y = yTop
  for (const line of lines) {
    const size = line.grand ? TOTAL_GRAND_SIZE : line.bold ? TOTAL_VALUE_SIZE : TOTAL_LABEL_SIZE
    const font = line.bold ? fonts.bold : fonts.regular
    page.drawText(line.label, {
      x: labelX,
      y: y - size,
      size,
      font,
      color: TEXT_DARK,
    })
    drawRightText(page, line.value, rightX, y - size, font, size, TEXT_DARK)
    y -= size + (line.grand ? 10 : 8)
  }

  return y - 8
}

function drawFooter(page: PDFPage, document: BusinessDocumentRow, font: PDFFont) {
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
  // A credit note isn't asking for payment -- never show payment instructions on one.
  if (document.document_type !== 'credit_note' && bankName && bankAccountNumber) {
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
  drawRightText(page, 'Page 1 of 1', rightX, y, font, FOOTER_SIZE, TEXT_FOOTER)
}

export async function generateDocumentPdfBytes(
  document: BusinessDocumentRow,
): Promise<Uint8Array> {
  const pdfDoc = await PDFDocument.create()
  const regular = await pdfDoc.embedFont(StandardFonts.Helvetica)
  const bold = await pdfDoc.embedFont(StandardFonts.HelveticaBold)
  const fonts = { regular, bold }

  const page = pdfDoc.addPage([PAGE_WIDTH, PAGE_HEIGHT])
  let y = PAGE_HEIGHT - MARGIN

  y = drawHeaderBlock(page, document, fonts, y)
  y = drawPartyColumns(page, document, fonts, y)
  y = drawLineItemsTable(page, document, fonts, y)
  y = drawTotalsBlock(page, document, fonts, y)

  const minContentY = MARGIN + FOOTER_AREA + 20
  if (y < minContentY) {
    console.error('[generateDocumentPdfBytes] content may have overflowed the page', {
      documentId: document.id,
      documentNumber: document.document_number,
      finalY: y,
    })
  }

  drawFooter(page, document, regular)

  return pdfDoc.save()
}
