import { NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { requireCronSecret } from '@/lib/api/require-cron-secret'
import {
  reapStrandedClaims,
  STRANDED_CLAIM_STALE_MINUTES,
} from '@/lib/order-requests/reap-stranded-claims'

export const dynamic = 'force-dynamic'

/**
 * #215 — release `order_requests` rows stranded in the transient `accepting` claim.
 *
 * Cloudflare Cron Trigger target (workers/flashtap-worker.ts scheduled()), on the same
 * every-2-minutes trigger as the other cron routes.
 *
 * IT DOES NOT SELF-LIMIT TO THE TOP OF THE HOUR, and that is the one way it differs from
 * reap-abandoned-tabs (#333) and negative-stock-balances (#146). Those defer because an abandoned
 * table is not made worse by another twenty minutes. This one is: since #120 a stranded claim sits
 * in LIVE_REQUEST_STATUSES and BLOCKS settle and close, so the wait is a till a venue cannot use
 * and a customer who cannot pay. Every tick, and the threshold does the waiting instead.
 *
 * THIS ROUTE DECIDES NOTHING. `releaseStrandedClaim` re-applies both predicates — status is still
 * `accepting`, and the claim is older than the cutoff — to the UPDATE itself, so an accept still in
 * flight cannot lose its claim to a sweeper that read the row a moment earlier.
 */
async function run(req: Request) {
  const cronDenied = requireCronSecret(req)
  if (cronDenied) return cronDenied

  try {
    const result = await reapStrandedClaims(createServerSupabaseClient(), STRANDED_CLAIM_STALE_MINUTES)

    // console.error, not log. A released claim is not routine housekeeping: it means an accept
    // died mid-flight, a bill was held open until this ran, and a customer was being shown
    // "Waiting for Review" the whole time. Each one names its request so it is actionable without
    // a second lookup, and audit_logs carries the same record for anyone reading later.
    if (result.released > 0) {
      console.error(
        `[REAP-CLAIMS] released ${result.released} claim(s) stranded in accepting for over ` +
          `${STRANDED_CLAIM_STALE_MINUTES}m — an accept died mid-flight:`,
        result.releasedRequestIds,
      )
    }

    if (result.errors > 0) {
      console.error(`[REAP-CLAIMS] ${result.errors} request(s) errored; see the lines above`)
    }

    // Silence is not success. Saying what was skipped is the difference between "nothing to do"
    // and "the batch cap hid the rest".
    if (result.truncated) {
      console.warn(
        `[REAP-CLAIMS] candidate list hit the batch cap (${result.candidates}); more remain for the next tick`,
      )
    }

    return NextResponse.json({ success: true, ...result })
  } catch (error) {
    console.error('[REAP-CLAIMS] failed:', error)
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
