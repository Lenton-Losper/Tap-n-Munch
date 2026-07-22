import { NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { requireCronSecret } from '@/lib/api/require-cron-secret'
import { autoCancelStalePosOrders } from '@/lib/orders/auto-cancel-stale-pos-orders'
import { expireHostedPendingOrders } from '@/lib/orders/expire-hosted-pending-orders'

export const dynamic = 'force-dynamic'

/**
 * Cloudflare Cron Trigger target (workers/flashtap-worker.ts scheduled()).
 * Part 2: abandoned Sale-tab POS orders. Part 3: hosted pay-link expiry
 * (replaces the dead Vercel cron that used to hit /api/orders/expire-pending).
 */
async function runCleanup(req: Request) {
  const cronDenied = requireCronSecret(req)
  if (cronDenied) return cronDenied

  const supabase = createServerSupabaseClient()

  const pos = await autoCancelStalePosOrders(supabase)
  console.log('[CLEANUP-STALE-ORDERS] POS auto_timeout cancelled:', pos.cancelledCount)

  let hosted: { expiredCount: number; closedTabCount: number }
  try {
    hosted = await expireHostedPendingOrders(supabase)
    console.log(
      '[CLEANUP-STALE-ORDERS] Hosted timeout cancelled:',
      hosted.expiredCount,
      'tabs closed:',
      hosted.closedTabCount,
    )
  } catch (error) {
    console.error('[CLEANUP-STALE-ORDERS] Hosted expire failed:', error)
    return NextResponse.json(
      {
        success: false,
        posCancelled: pos.cancelledCount,
        error: error instanceof Error ? error.message : String(error),
      },
      { status: 500 },
    )
  }

  return NextResponse.json({
    success: true,
    posCancelled: pos.cancelledCount,
    posCancelledIds: pos.cancelledIds,
    hostedExpired: hosted.expiredCount,
    hostedClosedTabs: hosted.closedTabCount,
  })
}

export async function POST(req: Request) {
  return runCleanup(req)
}

export async function GET(req: Request) {
  return runCleanup(req)
}
