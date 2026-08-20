/**
 * WHAT THE SIDEBAR SWITCHER IS ALLOWED TO OFFER.
 *
 * #321 made the session bootstrap honour `user_active_context` (see pick-session-restaurant.ts),
 * but left the choice unreachable in the product: app/choose-context is only entered by typing the
 * URL, because rule 3 of resolveLoginDestination re-validates the stored context and resolves
 * straight past the picker for anyone who already has one. So a second location stayed invisible
 * to a user who owned it. This builds the view model for the affordance that was missing.
 *
 * IT IS A PURE FUNCTION FOR THE SAME REASON pickSessionRestaurant IS. The security half of a
 * switcher is not what it shows, it is what it CANNOT show: the options are derived only from the
 * contexts the server resolved from `restaurant_users`, so a restaurant the user holds no row on
 * can never appear in the list. That control is testable here without a database or a DOM.
 *
 * The list is a convenience, not an authority. Selecting an entry POSTs to
 * /api/auth/select-context, which re-derives the user's real contexts and rejects anything that is
 * not among them -- so even a tampered option value fails server-side. Nothing here grants access.
 */

export type RestaurantSwitcherOption = {
  restaurantId: string
  restaurantName: string
  /** The restaurant the session is currently resolved to, marked in the list. */
  isCurrent: boolean
}

export type RestaurantSwitcherModel = {
  /** False for single-restaurant accounts -- there is nothing to switch between. */
  visible: boolean
  options: RestaurantSwitcherOption[]
}

/** The shape /api/auth/contexts returns. Platform contexts carry no restaurant and are dropped. */
export type SwitcherContextInput = {
  type?: string | null
  restaurantId?: string | null
  restaurantName?: string | null
}

export function buildRestaurantSwitcher(params: {
  contexts: SwitcherContextInput[] | null | undefined
  currentRestaurantId: string | null | undefined
}): RestaurantSwitcherModel {
  const current = params.currentRestaurantId ? String(params.currentRestaurantId) : null

  const options: RestaurantSwitcherOption[] = []
  const seen = new Set<string>()

  for (const context of params.contexts ?? []) {
    // A platform context is a different kind of account, not another restaurant -- switching
    // between those is the picker's job, not this control's.
    if (context?.type !== 'restaurant') continue

    const restaurantId = context.restaurantId ? String(context.restaurantId) : ''
    if (!restaurantId || seen.has(restaurantId)) continue
    seen.add(restaurantId)

    options.push({
      restaurantId,
      restaurantName: String(context.restaurantName ?? '').trim() || restaurantId,
      isCurrent: restaurantId === current,
    })
  }

  // One restaurant (or none) means there is no choice to present. Rendering a switcher with a
  // single entry would imply an option that does not exist.
  return { visible: options.length > 1, options }
}
