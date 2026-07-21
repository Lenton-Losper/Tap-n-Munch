import type { ReceiptSnapshot } from '@/lib/receipts/issueReceipt'

/**
 * Pure HTML renderer for a receipt snapshot. Enforced boundary: this file must never
 * import a Supabase client or take an orderId -- it only knows how to turn the
 * already-assembled snapshot_json shape into an HTML string. Any DB/order/payment lookup
 * belongs in lib/receipts/issueReceipt.ts, not here.
 *
 * Two layouts share one document, toggled by @media print (email clients ignore that
 * media query, so .screen-only stays the one they render):
 *  - .screen-only: the email-body / "View Receipt" card. Tables + inline styles, not just
 *    a <style> block, since many email clients (Outlook desktop, Yahoo, some corporate
 *    filters) strip <head><style> and flexbox/grid entirely.
 *  - .print-only: a native 80mm-width layout for "Print from this computer" (browser
 *    window.print() through the Windows driver of a physically attached thermal printer --
 *    see docs/issue-fix-log for the investigation). The old design used a fixed 420px-wide
 *    centered card for print too; on an ~80mm/302px printable width that meant every
 *    right-aligned price column (the far-right edge of a 420px row) got clipped off the
 *    physical page while left-aligned labels stayed visible -- print preview confirmed
 *    actual clipping, not just scaling. This layout has no fixed pixel width, so it fills
 *    whatever printable width the driver reports.
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

/** Print layout only -- matches the reference receipt's "N$230.00" format. */
function formatMoneyPrint(value: number): string {
  return `N$${formatMoney(value)}`
}

/** Print layout only -- server's local time, same convention as lib/receipts/renderers/pdfRenderer.ts formatDate(). */
function formatDateTimePrint(iso: string | undefined): string {
  if (!iso) return ''
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  const day = String(date.getDate()).padStart(2, '0')
  const month = date.toLocaleString('en-GB', { month: 'short' })
  const year = date.getFullYear()
  const hours = String(date.getHours()).padStart(2, '0')
  const minutes = String(date.getMinutes()).padStart(2, '0')
  return `${day} ${month} ${year} ${hours}:${minutes}`
}

export interface HtmlRenderOptions {
  documentNumber?: string
  issuedAt?: string
}

const COLORS = {
  ink: '#111827',
  body: '#1f2937',
  muted: '#6b7280',
  faint: '#9ca3af',
  border: '#eef0f2',
  rowBorder: '#f4f5f6',
  page: '#f3f4f6',
}

