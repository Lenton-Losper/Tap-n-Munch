import { NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { requireCronSecret } from '@/lib/api/require-cron-secret'
import { autoCancelStalePosOrders } from '@/lib/orders/auto-cancel-stale-pos-orders'

export const dynamic = 'force-dynamic'

/**
 * Cloudflare Cron Trigger target (and manual ops). Part 2: auto-cancel abandoned Sale-tab
 * POS orders. Part 3 extends this same route for hosted-order expiry.
 */
async function runCleanup(req: Request) {
  const cronDenied = requireCronSecret(req)
  if (cronDenied) return cronDenied

  const supabase = createServerSupabaseClient()

  const pos = await autoCancelStalePosOrders(supabase)
  console.log('[CLEANUP-STALE-ORDERS] POS auto_timeout cancelled:', pos.cancelledCount)

  return NextResponse.json({
    success: true,
    posCancelled: pos.cancelledCount,
    posCancelledIds: pos.cancelledIds,
  })
}

export async function POST(req: Request) {
  return runCleanup(req)
}

export async function GET(req: Request) {
  return runCleanup(req)
}
