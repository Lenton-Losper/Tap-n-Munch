import type { ReceiptSnapshot } from '@/lib/receipts/issueReceipt'

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

function formatMoney(value: number): string {
  return value.toFixed(2)
}

export function renderReceiptSdk6(snapshot: ReceiptSnapshot): Sdk6ReceiptLine[] {
  const lines: Sdk6ReceiptLine[] = []

  lines.push({ type: 'text', text: snapshot.outlet.restaurant_name, align: 'CENTER', bold: true, large: true })
  if (snapshot.outlet.address) {
    lines.push({ type: 'text', text: snapshot.outlet.address, align: 'CENTER' })
  }
  lines.push({ type: 'feed', lines: 1 })

  for (const item of snapshot.line_items) {
    lines.push({ type: 'text', text: item.name, align: 'LEFT' })
    lines.push({
      type: 'row',
      columns: [`${item.quantity} x ${formatMoney(item.unit_price)}`, formatMoney(item.line_total)],
    })
  }

  lines.push({ type: 'divider' })
  lines.push({ type: 'row', columns: ['Subtotal', formatMoney(snapshot.totals.subtotal)] })
  lines.push({ type: 'row', columns: ['VAT', formatMoney(snapshot.totals.vat)] })
  if (snapshot.totals.discount > 0) {
    lines.push({ type: 'row', columns: ['Discount', `-${formatMoney(snapshot.totals.discount)}`] })
  }
  lines.push({ type: 'row', columns: ['Total', formatMoney(snapshot.totals.grand_total)] })
  lines.push({ type: 'feed', lines: 1 })

  for (const payment of snapshot.payments) {
    lines.push({
      type: 'row',
      columns: [`${payment.method.toUpperCase()} ${payment.masked_reference}`, formatMoney(payment.amount)],
    })
  }

  lines.push({ type: 'feed', lines: 1 })
  lines.push({ type: 'text', text: 'Thank you', align: 'CENTER' })
  lines.push({ type: 'feed', lines: 3 })

  return lines
}
