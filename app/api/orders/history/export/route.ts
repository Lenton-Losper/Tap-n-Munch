import { NextResponse } from 'next/server'
import { isAuthError, requireCallerRestaurantPermission } from '@/lib/api/require-staff-permission'
import { PERMISSIONS } from '@/lib/permissions'
import { getReportData } from '@/lib/reports/get-report-data'
import { generateCsv } from '@/lib/reports/generate-csv'
import { generatePdfBytes } from '@/lib/reports/generate-pdf-lib'

export const dynamic = 'force-dynamic'

export async function POST(request: Request) {
  const auth = await requireCallerRestaurantPermission(PERMISSIONS.ORDERS_READ, request)
  if (isAuthError(auth)) return auth

  let body: Record<string, unknown>
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const format = String(body.format || '').toLowerCase()
  const startDate = String(body.startDate || '').trim()
  const endDate = String(body.endDate || '').trim()

  if (!['pdf', 'csv'].includes(format)) {
    return NextResponse.json({ error: 'format must be pdf or csv' }, { status: 400 })
  }
  if (!startDate || !endDate) {
    return NextResponse.json({ error: 'startDate and endDate are required' }, { status: 400 })
  }

  const tableRaw = body.tableNumber
  const tableNumber =
    tableRaw !== undefined && tableRaw !== null && String(tableRaw).trim() !== ''
      ? Number(tableRaw)
      : undefined
  const status =
    body.status && String(body.status) !== 'all' ? String(body.status) : undefined

  const report = await getReportData({
    restaurantId: auth.restaurantId,
    startDate,
    endDate,
    tableNumber: Number.isFinite(tableNumber) ? tableNumber : undefined,
    status,
  })

  const filename = `flashtap-report-${startDate}-to-${endDate}.${format}`

  if (format === 'csv') {
    const csv = generateCsv(report)
    return new NextResponse(csv, {
      status: 200,
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${filename}"`,
      },
    })
  }

  const pdfBytes = await generatePdfBytes(report)
  return new NextResponse(Buffer.from(pdfBytes), {
    status: 200,
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${filename}"`,
    },
  })
}
