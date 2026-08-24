import { NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { requireCronSecret } from '@/lib/api/require-cron-secret'
import {
  reapAbandonedTabs,
  ABANDONED_TAB_INACTIVE_HOURS,
} from '@/lib/tabs/reap-abandoned-tabs'

export const dynamic = 'force-dynamic'

/**
 * #333 — close abandoned tabs so their tables become usable again.
 *
 * Cloudflare Cron Trigger target (workers/flashtap-worker.ts scheduled()), driven off the same
 * every-2-minutes trigger as the other cron routes.
 *
 * A tab abandoned four hours ago is not made worse by another twenty minutes, and a table that has
 * been held overnight is not urgent either — so this self-limits to the first tick of each hour,
 * the same way negative-stock-balances (#146) does, with no state to store and no extra trigger to
 * configure. `force=1` exists so it can be exercised on demand.
 *
 * THIS ROUTE DECIDES NOTHING. `reap_abandoned_tab` re-derives inactivity and refuses any tab that
 * owes money or has a request awaiting review, writing an audit row either way. That is where the
 * guard belongs: `settled_type` means a human closed the table, so a cron that settled an unpaid
 * tab would be recording a payment nobody took.
 */
function shouldRunNow(now: Date, force: boolean): boolean {
  return force || now.getUTCMinutes() < 2
}

async function run(req: Request) {
  const cronDenied = requireCronSecret(req)
  if (cronDenied) return cronDenied

  const force = new URL(req.url).searchParams.get('force') === '1'
  if (!shouldRunNow(new Date(), force)) {
    return NextResponse.json({ success: true, skipped: 'not the top of the hour' })
  }

  try {
    const result = await reapAbandonedTabs(createServerSupabaseClient(), ABANDONED_TAB_INACTIVE_HOURS)

    if (result.reaped > 0) {
      console.log(
        `[REAP-TABS] closed ${result.reaped} abandoned tab(s) after ` +
          `${ABANDONED_TAB_INACTIVE_HOURS}h idle:`,
        result.reapedTabIds,
      )
    }

    // console.error, not log: a tab idle for hours while still owing money is a table nobody has
    // settled and nobody is looking at. Every one names its tab so it is actionable without a
    // second lookup, and audit_logs carries the same record for anyone reading later.
    if (result.leftForStaff > 0) {
      console.error(
        `[REAP-TABS] ${result.leftForStaff} abandoned tab(s) left open because money or a review ` +
          'is outstanding — these need a person:',
        result.leftForStaffTabIds,
      )
    }

    if (result.errors > 0) {
      console.error(`[REAP-TABS] ${result.errors} tab(s) errored; see the lines above`)
    }

    // Silence is not success. Saying what was skipped is the difference between "nothing to do"
    // and "the batch cap hid the rest".
    if (result.truncated) {
      console.warn(
        `[REAP-TABS] candidate list hit the batch cap (${result.candidates}); more remain for the next tick`,
      )
    }

    return NextResponse.json({ success: true, inactiveHours: ABANDONED_TAB_INACTIVE_HOURS, ...result })
  } catch (error) {
    console.error('[REAP-TABS] failed:', error)
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'unknown' },
      { status: 500 },
    )
  }
}

export async function POST(req: Request) {
  return run(req)
}

export async function GET(req: Request) {
  return run(req)
}
