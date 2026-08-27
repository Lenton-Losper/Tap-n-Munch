import type { SupabaseClient } from '@supabase/supabase-js'
import {
  releaseStrandedClaim,
  RELEASED_TO_STATUS,
  STRANDED_CLAIM_STATUS,
} from './release-stranded-claim'

/**
 * #215 — SWEEP `order_requests` ROWS STRANDED IN THE TRANSIENT `accepting` CLAIM.
 *
 * The accept route claims a row into `accepting` before it calls createOrder(), and nothing on
 * that path is transactional. If the release UPDATE fails, or the worker dies between the claim
 * and either exit, the row stays claimed and every direction out is closed at once: the staff list
 * selects only `waiting_review` and actively evicts anything else, accept/decline/review all
 * answer 409, and the customer holding the order id is shown "Waiting for Review" indefinitely.
 * Since #120 it is worse than invisible — `accepting` is in LIVE_REQUEST_STATUSES, so the row
 * BLOCKS settle and close and the table cannot be cleared.
 *
 * WHY IT RELEASES BACKWARDS. `waiting_review`, never `accepted`. A dead worker proves nothing
 * about whether the round was wanted, and `accepted` is not even expressible: the
 * order_requests_accepted_has_order CHECK requires accepted_order_id, which is precisely the
 * information the crash destroyed. Going backwards is provably safe on the other side —
 * createOrder is idempotent on a stable key (`order-request-accept:${requestId}` when the customer
 * supplied none), `orders.idempotency_key` carries a unique partial index, and create-order.ts
 * catches 23505 and re-selects. So if the worker died AFTER creating the order, releasing and
 * letting staff Accept again returns the SAME orderId. No duplicate order, no double charge.
 *
 * That direction is not restated here. `RELEASED_TO_STATUS` is imported from the module both staff
 * release surfaces already use, so the cron cannot drift away from what the button does — the same
 * argument that put the rule in one place for #120.
 *
 * WHAT THIS MODULE DECIDES: nothing. It supplies candidate ids and a cutoff. `releaseStrandedClaim`
 * re-applies both the status and the age as predicates on the UPDATE itself, so an accept still in
 * flight cannot have its claim taken away by a sweeper that selected the row a moment earlier, and
 * a selection bug here cannot turn into a released live claim.
 */

/**
 * How old a claim must be before a sweeper may release it.
 *
 * The legitimate window is ONE createOrder() call wide — a handful of seconds, bounded well below
 * this by the worker's own request limits. Fifteen minutes is not a guess at how long an accept
 * takes; it is far enough beyond any of them that the only rows it can reach are ones no process is
 * still working on, while still clearing a blocked till inside a service.
 */
export const STRANDED_CLAIM_STALE_MINUTES = 15

/** Bounded per tick. A backlog drains over successive runs rather than one long loop. */
export const REAP_CLAIMS_BATCH_LIMIT = 200

/** The audit `reason` written when the sweeper, rather than a person, releases a claim. */
export const REAP_RELEASE_REASON =
  'cron released a claim stranded in accepting (#215): no worker can still be holding it'

export type ReapStrandedClaimsResult = {
  candidates: number
  released: number
  releasedRequestIds: string[]
  /** Resolved by something else between the candidate query and the write. Not a problem. */
  raced: number
  errors: number
  /** True when the candidate list hit the batch cap, so more remain for the next tick. */
  truncated: boolean
  staleMinutes: number
}

export async function reapStrandedClaims(
  supabase: SupabaseClient,
  staleMinutes: number = STRANDED_CLAIM_STALE_MINUTES,
): Promise<ReapStrandedClaimsResult> {
  if (!Number.isFinite(staleMinutes) || staleMinutes < 1) {
    // A caller asking for 0 would be asking to release live claims. Refuse rather than clamp:
    // a clamped threshold is a silently different threshold.
    throw new Error(`reapStrandedClaims: staleMinutes must be at least 1 (got ${staleMinutes})`)
  }

  const result: ReapStrandedClaimsResult = {
    candidates: 0,
    released: 0,
    releasedRequestIds: [],
    raced: 0,
    errors: 0,
    truncated: false,
    staleMinutes,
  }

  const staleBefore = new Date(Date.now() - staleMinutes * 60 * 1000).toISOString()

  /**
   * `claimed_at` is NULL for no row this can ever meet: the trigger added by #215's migration
   * stamps it on entry into `accepting` regardless of what the writer sent, and the same migration
   * backfilled the rows that predate it. `.lt` excludes NULL anyway — an unknown age must never be
   * treated as an old one — so the invariant failing degrades to "not reaped", not to "reaped
   * wrongly".
   */
  const { data, error } = await supabase
    .from('order_requests')
    .select('id, restaurant_id, tab_id, table_id, claimed_at, placed_at')
    .eq('status', STRANDED_CLAIM_STATUS)
    .lt('claimed_at', staleBefore)
    .order('claimed_at', { ascending: true })
    .limit(REAP_CLAIMS_BATCH_LIMIT)

  if (error) throw new Error(`reapStrandedClaims: candidate query failed: ${error.message}`)

  const candidates = (data ?? []) as Array<{ id: string; restaurant_id: string; claimed_at: string | null }>
  result.candidates = candidates.length
  result.truncated = candidates.length === REAP_CLAIMS_BATCH_LIMIT

  for (const candidate of candidates) {
    const requestId = String(candidate.id)
    try {
      const outcome = await releaseStrandedClaim(supabase, requestId, {
        restaurantId: String(candidate.restaurant_id),
        staleBefore,
        reason: REAP_RELEASE_REASON,
        actor: {
          surface: 'cron',
          source: 'reap_stranded_claims_cron',
          staleMinutesThreshold: staleMinutes,
          claimedAt: candidate.claimed_at ?? null,
        },
      })

      if (outcome.ok) {
        result.released++
        result.releasedRequestIds.push(requestId)
        continue
      }

      // ALREADY_RESOLVED / NOT_A_STRANDED_CLAIM / CLAIM_NOT_STALE all mean the same thing here:
      // the row moved on between the candidate query and the write, which is the conditional
      // update doing its job. Only a genuine failure counts as an error.
      if (
        outcome.code === 'ALREADY_RESOLVED' ||
        outcome.code === 'NOT_A_STRANDED_CLAIM' ||
        outcome.code === 'CLAIM_NOT_STALE'
      ) {
        result.raced++
        continue
      }

      result.errors++
      console.error('[REAP-CLAIMS] could not release request', requestId, outcome.error)
    } catch (err) {
      // One request failing must not stop the rest; a stuck row would otherwise block every later
      // one on every future tick.
      result.errors++
      console.error('[REAP-CLAIMS] failed for request', requestId, err)
    }
  }

  return result
}

/** Re-exported so a reader of the cron route can see where a released claim lands without a second hop. */
export { RELEASED_TO_STATUS }
