import type { ReceiptSnapshot } from '@/lib/receipts/issueReceipt'

/**
 * Pure ESC/POS byte renderer for a receipt snapshot. Enforced boundary: this file must
 * never import a Supabase client or take an orderId -- it only knows how to turn the
 * already-assembled snapshot_json shape into printer bytes. Any DB/order/payment lookup
 * belongs in lib/receipts/issueReceipt.ts, not here.
 */

const ESC = 0x1b
const GS = 0x1d
const LF = 0x0a

const DEFAULT_CHARACTER_WIDTH = 32

export interface EscposRenderOptions {
  /** Characters per line for the paired printer/font (58mm ~32, 80mm ~48). Defaults to 32. */
  characterWidth?: number
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

function formatMoney(value: number): string {
  return value.toFixed(2)
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
  builder.line()

  builder.align('left')
  for (const item of snapshot.line_items) {
    const qtyPrefix = `${item.quantity} x ${formatMoney(item.unit_price)}`
    builder.line(truncate(item.name, characterWidth))
    builder.line(twoColumnLine(qtyPrefix, formatMoney(item.line_total), characterWidth))
  }

  builder.line(divider(characterWidth))
  builder.line(twoColumnLine('Subtotal', formatMoney(snapshot.totals.subtotal), characterWidth))
  builder.line(twoColumnLine('VAT', formatMoney(snapshot.totals.vat), characterWidth))
  if (snapshot.totals.discount > 0) {
    builder.line(twoColumnLine('Discount', `-${formatMoney(snapshot.totals.discount)}`, characterWidth))
  }
  builder.bold(true)
  builder.line(twoColumnLine('Total', formatMoney(snapshot.totals.grand_total), characterWidth))
  builder.bold(false)
  builder.line()

  for (const payment of snapshot.payments) {
    builder.line(
      twoColumnLine(
        `${payment.method.toUpperCase()} ${payment.masked_reference}`,
        formatMoney(payment.amount),
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
