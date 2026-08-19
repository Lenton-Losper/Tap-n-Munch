/**
 * WHICH RESTAURANT DOES A MULTI-RESTAURANT SESSION BOOTSTRAP AGAINST?
 *
 * Until 2026-08-19 the answer was `getRestaurantIdsForUser()[0]` -- "owner rows first, otherwise
 * insertion order" -- and app/api/auth/role/route.ts said so in its own comment: "There's no
 * 'active restaurant' selector yet". That was harmless while every account belonged to exactly one
 * restaurant. The day an organisation gained a second location it stopped being harmless twice
 * over:
 *
 *   - the owner-first tie-break does not disambiguate when BOTH rows are `owner`, so the site the
 *     app opens on falls back to unordered query output
 *   - there was no way whatsoever to reach the other one. A picker exists (app/choose-context) and
 *     writes `user_active_context`, but NOTHING read that table when deciding the session's
 *     restaurant, so choosing changed only where login landed you, never which restaurant you saw.
 *
 * THE STORED CHOICE IS A PREFERENCE, NOT A PERMISSION. It is honoured only when it names a
 * restaurant the user CURRENTLY belongs to, re-derived from restaurant_users on every call. A row
 * in user_active_context must never be able to grant access on its own: memberships get revoked,
 * and a stale row naming a restaurant the user has been removed from would otherwise keep working.
 * That is the whole reason this is a pure function -- the control is testable without a database.
 *
 * `memberRestaurantIds` is the authority. If the stored id is not in it, the stored value is
 * discarded and the previous behaviour applies unchanged.
 */

export type SessionRestaurantChoice = {
  restaurantId: string | null
  /** Why this one -- for logging and for tests that need to distinguish the paths. */
  source: 'stored-context' | 'first-membership' | 'none'
}

export function pickSessionRestaurant(params: {
  /** Every restaurant the user currently belongs to, owner rows first. The authority. */
  memberRestaurantIds: string[]
  /** user_active_context.restaurant_id, or null when there is no row / the context is platform. */
  storedRestaurantId: string | null | undefined
}): SessionRestaurantChoice {
  const members = params.memberRestaurantIds.filter(Boolean).map(String)
  const stored = params.storedRestaurantId ? String(params.storedRestaurantId) : null

  // Re-validated against CURRENT access on every call, never trusted on its own.
  if (stored && members.includes(stored)) {
    return { restaurantId: stored, source: 'stored-context' }
  }

  if (members.length > 0) {
    return { restaurantId: members[0], source: 'first-membership' }
  }

  return { restaurantId: null, source: 'none' }
}
