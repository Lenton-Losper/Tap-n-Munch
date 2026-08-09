import { NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { requireCronSecret } from '@/lib/api/require-cron-secret'
import {
  reconcileSaleLedgerCoverage,
  SALE_LEDGER_COVERAGE_DEGRADED_ACTION,
  SALE_LEDGER_RECONCILIATION_HEARTBEAT_ACTION,
} from '@/lib/payments/reconcile-sale-ledger-coverage'

export const dynamic = 'force-dynamic'

/**
 * Minutes between reconciliation runs.
 *
 * The Cloudflare trigger fires every 2 minutes (one trigger drives all cron routes), so the
 * hourly cadence is enforced here rather than by a second trigger. 55 rather than 60 so the
 * run lands near the top of each hour instead of drifting later every cycle, and so a tick
 * that fails is retried 2 minutes later rather than lost for an hour.
 */
export const RECONCILE_INTERVAL_MINUTES = 55

/**
 * Hourly SALE ledger coverage reconciliation (#156).
 *
 * REPORTS ONLY. This route gates nothing: no deploy, no request, no settlement depends on its
 * result, and it answers 200 even when every venue is degraded. That is deliberate. It fires
 * on pre-existing history by construction -- 294 card payments already have no SALE row -- and
 * a check that fires on old data and blocks something gets switched off, which is how the
 * original defect survived five weeks.
 */
async function run(req: Request) {
  const cronDenied = requireCronSecret(req)
  if (cronDenied) return cronDenied

  const supabase = createServerSupabaseClient()
  const body = req.method === 'POST' ? await req.json().catch(() => null) : null
  const force = Boolean(body && typeof body === 'object' && (body as { force?: unknown }).force)
  const windowHours =
    body && typeof body === 'object' && Number((body as { windowHours?: unknown }).windowHours) > 0
      ? Number((body as { windowHours?: unknown }).windowHours)
      : 1

  // Self-gate on the last run's own heartbeat. Using the durable record rather than in-memory
  // state means a Worker isolate teardown cannot make the job run every 2 minutes, and a
  // missed run self-heals on the next tick instead of waiting a full hour.
  if (!force) {
    const since = new Date(Date.now() - RECONCILE_INTERVAL_MINUTES * 60 * 1000).toISOString()
    const { data: recent, error: recentError } = await supabase
      .from('audit_logs')
      .select('id, created_at')
      .in('action', [
        SALE_LEDGER_RECONCILIATION_HEARTBEAT_ACTION,
        SALE_LEDGER_COVERAGE_DEGRADED_ACTION,
      ])
      .gte('created_at', since)
      .limit(1)

    // An unreadable gate must not silently suppress the check -- that would be a monitoring
    // job disabled by a transport error, with nothing to show it had stopped. Run instead.
    if (recentError) {
      console.warn(
        '[CRON reconcile-sale-ledger] could not read the last-run heartbeat; running anyway',
        recentError.message,
      )
    } else if ((recent?.length ?? 0) > 0) {
      return NextResponse.json({
        success: true,
        skipped: 'not_due',
        nextDueAfter: recent![0].created_at,
      })
    }
  }

  const result = await reconcileSaleLedgerCoverage(supabase, { windowHours })

  if (!result.ok) {
    console.error('[CRON reconcile-sale-ledger] run failed:', result.error)
    // 200, not 500. This route reports; a failed reconciliation is not a failed request, and
    // answering 500 would put a red line in the cron log for a check that gates nothing.
    // The failure is already recorded loudly by reconcileSaleLedgerCoverage itself.
    return NextResponse.json({ success: false, error: result.error }, { status: 200 })
  }

  const report = result.report!
  const degraded = report.venues.filter((v) => v.degraded)

  console.log(
    `[CRON reconcile-sale-ledger] ${report.totals.paidCount} card payments in ${report.windowHours}h, ` +
      `${report.totals.missingCount} without a SALE row, ${degraded.length} venue(s) degraded`,
  )
  for (const venue of degraded) {
    console.error(
      `[CRON reconcile-sale-ledger] DEGRADED ${venue.restaurantName ?? venue.restaurantId}: ` +
        `${venue.missingCount}/${venue.paidCount} missing — ${venue.trigger}`,
    )
  }

  return NextResponse.json({
    success: true,
    windowHours: report.windowHours,
    windowStart: report.windowStart,
    windowEnd: report.windowEnd,
    totals: report.totals,
    venues: report.venues.map((v) => ({
      restaurant_id: v.restaurantId,
      name: v.restaurantName,
      paid: v.paidCount,
      missing: v.missingCount,
      missing_ratio: Number(v.missingRatio.toFixed(4)),
      previous_missing_ratio:
        v.previousMissingRatio === null ? null : Number(v.previousMissingRatio.toFixed(4)),
      degraded: v.degraded,
      trigger: v.trigger,
    })),
  })
}

export async function POST(req: Request) {
  return run(req)
}

export async function GET(req: Request) {
  return run(req)
}