function renderScreenCard(snapshot: ReceiptSnapshot): string {
  const lineItemsHtml = snapshot.line_items
    .map(
      (item) => `
        <tr>
          <td style="padding: 10px 0; border-bottom: 1px solid ${COLORS.rowBorder}; font-size: 14px; font-weight: 500; color: ${COLORS.body}; vertical-align: top;">${escapeHtml(item.name)}</td>
          <td align="right" style="padding: 10px 0; border-bottom: 1px solid ${COLORS.rowBorder}; font-size: 13px; color: ${COLORS.muted}; white-space: nowrap; vertical-align: top;">${item.quantity} &times; ${formatMoney(item.unit_price)}</td>
          <td align="right" style="padding: 10px 0; border-bottom: 1px solid ${COLORS.rowBorder}; font-size: 14px; color: ${COLORS.ink}; white-space: nowrap; vertical-align: top;">${formatMoney(item.line_total)}</td>
        </tr>`,
    )
    .join('')

  const summaryRow = (label: string, value: string, opts?: { emphasize?: boolean }) => `
        <tr>
          <td style="padding: ${opts?.emphasize ? '10px' : '3px'} 0 ${opts?.emphasize ? '0' : '3px'}; ${opts?.emphasize ? `border-top: 1px solid ${COLORS.ink};` : ''} font-size: ${opts?.emphasize ? '16px' : '14px'}; font-weight: ${opts?.emphasize ? '700' : '400'}; color: ${opts?.emphasize ? COLORS.ink : COLORS.muted};">${escapeHtml(label)}</td>
          <td align="right" style="padding: ${opts?.emphasize ? '10px' : '3px'} 0 ${opts?.emphasize ? '0' : '3px'}; ${opts?.emphasize ? `border-top: 1px solid ${COLORS.ink};` : ''} font-size: ${opts?.emphasize ? '16px' : '14px'}; font-weight: ${opts?.emphasize ? '700' : '400'}; color: ${COLORS.ink};">${value}</td>
        </tr>`

  const summaryHtml = [
    summaryRow('Subtotal', formatMoney(snapshot.totals.subtotal)),
    summaryRow('VAT', formatMoney(snapshot.totals.vat)),
    snapshot.totals.discount > 0 ? summaryRow('Discount', `-${formatMoney(snapshot.totals.discount)}`) : '',
    summaryRow('Total', formatMoney(snapshot.totals.grand_total), { emphasize: true }),
  ].join('')

  const paymentsHtml = snapshot.payments
    .map(
      (payment) => `
        <tr>
          <td style="padding: 3px 0; font-size: 14px; color: ${COLORS.body};">${escapeHtml(payment.method.toUpperCase())} ${escapeHtml(payment.masked_reference)}</td>
          <td align="right" style="padding: 3px 0; font-size: 14px; color: ${COLORS.ink};">${formatMoney(payment.amount)}</td>
        </tr>`,
    )
    .join('')

  const paymentsSectionHtml = snapshot.payments.length
    ? `
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top: 20px; padding-top: 16px; border-top: 1px dashed #d1d5db;">
          <tr>
            <td colspan="2" style="padding: 0 0 8px; font-size: 11px; font-weight: 600; color: ${COLORS.faint}; text-transform: uppercase; letter-spacing: 0.04em;">Payment</td>
          </tr>
          ${paymentsHtml}
        </table>`
    : ''

  return `
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" class="screen-only" style="background-color: ${COLORS.page};">
    <tr>
      <td align="center" style="padding: 24px 12px;">
        <table role="presentation" width="420" cellpadding="0" cellspacing="0" class="card" style="width: 420px; max-width: 100%; background: #ffffff; border-radius: 12px; box-shadow: 0 1px 3px rgba(0,0,0,0.08); border: 1px solid ${COLORS.border};">
          <tr>
            <td align="center" style="padding: 28px 28px 16px; border-bottom: 1px solid ${COLORS.border};">
              <div style="font-size: 20px; font-weight: 700; color: ${COLORS.ink}; letter-spacing: -0.01em;">${escapeHtml(snapshot.outlet.restaurant_name)}</div>
              ${snapshot.outlet.address ? `<div style="margin-top: 4px; font-size: 13px; color: ${COLORS.muted};">${escapeHtml(snapshot.outlet.address)}</div>` : ''}
            </td>
          </tr>
          <tr>
            <td style="padding: 20px 28px;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <th align="left" style="padding: 0 0 8px; border-bottom: 1px solid ${COLORS.border}; font-size: 11px; font-weight: 600; color: ${COLORS.faint}; text-transform: uppercase; letter-spacing: 0.04em;">Item</th>
                  <th align="right" style="padding: 0 0 8px; border-bottom: 1px solid ${COLORS.border}; font-size: 11px; font-weight: 600; color: ${COLORS.faint}; text-transform: uppercase; letter-spacing: 0.04em;">Qty</th>
                  <th align="right" style="padding: 0 0 8px; border-bottom: 1px solid ${COLORS.border}; font-size: 11px; font-weight: 600; color: ${COLORS.faint}; text-transform: uppercase; letter-spacing: 0.04em;">Total</th>
                </tr>
                ${lineItemsHtml}
              </table>

              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top: 4px;">
                ${summaryHtml}
              </table>

              ${paymentsSectionHtml}
            </td>
          </tr>
          <tr>
            <td align="center" style="padding: 4px 28px 28px;">
              <div style="font-size: 14px; font-weight: 600; color: ${COLORS.ink};">Thank you</div>
              <div style="margin-top: 2px; font-size: 12px; color: ${COLORS.faint};">We hope to see you again soon.</div>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>`
}

