import { ReportData, ReportOrder } from './get-report-data'
import { formatReportDateTime } from './format-report-datetime'

const formatCurrency = (amount: number) => amount.toFixed(2)

const escapeCell = (value: string | number | null | undefined): string => {
  if (value === null || value === undefined) return ''
  const str = String(value)
  // Wrap in quotes if contains comma, quote, or newline
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return `"${str.replace(/"/g, '""')}"`
  }
  return str
}

function formatCsvStatus(order: ReportOrder): string {
  const base = order.status || ''
  if (order.paymentStatus === 'refunded') return `${base} (refunded)`
  if (order.paymentStatus === 'partially_refunded') return `${base} (partial refund)`
  return base
}

export function generateCsv(report: ReportData): string {
  const lines: string[] = []
  const tz = report.restaurant.timezone

  // Report header metadata
  lines.push(`FlashTap Order Report`)
  lines.push(`Restaurant,${escapeCell(report.restaurant.name)}`)
  lines.push(`Period,${report.filters.startDate} to ${report.filters.endDate}`)
  lines.push(`Timezone,${escapeCell(tz)}`)
  lines.push(`Generated,${formatReportDateTime(report.generatedAt, tz)}`)
  lines.push(``)

  // Summary
  lines.push(`Summary`)
  lines.push(`Total Revenue,N$${formatCurrency(report.summary.totalRevenue)}`)
  lines.push(`Total Orders,${report.summary.totalOrders}`)
  lines.push(`Average Order Value,N$${formatCurrency(report.summary.averageOrderValue)}`)
  lines.push(``)

  // Orders table header
  lines.push([
    'Order #',
    'Time',
    'Table',
    'Customer',
    'Items',
    'Total (N$)',
    'Refunded Amount (N$)',
    'Payment Method',
    'Payment Channel',
    'Status',
  ].map(escapeCell).join(','))

  // Order rows
  for (const order of report.orders) {
    lines.push([
      order.order_number,
      formatReportDateTime(order.placed_at, tz),
      order.table_number,
      order.customer_name,
      order.items,
      formatCurrency(order.total),
      formatCurrency(Number(order.refundedAmount) || 0),
      order.payment_method,
      order.payment_channel,
      formatCsvStatus(order),
    ].map(escapeCell).join(','))
  }

  return lines.join('\n')
}

export function downloadCsv(report: ReportData, filename?: string): void {
  const csv = generateCsv(report)
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename ?? `flashtap-report-${report.filters.startDate}-to-${report.filters.endDate}.csv`
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}
