import type { ReceiptSnapshot } from '@/lib/receipts/issueReceipt'
import { formatThermalIssuedAt } from '@/lib/receipts/renderers/formatThermalIssuedAt'
import { formatReceiptMoney } from '@/lib/receipts/renderers/formatReceiptMoney'

const ESC = 0x1b
const GS = 0x1d
const LF = 0x0a

const DEFAULT_CHARACTER_WIDTH = 32

export interface EscposRenderOptions {
  /**
   * Characters per line for the paired printer/font (58mm ~32, 80mm ~48). Defaults to 32.
   * Policy: NOT frozen at issuance — GET may pass the terminal's configured width so layout
   * matches the physical printer. Byte-identical reprint requires the same characterWidth.
   */
  characterWidth?: number
  /** Immutable receipt document number (e.g. RCT-000187) from receipt_documents. */
  documentNumber?: string
  /** ISO issued_at from receipt_documents. */
  issuedAt?: string
}

class EscposBuilder {
  private chunks: number[][] = []

  raw(bytes: number[]): this {
    this.chunks.push(bytes)
    return this
  }

  text(line: string): this {
    this.chunks.push(Array.from(Buffer.from(line, 'ascii')))
    return this
  }

  newline(): this {
    this.chunks.push([LF])
    return this
  }

  line(text = ''): this {
    return this.text(text).newline()
  }

  init(): this {
    return this.raw([ESC, 0x40])
  }

  align(mode: 'left' | 'center' | 'right'): this {
    const n = mode === 'left' ? 0 : mode === 'center' ? 1 : 2
    return this.raw([ESC, 0x61, n])
  }

  bold(on: boolean): this {
    return this.raw([ESC, 0x45, on ? 1 : 0])
  }

  feed(lines: number): this {
    return this.raw([ESC, 0x64, lines])
  }

  cut(): this {
    return this.raw([GS, 0x56, 0x01])
  }

  build(): Uint8Array {
    const bytes = this.chunks.flat()
    return Uint8Array.from(bytes)
  }
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value
  return value.slice(0, Math.max(0, maxLength - 1)) + '…'
}

function money(snapshot: ReceiptSnapshot, value: number): string {
  return formatReceiptMoney(value, snapshot.outlet?.currency ?? 'NAD')
}

/** Left-aligned label, right-aligned value, padded/truncated to fit characterWidth. */
function twoColumnLine(left: string, right: string, characterWidth: number): string {
  const safeRight = truncate(right, characterWidth)
  const availableLeft = Math.max(0, characterWidth - safeRight.length - 1)
  const safeLeft = truncate(left, availableLeft)
  const padding = Math.max(1, characterWidth - safeLeft.length - safeRight.length)
  return safeLeft + ' '.repeat(padding) + safeRight
}

function centered(text: string, characterWidth: number): string {
  const safe = truncate(text, characterWidth)
  const padding = Math.max(0, Math.floor((characterWidth - safe.length) / 2))
  return ' '.repeat(padding) + safe
}

function divider(characterWidth: number): string {
  return '-'.repeat(characterWidth)
}

export function renderReceiptEscPos(
  snapshot: ReceiptSnapshot,
  options: EscposRenderOptions = {},
): Uint8Array {
  const characterWidth = options.characterWidth ?? DEFAULT_CHARACTER_WIDTH
  const builder = new EscposBuilder().init()

  builder.align('center')
  builder.bold(true)
  builder.line(centered(snapshot.outlet.restaurant_name, characterWidth))
  builder.bold(false)
  if (snapshot.outlet.address) {
    builder.line(centered(snapshot.outlet.address, characterWidth))
  }
  if (snapshot.outlet.vat_number) {
    builder.line(centered(`VAT: ${snapshot.outlet.vat_number}`, characterWidth))
  }
  if (snapshot.outlet.registration_number) {
    builder.line(centered(`Reg: ${snapshot.outlet.registration_number}`, characterWidth))
  }
  builder.line()

  builder.align('left')
  if (options.documentNumber) {
    builder.line(twoColumnLine('Receipt', options.documentNumber, characterWidth))
  }
  const issuedLabel = formatThermalIssuedAt(options.issuedAt)
  if (issuedLabel) {
    builder.line(twoColumnLine('Issued', issuedLabel, characterWidth))
  }
  if (snapshot.table_number != null) {
    builder.line(twoColumnLine('Table', String(snapshot.table_number), characterWidth))
  }
  if (snapshot.staff_name) {
    builder.line(twoColumnLine('Staff', snapshot.staff_name, characterWidth))
  }
  if (options.documentNumber || issuedLabel || snapshot.table_number != null || snapshot.staff_name) {
    builder.line()
  }

  for (const item of snapshot.line_items) {
    const qtyPrefix = `${item.quantity} x ${money(snapshot, item.unit_price)}`
    builder.line(truncate(item.name, characterWidth))
    for (const mod of item.modifiers ?? []) {
      builder.line(truncate(`  + ${mod}`, characterWidth))
    }
    builder.line(twoColumnLine(qtyPrefix, money(snapshot, item.line_total), characterWidth))
  }

  builder.line(divider(characterWidth))
  builder.line(twoColumnLine('Subtotal', money(snapshot, snapshot.totals.subtotal), characterWidth))
  builder.line(twoColumnLine('VAT', money(snapshot, snapshot.totals.vat), characterWidth))
  if (snapshot.totals.discount > 0) {
    builder.line(
      twoColumnLine('Discount', `-${money(snapshot, snapshot.totals.discount)}`, characterWidth),
    )
  }
  builder.bold(true)
  builder.line(twoColumnLine('Total', money(snapshot, snapshot.totals.grand_total), characterWidth))
  builder.bold(false)
  builder.line()

  for (const payment of snapshot.payments) {
    builder.line(
      twoColumnLine(
        `${payment.method.toUpperCase()} ${payment.masked_reference}`,
        money(snapshot, payment.amount),
        characterWidth,
      ),
    )
  }

  builder.line()
  builder.align('center')
  builder.line(centered('Thank you', characterWidth))

  builder.feed(3)
  builder.cut()

  return builder.build()
}
