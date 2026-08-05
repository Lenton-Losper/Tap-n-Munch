import type { ReportData } from '@/lib/reports/get-report-data'

/**
 * The daily report email body.
 *
 * The complaint this exists to fix: Anton's team "can only download from Order History and
 * cannot work out how". An attachment-only email repeats that failure. The body must answer
 * "how did we do today" on a phone, without opening anything -- the CSV is for the people who
 * want it in a spreadsheet, not the primary channel.
 */

const money = (n: number) => `N$${(Number.isFinite(n) ? n : 0).toFixed(2)}`

const METHOD_LABELS: Record<string, string> = {
  card: 'Card',
  cash: 'Cash',
  unknown: 'Unrecorded',
}

function esc(s: string): string {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

export function buildDailyReportSubject(report: ReportData, reportPeriod: string): string {
  const { totalOrders, totalRevenue } = report.summary
  if (totalOrders === 0) return `${report.restaurant.name} — no orders ${reportPeriod}`
  return `${report.restaurant.name} — ${money(totalRevenue)}, ${totalOrders} orders (${reportPeriod})`
}

export function buildDailyReportHtml(report: ReportData, reportPeriod: string): string {
  const s = report.summary
  const zero = s.totalOrders === 0

  const row = (label: string, value: string, strong = false) => `
    <tr>
      <td style="padding:10px 12px;border-bottom:1px solid #EEE;color:#555;">${esc(label)}</td>
      <td style="padding:10px 12px;border-bottom:1px solid #EEE;text-align:right;${strong ? 'font-weight:700;font-size:18px;' : ''}">${esc(value)}</td>
    </tr>`

  const splitRows = s.paymentMethodSplit.length
    ? s.paymentMethodSplit
        .map((p) =>
          row(
            `${METHOD_LABELS[p.method] ?? p.method} · ${p.orders} order${p.orders === 1 ? '' : 's'}`,
            money(p.gross),
          ),
        )
        .join('')
    : row('No payments recorded', '—')

  // A zero-order day still sends. Silence is indistinguishable from a broken job, and this
  // pipeline has already lost days without anyone noticing.
  const headline = zero
    ? `<p style="margin:0 0 16px;font-size:15px;color:#333;">No orders recorded for this trading day.</p>`
    : `<p style="margin:0 0 16px;font-size:15px;color:#333;">Trading day <strong>${esc(reportPeriod)}</strong>, ${esc(report.restaurant.timezone)}.</p>`

  const unresolved =
    s.unresolvedOrders > 0
      ? `<p style="margin:16px 0 0;padding:10px 12px;background:#FFF7ED;border:1px solid #FED7AA;border-radius:6px;font-size:13px;color:#7C2D12;">
           ${s.unresolvedOrders} order${s.unresolvedOrders === 1 ? '' : 's'} not settled — still awaiting payment or stuck. Worth a look before close.
         </p>`
      : ''

  const refunds =
    s.refundedTotal > 0 ? row('Refunded', `− ${money(s.refundedTotal)}`) : ''

  return `
<div style="font-family:-apple-system,Segoe UI,Arial,sans-serif;max-width:560px;margin:0 auto;padding:8px;">
  <h2 style="margin:0 0 4px;font-size:20px;color:#111;">${esc(report.restaurant.name)}</h2>
  <p style="margin:0 0 16px;color:#777;font-size:13px;">Daily sales — ${esc(reportPeriod)}</p>
  ${headline}
  <table style="width:100%;border-collapse:collapse;border:1px solid #EEE;border-radius:8px;">
    ${row('Revenue', money(s.totalRevenue), true)}
    ${row('Orders paid', String(s.totalOrders))}
    ${row('Average order', money(s.averageOrderValue))}
    ${refunds}
  </table>

  <h3 style="margin:24px 0 8px;font-size:14px;color:#111;text-transform:uppercase;letter-spacing:.04em;">Payment methods</h3>
  <table style="width:100%;border-collapse:collapse;border:1px solid #EEE;border-radius:8px;">
    ${splitRows}
  </table>
  ${unresolved}

  <p style="margin:24px 0 0;color:#777;font-size:12px;">
    The attached CSV has every order for the day, the same data as Order History.
  </p>
  <p style="margin:8px 0 0;color:#999;font-size:11px;">Sent automatically by FlashTap.</p>
</div>`.trim()
}
