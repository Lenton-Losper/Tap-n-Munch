import { NextResponse } from 'next/server'
import { isAuthError, requireUrlRestaurantPermission } from '@/lib/api/require-staff-permission'
import { PERMISSIONS } from '@/lib/permissions'
import { getReportData } from '@/lib/reports/get-report-data'
import { generateCsv } from '@/lib/reports/generate-csv'
import { generatePdfBlob } from '@/lib/reports/generate-pdf-lib'
import { getResend } from '@/lib/email/resend'

export const dynamic = 'force-dynamic'

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params

    const auth = await requireUrlRestaurantPermission(id, PERMISSIONS.ORDERS_READ, request)
    if (isAuthError(auth)) return auth

    const body = await request.json()
    const { email, format, startDate, endDate, tableNumber, status } = body

    if (!email || typeof email !== 'string') {
      return NextResponse.json({ error: 'email is required' }, { status: 400 })
    }
    if (!['pdf', 'csv'].includes(format)) {
      return NextResponse.json({ error: 'format must be pdf or csv' }, { status: 400 })
    }
    if (!startDate || !endDate) {
      return NextResponse.json({ error: 'startDate and endDate are required' }, { status: 400 })
    }

    const report = await getReportData({
      restaurantId: auth.restaurantId,
      startDate,
      endDate,
      tableNumber: tableNumber ? Number(tableNumber) : undefined,
      status: status && status !== 'all' ? status : undefined,
    })

    let attachmentContent: string
    let attachmentName: string
    let attachmentType: string

    if (format === 'pdf') {
      const pdfBlob = await generatePdfBlob(report)
      attachmentContent = Buffer.from(await pdfBlob.arrayBuffer()).toString('base64')
      attachmentName = `flashtap-report-${startDate}-to-${endDate}.pdf`
      attachmentType = 'application/pdf'
    } else {
      attachmentContent = Buffer.from(generateCsv(report)).toString('base64')
      attachmentName = `flashtap-report-${startDate}-to-${endDate}.csv`
      attachmentType = 'text/csv'
    }

    const periodLabel = startDate === endDate
      ? startDate
      : `${startDate} to ${endDate}`

    await getResend().emails.send({
      from: 'FlashTap Reports <noreply@flashtap.app>',
      to: [email],
      subject: `${report.restaurant.name} — Order Report (${periodLabel})`,
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h2 style="color: #2E75B6;">FlashTap Order Report</h2>
          <p>Hi,</p>
          <p>Please find attached the order report for <strong>${report.restaurant.name}</strong> for the period <strong>${periodLabel}</strong>.</p>
          <table style="width: 100%; border-collapse: collapse; margin: 20px 0;">
            <tr style="background: #EBF3FB;">
              <td style="padding: 10px; font-weight: bold;">Total Revenue</td>
              <td style="padding: 10px;">N$${report.summary.totalRevenue.toFixed(2)}</td>
            </tr>
            <tr>
              <td style="padding: 10px; font-weight: bold;">Total Orders</td>
              <td style="padding: 10px;">${report.summary.totalOrders}</td>
            </tr>
            <tr style="background: #EBF3FB;">
              <td style="padding: 10px; font-weight: bold;">Average Order Value</td>
              <td style="padding: 10px;">N$${report.summary.averageOrderValue.toFixed(2)}</td>
            </tr>
          </table>
          <p style="color: #666; font-size: 12px;">Sent by FlashTap &mdash; noreply@flashtap.app</p>
        </div>
      `,
      attachments: [
        {
          filename: attachmentName,
          content: attachmentContent,
          contentType: attachmentType,
        },
      ],
    })

    return NextResponse.json({ success: true })
  } catch (err: unknown) {
    console.error('Report email error:', err)
    const message = err instanceof Error ? err.message : 'Failed to send report'
    const status =
      message.includes('authorization') ||
      message.includes('session') ||
      message.includes('Authentication')
        ? 401
        : message.includes('permission') || message.includes('Forbidden')
          ? 403
          : 500
    return NextResponse.json({ error: message }, { status })
  }
}