function renderPrintLayout(snapshot: ReceiptSnapshot, options: HtmlRenderOptions): string {
  const dashedLine = '<div style="border-top: 1px dashed #000; margin: 8px 0;"></div>'

  // A literal row of asterisks, not a CSS border -- clipped to the container's actual
  // printable width via overflow/nowrap so it never depends on knowing the driver's
  // character count (the same class of assumption that clipped price columns before
  // the 80mm-native layout fix). Repeated enough to outrun any realistic thermal width.
  const asteriskRule = '<div style="overflow: hidden; white-space: nowrap; font-size: 12px; line-height: 1;">' + '* '.repeat(60) + '</div>'

  const totalItemCount = snapshot.line_items.reduce((sum, item) => sum + item.quantity, 0)

  const lineItemsHtml = snapshot.line_items
    .map((item) => {
      const unitPriceNote =
        item.quantity > 1
          ? `<div style="font-size: 11px; color: #333;">@ ${formatMoneyPrint(item.unit_price)} each</div>`
          : ''
      return `
        <tr>
          <td style="width: 56%; padding: 3px 4px 3px 0; font-size: 13px; color: #000; vertical-align: top; word-break: break-word;">${escapeHtml(item.name)}${unitPriceNote}</td>
          <td align="center" style="width: 12%; padding: 3px 0; font-size: 13px; color: #000; vertical-align: top;">${item.quantity}</td>
          <td align="right" style="width: 32%; padding: 3px 0 3px 4px; font-size: 13px; color: #000; white-space: nowrap; vertical-align: top;">${formatMoneyPrint(item.line_total)}</td>
        </tr>`
    })
    .join('')

  const breakdownRow = (label: string, value: string) => `
        <tr>
          <td style="padding: 2px 0; font-size: 12px; color: #000;">${escapeHtml(label)}</td>
          <td align="right" style="padding: 2px 0; font-size: 12px; color: #000; white-space: nowrap;">${value}</td>
        </tr>`

  const breakdownHtml = [
    breakdownRow('Subtotal (excl. VAT)', formatMoneyPrint(snapshot.totals.subtotal)),
    snapshot.totals.discount > 0 ? breakdownRow('Discount', `-${formatMoneyPrint(snapshot.totals.discount)}`) : '',
    breakdownRow('VAT', formatMoneyPrint(snapshot.totals.vat)),
  ].join('')

  const issuedAtText = formatDateTimePrint(options.issuedAt)

  return `
  <div class="print-only" style="display: none; width: 100%; box-sizing: border-box; padding: 0 3mm; font-family: 'Courier New', Courier, monospace; color: #000;">
    <div style="border-left: 1px solid #000; border-right: 1px solid #000; padding: 2px 4px;">
      ${asteriskRule}
      <div style="text-align: center;">
        <div style="font-size: 16px; font-weight: 700;">${escapeHtml(snapshot.outlet.restaurant_name)}</div>
        ${snapshot.outlet.address ? `<div style="margin-top: 2px; font-size: 11px;">${escapeHtml(snapshot.outlet.address)}</div>` : ''}
      </div>
      ${asteriskRule}
    </div>

    <div style="text-align: center; margin-top: 6px; font-size: 12px;">-YOUR RECEIPT-</div>

    ${options.documentNumber ? `<div style="text-align: center; margin-top: 6px; font-size: 13px; font-weight: 700;">Receipt No: ${escapeHtml(options.documentNumber)}</div>` : ''}
    ${issuedAtText ? `<div style="text-align: center; font-size: 11px;">${escapeHtml(issuedAtText)}</div>` : ''}
    ${snapshot.customer_name ? `<div style="text-align: center; font-size: 11px;">Name: ${escapeHtml(snapshot.customer_name)}</div>` : ''}

    ${dashedLine}

    <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
      <tr>
        <th align="left" style="width: 56%; padding: 0 4px 3px 0; font-size: 10px; font-weight: 700;">ITEM DESCRIPTION</th>
        <th align="center" style="width: 12%; padding: 0 0 3px; font-size: 10px; font-weight: 700;">QTY</th>
        <th align="right" style="width: 32%; padding: 0 0 3px 4px; font-size: 10px; font-weight: 700;">PRICE</th>
      </tr>
      ${lineItemsHtml}
    </table>

    ${dashedLine}

    <div style="text-align: center; font-size: 19px; font-weight: 700; padding: 4px 0;">
      Total: ${formatMoneyPrint(snapshot.totals.grand_total)}
    </div>

    ${dashedLine}

    <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
      ${breakdownHtml}
    </table>

    <div style="font-size: 12px; margin-top: 4px;">Items: ${totalItemCount}</div>

    <div style="text-align: left; margin-top: 14px; font-size: 13px; font-weight: 700;">Thank you</div>
  </div>`
}

export function renderReceiptHtml(snapshot: ReceiptSnapshot, options: HtmlRenderOptions = {}): string {
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Receipt</title>
<style>
  body { margin: 0; padding: 0; background-color: ${COLORS.page}; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif; }
  @media print {
    @page { size: 80mm auto; margin: 0; }
    body { background-color: #ffffff; margin: 0; padding: 4mm 0; }
    .screen-only { display: none !important; }
    .print-only { display: block !important; }
  }
</style>
</head>
<body>
  ${renderScreenCard(snapshot)}
  ${renderPrintLayout(snapshot, options)}
</body>
</html>`
}
