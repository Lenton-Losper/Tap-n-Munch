import { NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { getReportData } from '@/lib/reports/get-report-data'
import { generateCsv } from '@/lib/reports/generate-csv'
import { getResend } from '@/lib/email/resend'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

export async function GET(request: Request) {
  // Verify this is a legitimate Vercel cron call
  const authHeader = request.headers.get('authorization')
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const supabase = createServerSupabaseClient()
  const now = new Date()

  // Find all enabled schedules not sent in the last 23 hours (deduplication)
  const twentyThreeHoursAgo = new Date(now.getTime() - 23 * 60 * 60 * 1000).toISOString()

  const { data: schedules, error: schedulesError } = await supabase
    .from('report_schedules')
    .select('*')
    .eq('enabled', true)
    .or(`last_sent_at.is.null,last_sent_at.lt.${twentyThreeHoursAgo}`)

  if (schedulesError) {
    console.error('[CRON] Failed to load schedules:', schedulesError)
    return NextResponse.json({ error: schedulesError.message }, { status: 500 })
  }

  const eligible = schedules ?? []

  console.log(`[CRON] ${eligible.length} schedules eligible out of ${(schedules ?? []).length} enabled`)

  const results: { scheduleId: string; status: string; error?: string }[] = []

  // Process each schedule independently — one failure must not block others
  for (const schedule of eligible) {
    const start = Date.now()
    // Report covers yesterday in the schedule's timezone
    const yesterday = new Date(now)
    yesterday.setDate(yesterday.getDate() - 1)
    const reportPeriod = yesterday.toISOString().split('T')[0] // YYYY-MM-DD

    try {
      const report = await getReportData({
        restaurantId: schedule.restaurant_id,
        startDate: reportPeriod,
        endDate: reportPeriod,
      })

      let attachmentContent: string
      let attachmentName: string
      let attachmentType: string

      if (schedule.format === 'csv') {
        attachmentContent = Buffer.from(generateCsv(report)).toString('base64')
        attachmentName = `flashtap-report-${reportPeriod}.csv`
        attachmentType = 'text/csv'
      } else {
        const { generatePdfBlob } = await import('@/lib/reports/generate-pdf')
        const blob = await generatePdfBlob(report)
        const buffer = Buffer.from(await blob.arrayBuffer())
        attachmentContent = buffer.toString('base64')
        attachmentName = `flashtap-report-${reportPeriod}.pdf`
        attachmentType = 'application/pdf'
      }

      const resend = getResend()
      await resend.emails.send({
        from: 'FlashTap Reports <noreply@flashtap.app>',
        to: [schedule.email],
        subject: `${report.restaurant.name} — Daily Report (${reportPeriod})`,
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
            <h2 style="color: #2E75B6;">FlashTap Daily Report</h2>
            <p>Your daily order report for <strong>${report.restaurant.name}</strong> — <strong>${reportPeriod}</strong>.</p>
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
            <p style="color: #666; font-size: 12px;">Sent automatically by FlashTap</p>
          </div>
        `,
        attachments: [{ filename: attachmentName, content: attachmentContent, contentType: attachmentType }],
      })

      const duration = Date.now() - start

      // Log success
      await supabase.from('report_send_log').insert({
        schedule_id: schedule.id,
        restaurant_id: schedule.restaurant_id,
        report_period: reportPeriod,
        status: 'success',
        duration_ms: duration,
      })

      // Update last_sent_at
      await supabase
        .from('report_schedules')
        .update({ last_sent_at: now.toISOString() })
        .eq('id', schedule.id)

      console.log(`[CRON] Sent report for schedule ${schedule.id} in ${duration}ms`)
      results.push({ scheduleId: schedule.id, status: 'success' })

    } catch (err: unknown) {
      const duration = Date.now() - start
      const message = err instanceof Error ? err.message : 'Unknown error'
      console.error(`[CRON] Failed schedule ${schedule.id}:`, message)

      // Log failure — do not rethrow
      await supabase.from('report_send_log').insert({
        schedule_id: schedule.id,
        restaurant_id: schedule.restaurant_id,
        report_period: reportPeriod,
        status: 'failed',
        error: message,
        duration_ms: duration,
      })

      results.push({ scheduleId: schedule.id, status: 'failed', error: message })
    }
  }

  return NextResponse.json({ processed: eligible.length, results })
}
