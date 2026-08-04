import { NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { requireCronSecret } from '@/lib/api/require-cron-secret'
import { autoCancelStalePosOrders } from '@/lib/orders/auto-cancel-stale-pos-orders'
import { expireHostedPendingOrders } from '@/lib/orders/expire-hosted-pending-orders'
import { reconcileOrphanPayments } from '@/lib/payments/reconcile-orphan-payments'
import { stagingFinaticQueryStub } from '@/lib/payments/staging-finatic-stub'

export const dynamic = 'force-dynamic'

/**
 * Cloudflare Cron Trigger target (workers/flashtap-worker.ts scheduled()).
 * Part 2: abandoned Sale-tab POS orders. Part 3: hosted pay-link expiry
 * (replaces the dead Vercel cron that used to hit /api/orders/expire-pending).
 * Also reconciles sale payment_events → unpaid orders and paid-without-receipt.
 */
async function runCleanup(req: Request) {
  const cronDenied = requireCronSecret(req)
  if (cronDenied) return cronDenied

  const supabase = createServerSupabaseClient()
  const isStagingEnv = String(process.env.ENVIRONMENT || '').trim().toLowerCase() === 'staging'
  const body = req.method === 'POST' ? await req.json().catch(() => null) : null
  const stagingStubMode =
    isStagingEnv && body && typeof body === 'object'
      ? (body as { __stagingFinaticStub?: unknown }).__stagingFinaticStub
      : undefined
  const stagingRestaurantIdRaw =
    isStagingEnv && body && typeof body === 'object'
      ? (body as { __stagingRestaurantId?: unknown }).__stagingRestaurantId
      : undefined
  const stagingSkipHosted =
    isStagingEnv && body && typeof body === 'object'
      ? Boolean((body as { __stagingSkipHosted?: unknown }).__stagingSkipHosted)
      : false
  const stagingSkipReconcile =
    isStagingEnv && body && typeof body === 'object'
      ? Boolean((body as { __stagingSkipReconcile?: unknown }).__stagingSkipReconcile)
      : false
  const stagingRestaurantId = String(stagingRestaurantIdRaw ?? '').trim() || undefined

  const pos = await autoCancelStalePosOrders(supabase, {
    verifyWithFinatic: true,
    restaurantId: stagingRestaurantId,
    queryFinaticOrderPaidFn: stagingFinaticQueryStub(stagingStubMode),
  })
  console.log('[CLEANUP-STALE-ORDERS] POS auto_timeout cancelled:', pos.cancelledCount)
  console.log('[CLEANUP-STALE-ORDERS] POS corrected to paid (Finatic-verified):', pos.correctedToPaidCount, pos.correctedToPaidIds)
  if (pos.skippedUncertainCount > 0) {
    console.warn('[CLEANUP-STALE-ORDERS] POS skipped (Finatic check inconclusive, retrying next run):', pos.skippedUncertainCount, pos.skippedUncertainIds)
  }
  if (pos.e04111Ids.length > 0) {
    console.warn('[CLEANUP-STALE-ORDERS] POS skipped with E04111 (gateway has no record yet):', pos.e04111Ids.length, pos.e04111Ids)
  }

  const hostedFallback = { expiredCount: 0, closedTabCount: 0 }
  let hosted: { expiredCount: number; closedTabCount: number } = hostedFallback
  try {
    if (!stagingSkipHosted) {
      hosted = await expireHostedPendingOrders(supabase)
      console.log(
        '[CLEANUP-STALE-ORDERS] Hosted timeout cancelled:',
        hosted.expiredCount,
        'tabs closed:',
        hosted.closedTabCount,
      )
    }
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

  let reconcile: Awaited<ReturnType<typeof reconcileOrphanPayments>> | null = null
  try {
    if (!stagingSkipReconcile) {
      reconcile = await reconcileOrphanPayments(supabase)
      console.log('[CLEANUP-STALE-ORDERS] Reconcile orphan payments:', reconcile)
      if (reconcile.recoveredAfterAutoCancel > 0) {
        console.error(
          '[CLEANUP-STALE-ORDERS] Payments recovered for AUTO-CANCELLED orders (needs reconciliation):',
          reconcile.recoveredAfterAutoCancel,
          reconcile.recoveredAfterAutoCancelIds,
        )
      }
    }
  } catch (error) {
    console.error('[CLEANUP-STALE-ORDERS] Reconcile failed:', error)
  }

  return NextResponse.json({
    success: true,
    posCancelled: pos.cancelledCount,
    posCancelledIds: pos.cancelledIds,
    posCorrectedToPaid: pos.correctedToPaidCount,
    posCorrectedToPaidIds: pos.correctedToPaidIds,
    posSkippedUncertain: pos.skippedUncertainCount,
    posSkippedUncertainIds: pos.skippedUncertainIds,
    hostedExpired: hosted.expiredCount,
    hostedClosedTabs: hosted.closedTabCount,
    reconcile,
  })
}

export async function POST(req: Request) {
  return runCleanup(req)
}

export async function GET(req: Request) {
  return runCleanup(req)
}
