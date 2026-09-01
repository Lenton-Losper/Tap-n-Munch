/**
 * What "Kitchen / Bar / Both" actually means, in one place.
 *
 * ============================================================================================
 * WHY THIS FILE EXISTS
 * ============================================================================================
 *
 * `both` is the only routing value whose consequence is not guessable from its name, and the
 * consequence is operational: a line routed `both` is NOT Ready until the kitchen AND the bar
 * have each bumped their own half. `isLineReady` requires every owning station, by design
 * (lib/orders/order-lines.ts) — one station finishing cannot release the plate.
 *
 * A manager reading the bare word "Both" in a dropdown reasonably concludes it means "show it on
 * both screens" or "either station can make it". Both readings are wrong, and the second is the
 * exact inversion: `both` is the value that makes a station's bump *insufficient*, not sufficient.
 *
 * That misreading has already cost a live service. 2026-09-01, Digi Cofee: 4x Coffee sat in
 * "Being made" on the P5 while the bar board showed it done, because Drinks was routed `both` and
 * the kitchen had never touched it. Nothing was stale and nothing was broken — the configuration
 * said exactly what it was asked to say.
 *
 * Measured on production the same day, read-only: 72 live menu items across 7 categories at two
 * venues (Mingle Brew & Pour, FNB ChowNow) still route `both`. 46 of them are orderable. Every
 * one reproduces that incident on its next order.
 *
 * ============================================================================================
 * WHY A WRITE-TIME ACKNOWLEDGEMENT, NOT A MIGRATION
 * ============================================================================================
 *
 * `both` is legitimate — a sharing platter really is made in two places, and a venue that means
 * it must keep it. So this does not remove the option, does not migrate a single existing row,
 * and does not touch a read path. It makes the choice *explicit at the moment it is made*: the
 * consequence is stated next to the option, and setting `both` requires an acknowledgement the
 * caller has to send on purpose.
 *
 * Existing `both` categories keep working untouched. Editing such a category's NAME does not
 * re-assert its routing and therefore needs no acknowledgement — only a write that actually sets
 * route_to to `both` does. That is what keeps the guard from breaking the two venues above while
 * they decide what they meant.
 */

export type CategoryRoute = 'kitchen' | 'bar' | 'both'

export const CATEGORY_ROUTES: readonly CategoryRoute[] = ['kitchen', 'bar', 'both']

/** Matches the DB CHECK on menu_categories.route_to (20260624120000). */
export function isCategoryRoute(value: unknown): value is CategoryRoute {
  return typeof value === 'string' && (CATEGORY_ROUTES as readonly string[]).includes(value)
}

export type CategoryRouteOption = {
  value: CategoryRoute
  /** What the merchant picks. */
  label: string
  /** Who makes it. */
  meaning: string
  /** What it does to the waiter's Ready signal — the part `both` hides. */
  consequence: string
  /** True only for the value whose consequence is not guessable from its name. */
  requiresAcknowledgement: boolean
}

export const CATEGORY_ROUTE_OPTIONS: readonly CategoryRouteOption[] = [
  {
    value: 'kitchen',
    label: 'Kitchen',
    meaning: 'The kitchen makes these.',
    consequence: 'Ready as soon as the kitchen bumps it.',
    requiresAcknowledgement: false,
  },
  {
    value: 'bar',
    label: 'Bar',
    meaning: 'The bar makes these.',
    consequence: 'Ready as soon as the bar bumps it.',
    requiresAcknowledgement: false,
  },
  {
    value: 'both',
    label: 'Both stations',
    meaning: 'The kitchen and the bar each make a part of these.',
    consequence:
      'NOT ready until the KITCHEN and the BAR have EACH finished it. One station finishing alone will not release it to the waiter.',
    requiresAcknowledgement: true,
  },
]

export function categoryRouteOption(route: CategoryRoute): CategoryRouteOption {
  return CATEGORY_ROUTE_OPTIONS.find((o) => o.value === route) ?? CATEGORY_ROUTE_OPTIONS[0]
}

/** Only `both` needs the merchant to say they meant it. */
export function categoryRouteNeedsAcknowledgement(route: CategoryRoute): boolean {
  return categoryRouteOption(route).requiresAcknowledgement
}

/** The sentence the merchant ticks. Deliberately states the cost, not the feature. */
export const BOTH_ROUTE_ACKNOWLEDGEMENT =
  'I understand: both the kitchen and the bar must finish these before the waiter sees them as Ready.'

/** The 400 an unacknowledged `both` write gets back. Says what to send, and why. */
export const BOTH_ROUTE_REFUSAL =
  "Routing to 'both' means the kitchen AND the bar must each complete the item before it becomes " +
  'Ready — one station alone will not release it. Send confirm_both: true to set it deliberately.'

/**
 * Validate a route_to for a WRITE. Returns an error string, or null when the write may proceed.
 *
 * `acknowledged` is only consulted for the value that needs it, so kitchen/bar writes are
 * unaffected, and a write that does not set route_to at all never reaches here.
 */
export function validateCategoryRouteWrite(
  route: unknown,
  acknowledged: boolean,
): { ok: true; route: CategoryRoute } | { ok: false; error: string } {
  if (!isCategoryRoute(route)) {
    return { ok: false, error: "route_to must be 'kitchen', 'bar', or 'both'" }
  }
  if (categoryRouteNeedsAcknowledgement(route) && !acknowledged) {
    return { ok: false, error: BOTH_ROUTE_REFUSAL }
  }
  return { ok: true, route }
}

/** Reads the acknowledgement from a request body, accepting either casing. */
export function readBothAcknowledgement(body: Record<string, unknown> | null | undefined): boolean {
  return body?.confirm_both === true || body?.confirmBoth === true
}
