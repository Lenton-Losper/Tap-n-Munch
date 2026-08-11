import { NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { requireCronSecret } from '@/lib/api/require-cron-secret'
import { reportNegativeStockBalances } from '@/lib/stock/report-negative-balances'

export const dynamic = 'force-dynamic'

/**
 * #146 — scheduled detection of impossible stock balances.
 *
 * Cloudflare Cron Trigger target (workers/flashtap-worker.ts scheduled()), driven off the same
 * every-2-minutes trigger as the other cron routes.
 *
 * READ ONLY. This route issues nothing but selects. It cannot cancel an order, refuse a sale or
 * alter a balance; the worst it can do is log. That is deliberate -- #146 recommendation 1 is
 * "surface first, block second", because a hard guard on a DERIVED balance means a legitimate
 * sale fails at the till over an ingredient someone mis-counted last week.
 */

// The trigger fires every 2 minutes, but a full ledger scan does not need that and a negative
// balance that has sat for three weeks is not made worse by up to an hour. Firing only in the
// first tick of each hour keeps it to ~1 scan/hour with no state to store and no extra trigger
// to configure. `force` exists so the route can be exercised on demand without waiting.
function shouldScanNow(now: Date, force: boolean): boolean {
  return force || now.getUTCMinutes() < 2
}

async function runScan(req: Request) {
  const cronDenied = requireCronSecret(req)
  if (cronDenied) return cronDenied

  const force = new URL(req.url).searchParams.get('force') === '1'
  if (!shouldScanNow(new Date(), force)) {
    return NextResponse.json({ success: true, skipped: 'not the top of the hour' })
  }

  try {
    const report = await reportNegativeStockBalances(createServerSupabaseClient())

    if (report.negativeCount === 0) {
      console.log('[NEGATIVE-STOCK] none;', report.scanned, 'movements scanned')
      return NextResponse.json({ success: true, ...report })
    }

    // console.error, not warn: a negative balance is not a low balance, it is a number that
    // cannot be true, and something upstream produced it. Every line names the restaurant so
    // the report is actionable without a second lookup.
    for (const restaurant of report.byRestaurant) {
      for (const row of restaurant.rows) {
        console.error(
          `[NEGATIVE-STOCK] restaurant=${restaurant.restaurantId} item=${row.name} ` +
            `balance=${row.balance} movements=${row.movementCount} ` +
            `par_level=${row.parLevel ?? 'null'} stock_item_id=${row.stockItemId}`,
        )
      }
    }
    console.error(
      `[NEGATIVE-STOCK] ${report.negativeCount} impossible balance(s) across ` +
        `${report.byRestaurant.length} restaurant(s); ${report.scanned} movements scanned`,
    )

    return NextResponse.json({ success: true, ...report })
  } catch (error) {
    // Detection failing must not take the cron tick down with it -- the other routes settle
    // independently, and this one has nothing to roll back.
    console.error('[NEGATIVE-STOCK] scan failed:', error)
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    )
  }
}

export async function POST(req: Request) {
  return runScan(req)
}

export async function GET(req: Request) {
  return runScan(req)
}
