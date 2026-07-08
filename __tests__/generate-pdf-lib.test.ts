import { PDFDocument } from 'pdf-lib'
import { generatePdfBytes } from '@/lib/reports/generate-pdf-lib'
import type { ReportData } from '@/lib/reports/get-report-data'

function sampleReport(orderCount: number): ReportData {
  const orders = Array.from({ length: orderCount }, (_, i) => ({
    order_number: i + 1,
    placed_at: `2026-07-04T${String(10 + (i % 10)).padStart(2, '0')}:30:00.000Z`,
    table_number: (i % 12) + 1,
    customer_name: i % 3 === 0 ? `Guest ${i + 1}` : null,
    items:
      i % 5 === 0
        ? 'Burger, Fries x2, Large milkshake with extra whipped cream'
        : 'Espresso, Croissant',
    total: 45.5 + i,
    payment_method: i % 2 === 0 ? 'card' : 'cash',
    payment_channel: 'pos',
    status: 'completed',
    paymentStatus: null,
    refundedAmount: 0,
  }))

  return {
    restaurant: { id: 'test', name: 'Riviera Test Kitchen', logo_url: null },
    filters: { startDate: '2026-07-01', endDate: '2026-07-04' },
    summary: {
      totalRevenue: orders.reduce((sum, o) => sum + o.total, 0),
      totalOrders: orders.length,
      averageOrderValue:
        orders.length > 0 ? orders.reduce((sum, o) => sum + o.total, 0) / orders.length : 0,
    },
    orders,
    generatedAt: '2026-07-04T09:00:00.000Z',
  }
}

describe('generatePdfBytes', () => {
  it('produces a valid single-page PDF for a small report', async () => {
    const bytes = await generatePdfBytes(sampleReport(4))
    const header = new TextDecoder().decode(bytes.slice(0, 5))
    expect(header).toBe('%PDF-')

    const doc = await PDFDocument.load(bytes)
    expect(doc.getPageCount()).toBe(1)
  })

  it('paginates when many orders are included', async () => {
    const bytes = await generatePdfBytes(sampleReport(40))
    const doc = await PDFDocument.load(bytes)
    expect(doc.getPageCount()).toBeGreaterThan(1)
  })
})
