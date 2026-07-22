import { NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { requireCronSecret } from '@/lib/api/require-cron-secret'
import { expireHostedPendingOrders } from '@/lib/orders/expire-hosted-pending-orders'

export const dynamic = 'force-dynamic'

/**
 * Legacy HTTP entry for hosted-order expiry. Prefer /api/cron/cleanup-stale-orders
 * (Cloudflare Cron Trigger). Kept so existing callers/secrets keep working.
 */
async function runExpire(req: Request) {
  const cronDenied = requireCronSecret(req)
  if (cronDenied) return cronDenied

  try {
    const supabase = createServerSupabaseClient()
    const result = await expireHostedPendingOrders(supabase)
    console.log('[EXPIRE-PENDING] Cancelled', result.expiredCount, 'abandoned orders')
    return NextResponse.json({
      success: true,
      expired: result.expiredCount,
      closedTabs: result.closedTabCount,
    })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    console.error('[EXPIRE-PENDING] Error:', error)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

export async function POST(req: Request) {
  return runExpire(req)
}

export async function GET(req: Request) {
  return runExpire(req)
}
