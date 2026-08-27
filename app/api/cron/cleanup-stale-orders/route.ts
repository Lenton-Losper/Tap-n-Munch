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
  if (pos.deferredRecentlyProbedIds.length > 0) {
    // Not a skip: these were not asked about at all this run, because Finatic was already asked
    // within SKIP_REPROBE_INTERVAL_MS. Logged separately so a quiet run is distinguishable from a
    // run that probed and learned nothing.
    console.log(
      '[CLEANUP-STALE-ORDERS] POS deferred (probed within the rest interval):',
      pos.deferredRecentlyProbedIds.length,
    )
  }
  if (pos.e04111Ids.length > 0) {
    console.warn('[CLEANUP-STALE-ORDERS] POS skipped with E04111 (gateway has no record yet):', pos.e04111Ids.length, pos.e04111Ids)
  }
  /**
   * #153. Reported SEPARATELY from the skip count above, which is the point of the change: an
   * order held here is one that will NOT be retried, and folding it into "retrying next run"
   * would restore the exact ambiguity the issue is about. console.error rather than warn -- these
   * need a human, and the issue's closing observation is that ninety-two identical log lines are
   * not an alert.
   */
  if (pos.heldVerificationUnavailableCount > 0) {
    console.error(
      '[CLEANUP-STALE-ORDERS] POS held, UNVERIFIABLE (restaurant has no Finatic credentials -- needs manual resolution, NOT cancelled):',
      pos.heldVerificationUnavailableCount,
      pos.heldVerificationUnavailableIds,
    )
  }
  if (pos.releasedVerificationUnavailableCount > 0) {
    console.log(
      '[CLEANUP-STALE-ORDERS] POS released from unverifiable hold (credentials now configured, verification resumed):',
      pos.releasedVerificationUnavailableCount,
      pos.releasedVerificationUnavailableIds,
    )
  }
  if (pos.surfacedNeedsHumanCount > 0) {
    // #353. Stale pending orders on a channel this sweep does not act on. NOTHING WAS WRITTEN
    // for these -- they are logged here so the number exists somewhere other than the staff
    // screen, and console.error rather than console.warn because "13 orders nobody is looking
    // for" is the condition this whole change exists to stop being silent about.
    console.error(
      '[CLEANUP-STALE-ORDERS] Non-POS stale pending orders SURFACED, not actioned (see the Held for review panel):',
      pos.surfacedNeedsHumanCount,
      pos.surfacedNeedsHuman,
    )
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
      // #223. A payment_events row whose amount did not agree with its named orders' total.
      // Nothing was applied; both figures are on each order's audit_logs row.
      if (reconcile.amountMismatchCount > 0) {
        console.error(
          '[CLEANUP-STALE-ORDERS] Orphan payment amount mismatch, left for review:',
          reconcile.amountMismatchCount,
          reconcile.amountMismatchIds,
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
    posDeferredRecentlyProbed: pos.deferredRecentlyProbedIds.length,
    posSkippedUncertainIds: pos.skippedUncertainIds,
    // #153. The terminus of the retry loop, and its exit. Named in the response so a run can be
    // audited from one curl instead of from worker logs nobody reads.
    posHeldVerificationUnavailable: pos.heldVerificationUnavailableCount,
    posHeldVerificationUnavailableIds: pos.heldVerificationUnavailableIds,
    posReleasedVerificationUnavailable: pos.releasedVerificationUnavailableCount,
    posReleasedVerificationUnavailableIds: pos.releasedVerificationUnavailableIds,
    // #353 -- non-POS stale pending orders the sweep can now SEE and deliberately does not touch.
    // Deliberately NOT prefixed `pos`, unlike every key above it: these are the orders that are
    // not POS, and naming them posSurfaced... would say the opposite of what the field means.
    surfacedNeedsHuman: pos.surfacedNeedsHumanCount,
    surfacedNeedsHumanIds: pos.surfacedNeedsHumanIds,
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
