import React from 'react'
import {
  Document,
  Page,
  Text,
  View,
  StyleSheet,
  pdf,
} from '@react-pdf/renderer'
import { ReportData } from './get-report-data'

const formatCurrency = (amount: number) => `N$${amount.toFixed(2)}`

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

const styles = StyleSheet.create({
  page: {
    fontFamily: 'Helvetica',
    fontSize: 9,
    padding: 40,
    color: '#1a1a1a',
    backgroundColor: '#ffffff',
  },
  header: {
    marginBottom: 20,
    borderBottomWidth: 2,
    borderBottomColor: '#2E75B6',
    paddingBottom: 10,
  },
  brandName: {
    fontSize: 22,
    fontFamily: 'Helvetica-Bold',
    color: '#2E75B6',
  },
  restaurantName: {
    fontSize: 13,
    fontFamily: 'Helvetica-Bold',
    marginTop: 2,
    color: '#1a1a1a',
  },
  metaRow: {
    fontSize: 8,
    color: '#666666',
    marginTop: 2,
  },
  summaryRow: {
    flexDirection: 'row',
    gap: 12,
    marginBottom: 20,
    marginTop: 16,
  },
  summaryCard: {
    flex: 1,
    backgroundColor: '#EBF3FB',
    borderRadius: 4,
    padding: 10,
  },
  summaryLabel: {
    fontSize: 7,
    color: '#666666',
    marginBottom: 3,
    textTransform: 'uppercase',
  },
  summaryValue: {
    fontSize: 14,
    fontFamily: 'Helvetica-Bold',
    color: '#1a1a1a',
  },
  tableHeader: {
    flexDirection: 'row',
    backgroundColor: '#2E75B6',
    padding: 5,
    borderRadius: 2,
    marginBottom: 1,
  },
  tableHeaderText: {
    color: '#ffffff',
    fontFamily: 'Helvetica-Bold',
    fontSize: 7,
  },
  tableRow: {
    flexDirection: 'row',
    padding: 5,
    borderBottomWidth: 1,
    borderBottomColor: '#eeeeee',
  },
  tableRowAlt: {
    backgroundColor: '#F8FAFC',
  },
  tableCell: {
    fontSize: 8,
    color: '#1a1a1a',
  },
  // Column widths
  colOrderNo:  { width: '7%' },
  colTime:     { width: '13%' },
  colTable:    { width: '7%' },
  colCustomer: { width: '10%' },
  colItems:    { width: '30%' },
  colTotal:    { width: '10%' },
  colPayment:  { width: '12%' },
  colStatus:   { width: '11%' },
  footer: {
    position: 'absolute',
    bottom: 30,
    left: 40,
    right: 40,
    borderTopWidth: 1,
    borderTopColor: '#cccccc',
    paddingTop: 6,
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  footerText: {
    fontSize: 7,
    color: '#999999',
  },
})

interface ReportDocumentProps {
  report: ReportData
}

function ReportDocument({ report }: ReportDocumentProps) {
  return (
    <Document>
      <Page size="A4" orientation="landscape" style={styles.page}>
        {/* Header */}
        <View style={styles.header}>
          <Text style={styles.brandName}>FlashTap</Text>
          <Text style={styles.restaurantName}>{report.restaurant.name}</Text>
          <Text style={styles.metaRow}>
            Period: {report.filters.startDate} to {report.filters.endDate}
            {'   '}Generated: {formatDate(report.generatedAt)}
          </Text>
        </View>

        {/* Summary cards */}
        <View style={styles.summaryRow}>
          <View style={styles.summaryCard}>
            <Text style={styles.summaryLabel}>Total Revenue</Text>
            <Text style={styles.summaryValue}>{formatCurrency(report.summary.totalRevenue)}</Text>
          </View>
          <View style={styles.summaryCard}>
            <Text style={styles.summaryLabel}>Total Orders</Text>
            <Text style={styles.summaryValue}>{report.summary.totalOrders}</Text>
          </View>
          <View style={styles.summaryCard}>
            <Text style={styles.summaryLabel}>Average Order Value</Text>
            <Text style={styles.summaryValue}>{formatCurrency(report.summary.averageOrderValue)}</Text>
          </View>
        </View>

        {/* Table header */}
        <View style={styles.tableHeader}>
          <Text style={[styles.tableHeaderText, styles.colOrderNo]}>Order #</Text>
          <Text style={[styles.tableHeaderText, styles.colTime]}>Time</Text>
          <Text style={[styles.tableHeaderText, styles.colTable]}>Table</Text>
          <Text style={[styles.tableHeaderText, styles.colCustomer]}>Customer</Text>
          <Text style={[styles.tableHeaderText, styles.colItems]}>Items</Text>
          <Text style={[styles.tableHeaderText, styles.colTotal]}>Total</Text>
          <Text style={[styles.tableHeaderText, styles.colPayment]}>Payment</Text>
          <Text style={[styles.tableHeaderText, styles.colStatus]}>Status</Text>
        </View>

        {/* Order rows */}
        {report.orders.map((order, i) => (
          <View
            key={order.order_number}
            style={[styles.tableRow, i % 2 === 1 ? styles.tableRowAlt : {}]}
          >
            <Text style={[styles.tableCell, styles.colOrderNo]}>#{order.order_number}</Text>
            <Text style={[styles.tableCell, styles.colTime]}>{formatDate(order.placed_at)}</Text>
            <Text style={[styles.tableCell, styles.colTable]}>{order.table_number ?? '—'}</Text>
            <Text style={[styles.tableCell, styles.colCustomer]}>{order.customer_name ?? '—'}</Text>
            <Text style={[styles.tableCell, styles.colItems]}>{order.items}</Text>
            <Text style={[styles.tableCell, styles.colTotal]}>{formatCurrency(order.total)}</Text>
            <Text style={[styles.tableCell, styles.colPayment]}>{order.payment_method ?? '—'}</Text>
            <Text style={[styles.tableCell, styles.colStatus]}>{order.status}</Text>
          </View>
        ))}

        {/* Footer */}
        <View style={styles.footer} fixed>
          <Text style={styles.footerText}>FlashTap — Confidential</Text>
          <Text style={styles.footerText} render={({ pageNumber, totalPages }) =>
            `Page ${pageNumber} of ${totalPages}`
          } />
        </View>
      </Page>
    </Document>
  )
}

export async function generatePdfBlob(report: ReportData): Promise<Blob> {
  const doc = <ReportDocument report={report} />
  return await pdf(doc).toBlob()
}

export async function downloadPdf(report: ReportData, filename?: string): Promise<void> {
  const blob = await generatePdfBlob(report)
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename ?? `flashtap-report-${report.filters.startDate}-to-${report.filters.endDate}.pdf`
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}
