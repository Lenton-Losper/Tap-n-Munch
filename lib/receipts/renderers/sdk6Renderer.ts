import type { ReceiptSnapshot } from '@/lib/receipts/issueReceipt'
import { formatThermalIssuedAt } from '@/lib/receipts/renderers/formatThermalIssuedAt'
import { formatReceiptMoney } from '@/lib/receipts/renderers/formatReceiptMoney'

/**
 * Pure structured-line renderer for a receipt snapshot, for the P5's built-in Wiseasy
 * SDK6 printer -- it only accepts structured calls (addSingleText, addMultiText), not raw
 * ESC/POS bytes. Same enforced boundary as escposRenderer.ts/htmlRenderer.ts: no Supabase
 * client, no order/payment lookups, no orderId parameter. Mirrors their content.
 */

export type Sdk6ReceiptLine =
  | { type: 'text'; text: string; align: 'LEFT' | 'CENTER' | 'RIGHT'; bold?: boolean; large?: boolean }
  | { type: 'row'; columns: string[] }
  | { type: 'feed'; lines: number }
  | { type: 'divider' }

export interface Sdk6RenderOptions {
  /** Immutable receipt document number (e.g. RCT-000187) from receipt_documents. */
  documentNumber?: string
  /** ISO issued_at from receipt_documents. */
  issuedAt?: string
}

function money(snapshot: ReceiptSnapshot, value: number): string {
  return formatReceiptMoney(value, snapshot.outlet?.currency ?? 'NAD')
}

export function renderReceiptSdk6(
  snapshot: ReceiptSnapshot,
  options: Sdk6RenderOptions = {},
): Sdk6ReceiptLine[] {
  const lines: Sdk6ReceiptLine[] = []

  lines.push({ type: 'text', text: snapshot.outlet.restaurant_name, align: 'CENTER', bold: true, large: true })
  if (snapshot.outlet.address) {
    lines.push({ type: 'text', text: snapshot.outlet.address, align: 'CENTER' })
  }
  if (snapshot.outlet.vat_number) {
    lines.push({ type: 'text', text: `VAT: ${snapshot.outlet.vat_number}`, align: 'CENTER' })
  }
  if (snapshot.outlet.registration_number) {
    lines.push({
      type: 'text',
      text: `Reg: ${snapshot.outlet.registration_number}`,
      align: 'CENTER',
    })
  }
  lines.push({ type: 'feed', lines: 1 })

  if (options.documentNumber) {
    lines.push({ type: 'row', columns: ['Receipt', options.documentNumber] })
  }
  const issuedLabel = formatThermalIssuedAt(options.issuedAt)
  if (issuedLabel) {
    lines.push({ type: 'row', columns: ['Issued', issuedLabel] })
  }
  if (snapshot.table_number != null) {
    lines.push({ type: 'row', columns: ['Table', String(snapshot.table_number)] })
  }
  if (snapshot.staff_name) {
    lines.push({ type: 'row', columns: ['Staff', snapshot.staff_name] })
  }
  if (options.documentNumber || issuedLabel || snapshot.table_number != null || snapshot.staff_name) {
    lines.push({ type: 'feed', lines: 1 })
  }

  for (const item of snapshot.line_items) {
    lines.push({ type: 'text', text: item.name, align: 'LEFT' })
    for (const mod of item.modifiers ?? []) {
      lines.push({ type: 'text', text: `  + ${mod}`, align: 'LEFT' })
    }
    lines.push({
      type: 'row',
      columns: [`${item.quantity} x ${money(snapshot, item.unit_price)}`, money(snapshot, item.line_total)],
    })
  }

  lines.push({ type: 'divider' })
  lines.push({ type: 'row', columns: ['Subtotal', money(snapshot, snapshot.totals.subtotal)] })
  lines.push({ type: 'row', columns: ['VAT', money(snapshot, snapshot.totals.vat)] })
  if (snapshot.totals.discount > 0) {
    lines.push({
      type: 'row',
      columns: ['Discount', `-${money(snapshot, snapshot.totals.discount)}`],
    })
  }
  lines.push({ type: 'row', columns: ['Total', money(snapshot, snapshot.totals.grand_total)] })
  lines.push({ type: 'feed', lines: 1 })

  for (const payment of snapshot.payments) {
    lines.push({
      type: 'row',
      columns: [
        `${payment.method.toUpperCase()} ${payment.masked_reference}`,
        money(snapshot, payment.amount),
      ],
    })
  }

  lines.push({ type: 'feed', lines: 1 })
  lines.push({ type: 'text', text: 'Thank you', align: 'CENTER' })
  lines.push({ type: 'feed', lines: 3 })

  return lines
}
