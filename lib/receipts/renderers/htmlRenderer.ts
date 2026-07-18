import type { ReceiptSnapshot } from '@/lib/receipts/issueReceipt'

/**
 * Pure HTML renderer for a receipt snapshot. Enforced boundary: this file must never
 * import a Supabase client or take an orderId -- it only knows how to turn the
 * already-assembled snapshot_json shape into an HTML string. Any DB/order/payment lookup
 * belongs in lib/receipts/issueReceipt.ts, not here. Mirrors the content of escposRenderer.ts.
 */

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function formatMoney(value: number): string {
  return value.toFixed(2)
}

export function renderReceiptHtml(snapshot: ReceiptSnapshot): string {
  const lineItemsHtml = snapshot.line_items
    .map(
      (item) => `
        <tr>
          <td style="padding: 4px 0;">${escapeHtml(item.name)}</td>
          <td style="padding: 4px 0; text-align: right; white-space: nowrap;">${item.quantity} x ${formatMoney(item.unit_price)}</td>
          <td style="padding: 4px 0; text-align: right; white-space: nowrap;">${formatMoney(item.line_total)}</td>
        </tr>`,
    )
    .join('')

  const discountRowHtml =
    snapshot.totals.discount > 0
      ? `
        <tr>
          <td colspan="2" style="padding: 2px 0;">Discount</td>
          <td style="padding: 2px 0; text-align: right;">-${formatMoney(snapshot.totals.discount)}</td>
        </tr>`
      : ''

  const paymentsHtml = snapshot.payments
    .map(
      (payment) => `
        <tr>
          <td colspan="2" style="padding: 2px 0;">${escapeHtml(payment.method.toUpperCase())} ${escapeHtml(payment.masked_reference)}</td>
          <td style="padding: 2px 0; text-align: right;">${formatMoney(payment.amount)}</td>
        </tr>`,
    )
    .join('')

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<title>Receipt</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; color: #1a1a1a; max-width: 380px; margin: 0 auto; padding: 24px 16px; }
  h1 { font-size: 18px; font-weight: 600; text-align: center; margin: 0 0 4px; }
  .address { text-align: center; font-size: 13px; color: #555; margin: 0 0 16px; }
  table { width: 100%; border-collapse: collapse; font-size: 14px; }
  .divider td { border-top: 1px solid #ccc; padding: 0; }
  .total td { font-weight: 700; padding-top: 6px; }
  .thank-you { text-align: center; margin-top: 20px; font-size: 13px; color: #555; }
  @media print {
    body { max-width: none; }
  }
</style>
</head>
<body>
  <h1>${escapeHtml(snapshot.outlet.restaurant_name)}</h1>
  ${snapshot.outlet.address ? `<p class="address">${escapeHtml(snapshot.outlet.address)}</p>` : ''}
  <table>
    <tbody>
      ${lineItemsHtml}
      <tr class="divider"><td colspan="3"></td></tr>
      <tr>
        <td colspan="2" style="padding: 2px 0;">Subtotal</td>
        <td style="padding: 2px 0; text-align: right;">${formatMoney(snapshot.totals.subtotal)}</td>
      </tr>
      <tr>
        <td colspan="2" style="padding: 2px 0;">VAT</td>
        <td style="padding: 2px 0; text-align: right;">${formatMoney(snapshot.totals.vat)}</td>
      </tr>
      ${discountRowHtml}
      <tr class="total">
        <td colspan="2">Total</td>
        <td style="text-align: right;">${formatMoney(snapshot.totals.grand_total)}</td>
      </tr>
    </tbody>
  </table>
  <table style="margin-top: 12px;">
    <tbody>
      ${paymentsHtml}
    </tbody>
  </table>
  <p class="thank-you">Thank you</p>
</body>
</html>`
}
