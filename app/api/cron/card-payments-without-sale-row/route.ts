import { NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { requireCronSecret } from '@/lib/api/require-cron-secret'
import {
  reportCardPaymentsWithoutSaleRow,
  SALE_ROW_GRACE_MINUTES,
} from '@/lib/payments/report-card-payments-without-sale-row'

export const dynamic = 'force-dynamic'

/**
 * #156 — scheduled detection of card payments that never reached the ledger.
 *
 * THE INCIDENT THIS EXISTS FOR. `payment_events` stopped receiving SALE rows on 2026-07-28. By the
 * time anyone looked, 1018 of August's 1021 card payments had none — 99.7% — and the
 * duplicate-charge detector, which reads that table, had been reporting "zero duplicates" off an
 * empty ledger for a month. Nobody was lying to anyone; the instrument was measuring its own
 * absence.
 *
 * WHY THIS ASKS FROM THE SERVER SIDE. The device already knew. `recordSaleEvent` catches its own
 * failure and writes a `console.error` — on a terminal, in a restaurant. vc99 added a wiretap
 * event, and that is still not enough: it writes to the device's native module, there is no
 * wiretap table, and the thing being watched IS the device's ability to reach us. A reporter that
 * shares a failure mode with the thing it reports on is not a reporter.
 *
 * The server, by contrast, always knows it marked an order paid by card. This asks the only
 * question that is always answerable: did the row that should have followed actually arrive.
 *
 * READ ONLY, deliberately. It cannot write a ledger row, cancel an order or alter a payment. A
 * missing SALE row is a bookkeeping fact, and fabricating one would destroy the signal that says
 * the writer is broken — the same reasoning as the negative-stock report next door.
 *
 * Cloudflare Cron Trigger target via workers/flashtap-worker.ts scheduled().
 */

/**
 * Hourly, not every two minutes. A ledger that stopped an hour ago is not made worse by being
 * found on the hour, and the trigger fires every 2 minutes for other routes. Firing in the first
 * tick of each hour keeps this to ~1 scan/hour with no state to store. `force=1` exercises it on
 * demand.
 */
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
    const report = await reportCardPaymentsWithoutSaleRow(createServerSupabaseClient())

    if (report.scanned === 0) {
      // NOT an all-clear. No card payments in the window means nothing was testable -- saying
      // "none missing" here would report the absence of trade as the presence of a working ledger,
      // which is the exact shape of the defect this route exists to catch.
      console.log('[SALE-ROW-GAP] no card payments in the window; nothing to check')
      return NextResponse.json({ success: true, ...report, note: 'no card payments in window' })
    }

    if (report.missing === 0) {
      console.log(`[SALE-ROW-GAP] ok; ${report.scanned} card payment(s), all have a sale row`)
      return NextResponse.json({ success: true, ...report })
    }

    /**
     * console.error, not warn. A missing SALE row is not a slow row: the grace period has already
     * passed, so the write is not late, it did not happen. And the ratio matters more than the
     * count -- 3 of 4 missing is a broken writer, 3 of 400 is three incidents.
     */
    console.error(
      `[SALE-ROW-GAP] ${report.missing} of ${report.scanned} card payment(s) have NO ledger row ` +
        `(${Math.round(report.missingRatio * 100)}%), older than ${SALE_ROW_GRACE_MINUTES} minutes. ` +
        `The duplicate-charge detector reads this table, so its result is unreliable while this is non-zero.`,
      report.worst,
    )
    return NextResponse.json({ success: true, ...report })
  } catch (error) {
    console.error('[SALE-ROW-GAP] scan failed', error)
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'scan failed' },
      { status: 500 },
    )
  }
}

export async function GET(req: Request) {
  return runScan(req)
}

export async function POST(req: Request) {
  return runScan(req)
}
