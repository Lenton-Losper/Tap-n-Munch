import { NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { requireCronSecret } from '@/lib/api/require-cron-secret'
import { getReportData } from '@/lib/reports/get-report-data'
import { generateCsv } from '@/lib/reports/generate-csv'
import { generatePdfBlob } from '@/lib/reports/generate-pdf-lib'
import { getResend } from '@/lib/email/resend'
import { buildDailyReportHtml, buildDailyReportSubject } from '@/lib/reports/daily-report-email'
import {
  decideDue,
  detectMissedDay,
  type ScheduleRow,
} from '@/lib/reports/schedule-window'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

/** audit_logs.action when a send fails, or when a day was skipped entirely. */
export const REPORT_SEND_FAILED_ACTION = 'report.send_failed'
export const REPORT_DAY_MISSED_ACTION = 'report.day_missed'

/**
 * Daily scheduled sales reports.
 *
 * Invoked from workers/flashtap-worker.ts scheduled() on the shared every-2-minutes trigger, in-process,
 * the same way cleanup-stale-orders is. Runs every 2 minutes and sends nothing until a
 * schedule's local send_time is reached, so per-restaurant times cost no extra cron.
 *
 * Auth: x-cron-secret via requireCronSecret, matching the other cron route. The previous
 * `Authorization: Bearer` check was Vercel-shaped; the Vercel cron entry is removed.
 */
async function runScheduledReports(req: Request) {
  const denied = requireCronSecret(req)
  if (denied) return denied

  const supabase = createServerSupabaseClient()
  const now = new Date()

  const { data: schedules, error: schedulesError } = await supabase
    .from('report_schedules')
    .select('id, restaurant_id, email, format, enabled, send_time, timezone, created_at')
    .eq('enabled', true)

  if (schedulesError) {
    console.error('[REPORTS] Failed to load schedules:', schedulesError)
    return NextResponse.json({ error: schedulesError.message }, { status: 500 })
  }

  const rows = (schedules ?? []) as ScheduleRow[]
  const results: Array<Record<string, unknown>> = []
  let sent = 0
  let failed = 0
  let missedDetected = 0

  for (const schedule of rows) {
    // Successful periods already logged for this schedule. Keying the decision on these,
    // rather than on "last_sent_at older than 23h", is what lets a missed tick catch up
    // instead of silently dropping the day.
    const { data: logRows, error: logError } = await supabase
      .from('report_send_log')
      .select('report_period, status')
      .eq('schedule_id', schedule.id)
      .eq('status', 'success')
      .order('sent_at', { ascending: false })
      .limit(10)

    if (logError) {
      // Cannot establish what has already been sent -- skipping is the safe answer, because
      // guessing risks double-sending. Surfaced rather than swallowed.
      console.error(`[REPORTS] send-log read failed for ${schedule.id}:`, logError.message)
      results.push({ scheduleId: schedule.id, status: 'skipped', reason: 'send_log_unreadable' })
      continue
    }

    const sentPeriods = new Set((logRows ?? []).map((r) => String(r.report_period)))

    // Report a skipped day ONCE, before deciding today's send.
    //
    // detectMissedDay is a pure predicate over "is there a success row for yesterday", which
    // stays true forever once a day is genuinely missed. On a 2-minute trigger that means one
    // audit row every tick -- ~720/day for a single schedule. Observed in production
    // immediately after the 2026-08-05 deploy: 5 identical Riviera rows for period 2026-08-04
    // in 10 minutes. Alert noise on that scale buries the signal it exists to raise, so the
    // insert is guarded by an existence check on (schedule, period).
    const missed = detectMissedDay({ schedule, now, sentPeriods })
    if (missed.missed) {
      const { data: alreadyReported, error: dupError } = await supabase
        .from('audit_logs')
        .select('id')
        .eq('action', REPORT_DAY_MISSED_ACTION)
        .eq('entity_id', schedule.id)
        .contains('metadata', { report_period: missed.period })
        .limit(1)

      if (dupError) {
        // Cannot tell whether it was already reported. Skip rather than risk the spam this
        // guard exists to prevent -- a missed day stays detectable on the next tick.
        console.error(`[REPORTS] missed-day dedup check failed for ${schedule.id}:`, dupError.message)
      } else if ((alreadyReported ?? []).length === 0) {
        missedDetected++
        const { error: auditError } = await supabase.from('audit_logs').insert({
          restaurant_id: schedule.restaurant_id,
          action: REPORT_DAY_MISSED_ACTION,
          entity_type: 'report_schedule',
          entity_id: schedule.id,
          metadata: {
            severity: 'error',
            report_period: missed.period,
            email: schedule.email,
            send_time: schedule.send_time,
            timezone: schedule.timezone,
            note:
              'No successful send is recorded for this trading day and its send window has passed. ' +
              'A skipped day leaves no row at all, so absence is the only evidence -- this makes it visible.',
            requiresAttention: true,
          },
        })
        if (auditError) console.error('[REPORTS] missed-day audit insert failed:', auditError.message)
        results.push({ scheduleId: schedule.id, status: 'missed_day', period: missed.period })
      } else {
        results.push({ scheduleId: schedule.id, status: 'missed_day_already_reported', period: missed.period })
      }
    }

    const decision = decideDue({ schedule, now, sentPeriods })
    if (!decision.due) {
      results.push({
        scheduleId: schedule.id,
        status: 'not_due',
        reason: decision.reason,
        reportPeriod: decision.reportPeriod,
        dueAt: decision.dueAt,
      })
      continue
    }

    // The trading day that is CLOSING, in the restaurant's timezone -- not yesterday, and not
    // a UTC calendar date. getReportData resolves the day boundaries in the same zone.
    const reportPeriod = decision.reportPeriod
    const start = Date.now()

    try {
      const report = await getReportData({
        restaurantId: schedule.restaurant_id,
        startDate: reportPeriod,
        endDate: reportPeriod,
      })

      const isPdf = String(schedule.format) === 'pdf'
      const attachmentContent = isPdf
        ? Buffer.from(await (await generatePdfBlob(report)).arrayBuffer()).toString('base64')
        : Buffer.from(generateCsv(report)).toString('base64')

      const resend = getResend()
      await resend.emails.send({
        from: 'FlashTap Reports <noreply@flashtap.app>',
        to: [schedule.email],
        subject: buildDailyReportSubject(report, reportPeriod),
        html: buildDailyReportHtml(report, reportPeriod),
        attachments: [
          {
            filename: `flashtap-report-${reportPeriod}.${isPdf ? 'pdf' : 'csv'}`,
            content: attachmentContent,
            contentType: isPdf ? 'application/pdf' : 'text/csv',
          },
        ],
      })

      const duration = Date.now() - start

      // The insert result IS checked. Previously it was discarded on both paths, so a failed
      // log write left last_sent_at updated and the run looking clean -- the same silent-gap
      // shape as the auto-cancel cron.
      const { error: logInsertError } = await supabase.from('report_send_log').insert({
        schedule_id: schedule.id,
        restaurant_id: schedule.restaurant_id,
        report_period: reportPeriod,
        status: 'success',
        duration_ms: duration,
      })
      if (logInsertError) {
        console.error(`[REPORTS] send-log insert FAILED after a successful send for ${schedule.id}:`, logInsertError.message)
        await supabase.from('audit_logs').insert({
          restaurant_id: schedule.restaurant_id,
          action: REPORT_SEND_FAILED_ACTION,
          entity_type: 'report_schedule',
          entity_id: schedule.id,
          metadata: {
            severity: 'error',
            report_period: reportPeriod,
            email: schedule.email,
            emailDelivered: true,
            logWriteFailed: true,
            error: logInsertError.message,
            note:
              'The report WAS emailed but its send-log row could not be written. Without this ' +
              'audit row the day would look unsent and could be delivered twice.',
            requiresAttention: true,
          },
        })
      }

      await supabase
        .from('report_schedules')
        .update({ last_sent_at: now.toISOString() })
        .eq('id', schedule.id)

      sent++
      console.log(`[REPORTS] sent ${schedule.email} period=${reportPeriod} in ${duration}ms`)
      results.push({ scheduleId: schedule.id, status: 'success', reportPeriod, durationMs: duration })
    } catch (err: unknown) {
      const duration = Date.now() - start
      const message = err instanceof Error ? err.message : 'Unknown error'
      failed++
      console.error(`[REPORTS] FAILED ${schedule.id} period=${reportPeriod}:`, message)

      const { error: logInsertError } = await supabase.from('report_send_log').insert({
        schedule_id: schedule.id,
        restaurant_id: schedule.restaurant_id,
        report_period: reportPeriod,
        status: 'failed',
        error: message,
        duration_ms: duration,
      })
      if (logInsertError) {
        console.error('[REPORTS] send-log insert failed for a FAILED send:', logInsertError.message)
      }

      // Audit at error severity so computePlatformAlerts surfaces it, rather than leaving the
      // only trace in Worker logs nobody reads.
      const { error: auditError } = await supabase.from('audit_logs').insert({
        restaurant_id: schedule.restaurant_id,
        action: REPORT_SEND_FAILED_ACTION,
        entity_type: 'report_schedule',
        entity_id: schedule.id,
        metadata: {
          severity: 'error',
          report_period: reportPeriod,
          email: schedule.email,
          error: message,
          durationMs: duration,
          logWriteFailed: Boolean(logInsertError),
          requiresAttention: true,
        },
      })
      if (auditError) console.error('[REPORTS] failure audit insert failed:', auditError.message)

      results.push({ scheduleId: schedule.id, status: 'failed', reportPeriod, error: message })
    }
  }

  return NextResponse.json({
    success: true,
    schedules: rows.length,
    sent,
    failed,
    missedDetected,
    results,
  })
}

export async function POST(req: Request) {
  return runScheduledReports(req)
}

export async function GET(req: Request) {
  return runScheduledReports(req)
}
