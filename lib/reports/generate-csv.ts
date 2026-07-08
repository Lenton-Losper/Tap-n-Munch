import { ReportData, ReportOrder } from './get-report-data'

const formatCurrency = (amount: number) => amount.toFixed(2)

const formatDate = (iso: string) => {
  const d = new Date(iso)
  return d.toLocaleString('en-NA', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
}

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

  // Report header metadata
  lines.push(`FlashTap Order Report`)
  lines.push(`Restaurant,${escapeCell(report.restaurant.name)}`)
  lines.push(`Period,${report.filters.startDate} to ${report.filters.endDate}`)
  lines.push(`Generated,${formatDate(report.generatedAt)}`)
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
      formatDate(order.placed_at),
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
