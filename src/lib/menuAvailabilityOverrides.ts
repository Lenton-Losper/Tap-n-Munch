/**
 * What THIS DEVICE has been told by the server about menu availability since the menu was loaded.
 *
 * WHY IT EXISTS. ServiceRoundScreen fetches the whole menu ONCE, on mount, and then keeps it for
 * the life of the screen — deliberately, so search answers correctly for the whole menu rather
 * than only the parts already browsed. That cache is what a waiter taps to build a round, and
 * nothing invalidates it. So the moment this feature exists, a waiter can hide a dish on this very
 * device, walk back to the grid, and add the dish they just took off the menu to a customer's
 * round. The stale tile is not a cosmetic problem; it is an order for food the venue has said it
 * does not have.
 *
 * WHY IT IS A MODULE AND NOT NAVIGATION PARAMS. Handing the result back through route params only
 * works when the waiter leaves by the screen's own back control. Android's hardware back does not
 * go through it, and that is the exit a waiter actually uses. A module the grid reads on every
 * render has no such hole.
 *
 * WHAT IT IS NOT. It is NOT a cache of the menu, NOT a source of truth, and NOT optimistic state.
 * Nothing is recorded here until a 200 has come back from the server — see the call site in
 * MenuItemDetailScreen, which records only inside the success branch. The whole value of the
 * availability call is the server-side menu-cache invalidation having completed; writing an
 * override before the write lands would put the device's guess on the grid and teach waiters to
 * trust a state that is not real.
 *
 * LIFETIME. Process memory, cleared on app restart, which is correct: after a restart the menu is
 * fetched fresh and the server's own status is authoritative again.
 */

/** itemId -> is_available, as the SERVER reported it after a completed change. */
const overrides = new Map<string, boolean>();

/**
 * Record what the server said. Call this ONLY after a successful response, never before one.
 */
export function recordAvailabilityChange(
  itemId: string,
  isAvailable: boolean,
): void {
  if (!itemId) {
    return;
  }
  overrides.set(itemId, isAvailable);
}

/**
 * The recorded availability for one item, or null when this device has not changed it.
 *
 * Null and false are different answers and must not be collapsed: null means "no opinion, use the
 * fetched record", false means "the server told this device the dish is hidden".
 */
export function availabilityOverride(itemId: string): boolean | null {
  const known = overrides.get(itemId);
  return known === undefined ? null : known;
}

/**
 * Apply every recorded change to a list of items fetched earlier.
 *
 * IDENTITY-PRESERVING WHEN NOTHING CHANGED — the SAME array reference comes back, not an equal
 * copy. Callers fold the result straight back into React state, and a fresh array every time would
 * make `setState` see a new value on every focus and re-render the whole menu grid forever.
 */
export function applyAvailabilityOverrides<
  T extends {id: string; is_available: boolean},
>(items: T[]): T[] {
  if (overrides.size === 0) {
    return items;
  }
  let changed = false;
  const next = items.map(item => {
    const known = overrides.get(item.id);
    if (known === undefined || known === item.is_available) {
      return item;
    }
    changed = true;
    return {...item, is_available: known};
  });
  return changed ? next : items;
}

/** Test seam. Nothing in the app calls this — process lifetime is the intended reset. */
export function clearAvailabilityOverrides(): void {
  overrides.clear();
}
