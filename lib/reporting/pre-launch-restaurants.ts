/**
 * Restaurants that have not opened, whose figures must not be reported as trade.
 *
 * WHY THIS EXISTS. Riviera holds 15 orders totalling N$1595, all of them the owner's own testing —
 * N$1385 of it sits in `payment_status = 'paid'` and is therefore counted as revenue by
 * `app/api/orders/history/route.ts`, which sums on that column alone. The venue has not opened and
 * has no customers, so every figure it reports is a test.
 *
 * WHY THIS AND NOT A CLEANUP. Ruled 2026-08-21: the alternative was a script that cancels completed,
 * paid orders. No existing path can do that — `cancelByIds` re-asserts `payment_status = 'pending'`
 * and `isValidTransition` refuses to cancel a `completed` order — and those guards ARE the
 * append-only protection. Building a way to un-book completed paid sales is a capability worth more
 * as a thing that does not exist. **So this changes no financial record at all.** The orders stay
 * exactly as they are, including Riviera order 6 (N$20), which is a real card payment confirmed at
 * Finatic and must never be touched.
 *
 * IT IS DISPLAY-ONLY AND REVERSIBLE. Delete the entry and every figure returns, because nothing was
 * ever altered underneath it.
 *
 * WHAT THIS DOES NOT COVER, stated so a clean dashboard is not mistaken for a clean report:
 * analytics (`lib/supabase/analytics.ts`) and the generated CSV / PDF / emailed reports
 * (`lib/reports/*`) still include these orders. Each has its own `from('orders')` query and there is
 * no shared choke point. Suppressing figures inside a generated financial document is also a
 * different decision from hiding them on a dashboard, and was not ruled.
 *
 * There is NO cross-restaurant revenue aggregate on this platform — every reporting surface is
 * already scoped to one restaurant — so a pre-launch venue pollutes only its own numbers, never
 * anyone else's.
 */

export type PreLaunchRestaurant = {
  restaurantId: string
  name: string
  /** Why its figures are withheld, and what has to be true to remove the entry. */
  reason: string
}

export const PRE_LAUNCH_RESTAURANTS: readonly PreLaunchRestaurant[] = [
  // Riviera's entry was removed 2026-08-29: the venue is opening today, per the owner. All of its
  // pre-launch test orders (everything before 2026-08-29) were separately wiped by
  // scripts/wipe-riviera-pre-launch-orders-production.ts, so what's left to report from here is
  // real trade, not owner testing -- exactly the exit condition this list documents.
]

/** True when a restaurant's reported figures are test data rather than trade. */
export function isPreLaunchRestaurant(restaurantId: string | null | undefined): boolean {
  if (!restaurantId) return false
  const id = String(restaurantId).trim().toLowerCase()
  return PRE_LAUNCH_RESTAURANTS.some((r) => r.restaurantId.toLowerCase() === id)
}

/** The entry, for surfaces that want to explain WHY figures are withheld. */
export function preLaunchRestaurant(
  restaurantId: string | null | undefined,
): PreLaunchRestaurant | null {
  if (!restaurantId) return null
  const id = String(restaurantId).trim().toLowerCase()
  return PRE_LAUNCH_RESTAURANTS.find((r) => r.restaurantId.toLowerCase() === id) ?? null
}
