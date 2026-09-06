import type { ReceiptSnapshot } from '@/lib/receipts/issueReceipt'
import { formatThermalIssuedAt } from '@/lib/receipts/renderers/formatThermalIssuedAt'
import { formatReceiptMoney } from '@/lib/receipts/renderers/formatReceiptMoney'
import { formatPaymentLabel } from '@/lib/receipts/formatPaymentLabel'
import {
  centered,
  DEFAULT_CHARACTER_WIDTH,
  divider,
  EscposBuilder,
  truncate,
  twoColumnLine,
  wrapToWidth,
} from '@/lib/receipts/renderers/thermal-primitives'

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

function money(snapshot: ReceiptSnapshot, value: number): string {
  return formatReceiptMoney(value, snapshot.outlet?.currency ?? 'NAD')
}

/** '' for both null and a snapshot frozen before order_instructions existed (#135). */
function orderNote(snapshot: ReceiptSnapshot): string {
  return typeof snapshot.order_instructions === 'string' ? snapshot.order_instructions.trim() : ''
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

  const note = orderNote(snapshot)
  if (note) {
    builder.line(divider(characterWidth))
    builder.line(truncate('ORDER NOTE', characterWidth))
    for (const noteLine of wrapToWidth(note, characterWidth)) {
      builder.line(noteLine)
    }
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

  /**
   * THE GRATUITY, AND THEN WHAT WAS ACTUALLY CHARGED.
   *
   * A customer charged more than the bill needs to see why, on the paper in their hand. The order
   * is: Total (the food) -> Gratuity -> Total (what left their card).
   *
   * PRESENCE-CHECKED, NEVER DEFAULTED. `tip` is permanently optional and absent means UNKNOWN,
   * not zero: every receipt issued before the field existed has no gratuity recorded either way.
   * Printing "Gratuity 0.00" on those would assert something nobody recorded, so a snapshot
   * without the field prints exactly what it printed before — one Total, nothing added.
   */
  const tip = snapshot.totals.tip
  if (typeof tip === 'number' && tip > 0) {
    builder.line(twoColumnLine('Gratuity', money(snapshot, tip), characterWidth))
    builder.bold(true)
    builder.line(
      twoColumnLine('Total', money(snapshot, snapshot.totals.grand_total + tip), characterWidth),
    )
    builder.bold(false)
  }

  builder.line()

  for (const payment of snapshot.payments) {
    builder.line(
      twoColumnLine(
        formatPaymentLabel(payment.method, payment.masked_reference),
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
