import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib'

const PAGE_WIDTH = 595.28
const PAGE_HEIGHT = 841.89
const MARGIN = 48

const TEXT_DARK = rgb(0.1, 0.1, 0.1)
const TEXT_MUTED = rgb(0.4, 0.4, 0.4)
const BORDER = rgb(0.82, 0.82, 0.82)
const PAID_GREEN = rgb(0.15, 0.55, 0.25)

export type TaxInvoiceLineItem = {
  description: string
  quantity: number
  unitPrice: number
  lineTotal: number
}

export type TaxInvoicePdfInput = {
  seller: {
    name: string
    companyRegNumber?: string | null
    address?: string | null
    vatNumber?: string | null
    phone?: string | null
  }
  invoiceNumber: string
  invoiceDate: string
  billTo: {
    companyName?: string | null
    vatNumber?: string | null
    email: string
    metadata: Record<string, unknown>
  }
  lineItems: TaxInvoiceLineItem[]
  subtotal: number
  vatAmount: number
  total: number
  currency: string
}

const METADATA_LABELS: Record<string, string> = {
  department: 'Department',
  gl_number: 'GL Number',
  glNumber: 'GL Number',
  cost_centre: 'Cost Centre',
  costCentre: 'Cost Centre',
  employee_code: 'Employee Code',
  employeeCode: 'Employee Code',
  business_unit: 'Business Unit',
  businessUnit: 'Business Unit',
}

function formatMoney(amount: number, currency: string): string {
  const code = currency === 'NAD' ? 'N$' : currency === 'ZAR' ? 'R' : `${currency} `
  return `${code}${amount.toFixed(2)}`
}

function formatDate(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  return date.toLocaleDateString('en-NA', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  })
}

function drawLabelValue(
  page: PDFPage,
  font: PDFFont,
  bold: PDFFont,
  x: number,
  y: number,
  label: string,
  value: string,
): number {
  page.drawText(label, { x, y, size: 8, font: bold, color: TEXT_MUTED })
  page.drawText(value, { x, y: y - 12, size: 10, font, color: TEXT_DARK })
  return y - 28
}

function metadataRows(metadata: Record<string, unknown>): Array<{ label: string; value: string }> {
  const rows: Array<{ label: string; value: string }> = []
  for (const [key, raw] of Object.entries(metadata)) {
    if (raw == null || String(raw).trim() === '') continue
    if (key.startsWith('_')) continue
    const label = METADATA_LABELS[key] ?? key.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
    rows.push({ label, value: String(raw).trim() })
  }
  return rows
}

export async function generateTaxInvoicePdfBytes(input: TaxInvoicePdfInput): Promise<Uint8Array> {
  const pdfDoc = await PDFDocument.create()
  const regular = await pdfDoc.embedFont(StandardFonts.Helvetica)
  const bold = await pdfDoc.embedFont(StandardFonts.HelveticaBold)
  const page = pdfDoc.addPage([PAGE_WIDTH, PAGE_HEIGHT])

  let y = PAGE_HEIGHT - MARGIN

  page.drawText('TAX INVOICE', {
    x: MARGIN,
    y: y - 18,
    size: 18,
    font: bold,
    color: TEXT_DARK,
  })

  const rightX = PAGE_WIDTH - MARGIN - 180
  page.drawText(`Invoice No: ${input.invoiceNumber}`, {
    x: rightX,
    y: y - 4,
    size: 10,
    font: bold,
    color: TEXT_DARK,
  })
  page.drawText(`Date: ${formatDate(input.invoiceDate)}`, {
    x: rightX,
    y: y - 18,
    size: 9,
    font: regular,
    color: TEXT_MUTED,
  })
  y -= 36

  page.drawLine({
    start: { x: MARGIN, y },
    end: { x: PAGE_WIDTH - MARGIN, y },
    thickness: 1,
    color: BORDER,
  })
  y -= 20

  page.drawText(input.seller.name, { x: MARGIN, y, size: 12, font: bold, color: TEXT_DARK })
  y -= 16

  const sellerLines: string[] = []
  if (input.seller.companyRegNumber) sellerLines.push(`CC Reg No: ${input.seller.companyRegNumber}`)
  if (input.seller.vatNumber) sellerLines.push(`VAT No: ${input.seller.vatNumber}`)
  if (input.seller.address) sellerLines.push(input.seller.address)
  if (input.seller.phone) sellerLines.push(`Tel: ${input.seller.phone}`)

  for (const line of sellerLines) {
    page.drawText(line, { x: MARGIN, y, size: 9, font: regular, color: TEXT_MUTED })
    y -= 13
  }

  y -= 12
  page.drawText('Bill To', { x: MARGIN, y, size: 10, font: bold, color: TEXT_DARK })
  y -= 16

  if (input.billTo.companyName) {
    page.drawText(input.billTo.companyName, { x: MARGIN, y, size: 10, font: bold, color: TEXT_DARK })
    y -= 14
  }
  if (input.billTo.vatNumber) {
    y = drawLabelValue(page, regular, bold, MARGIN, y, 'VAT Number', input.billTo.vatNumber)
  }
  y = drawLabelValue(page, regular, bold, MARGIN, y, 'Email', input.billTo.email)

  for (const row of metadataRows(input.billTo.metadata)) {
    y = drawLabelValue(page, regular, bold, MARGIN, y, row.label, row.value)
  }

  y -= 8
  const tableTop = y
  const colDesc = MARGIN
  const colQty = PAGE_WIDTH - MARGIN - 200
  const colUnit = PAGE_WIDTH - MARGIN - 130
  const colTotal = PAGE_WIDTH - MARGIN - 60

  page.drawRectangle({
    x: MARGIN,
    y: tableTop - 20,
    width: PAGE_WIDTH - MARGIN * 2,
    height: 20,
    color: rgb(0.94, 0.96, 0.98),
    borderColor: BORDER,
  })

  const headerY = tableTop - 14
  page.drawText('Description', { x: colDesc + 4, y: headerY, size: 8, font: bold, color: TEXT_DARK })
  page.drawText('Qty', { x: colQty, y: headerY, size: 8, font: bold, color: TEXT_DARK })
  page.drawText('Unit', { x: colUnit, y: headerY, size: 8, font: bold, color: TEXT_DARK })
  page.drawText('Amount', { x: colTotal, y: headerY, size: 8, font: bold, color: TEXT_DARK })

  y = tableTop - 20

  for (const item of input.lineItems) {
    y -= 18
    page.drawLine({
      start: { x: MARGIN, y: y + 4 },
      end: { x: PAGE_WIDTH - MARGIN, y: y + 4 },
      thickness: 0.5,
      color: BORDER,
    })
    page.drawText(item.description.slice(0, 60), {
      x: colDesc + 4,
      y: y - 10,
      size: 9,
      font: regular,
      color: TEXT_DARK,
    })
    page.drawText(String(item.quantity), { x: colQty, y: y - 10, size: 9, font: regular, color: TEXT_DARK })
    page.drawText(formatMoney(item.unitPrice, input.currency), {
      x: colUnit,
      y: y - 10,
      size: 9,
      font: regular,
      color: TEXT_DARK,
    })
    page.drawText(formatMoney(item.lineTotal, input.currency), {
      x: colTotal,
      y: y - 10,
      size: 9,
      font: regular,
      color: TEXT_DARK,
    })
  }

  y -= 24
  const totalsX = PAGE_WIDTH - MARGIN - 180

  page.drawText('Subtotal:', { x: totalsX, y, size: 9, font: regular, color: TEXT_MUTED })
  page.drawText(formatMoney(input.subtotal, input.currency), {
    x: totalsX + 80,
    y,
    size: 9,
    font: regular,
    color: TEXT_DARK,
  })
  y -= 14
  page.drawText('VAT:', { x: totalsX, y, size: 9, font: regular, color: TEXT_MUTED })
  page.drawText(formatMoney(input.vatAmount, input.currency), {
    x: totalsX + 80,
    y,
    size: 9,
    font: regular,
    color: TEXT_DARK,
  })
  y -= 16
  page.drawText('Total:', { x: totalsX, y, size: 11, font: bold, color: TEXT_DARK })
  page.drawText(formatMoney(input.total, input.currency), {
    x: totalsX + 80,
    y,
    size: 11,
    font: bold,
    color: TEXT_DARK,
  })

  y -= 36
  page.drawText('PAID IN FULL', {
    x: MARGIN,
    y,
    size: 14,
    font: bold,
    color: PAID_GREEN,
  })

  return pdfDoc.save()
}
