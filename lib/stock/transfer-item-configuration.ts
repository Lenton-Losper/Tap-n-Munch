/**
 * WHICH END OF A TRANSFER IS AN ITEM NOT CONFIGURED AT — the single predicate behind both
 * halves of the Create Transfer form's "never offer an impossible transfer" rule.
 *
 * A transfer line only survives dispatch if the canonical item has an ACTIVE `stock_items`
 * mapping at BOTH ends. `dispatch_transfer` enforces that in the database and raises before
 * deducting anything, so nothing is ever lost -- but the failure surfaces only after the user
 * has built a draft and dispatched it. See #336.
 *
 * THIS LIVES IN ITS OWN MODULE, NOT IN `transfer-queries.ts`, ON PURPOSE. `transfer-queries.ts`
 * constructs the service-role Supabase client at module scope reach; importing a VALUE from it
 * into a client component would pull server-only code into the browser bundle. The Create
 * Transfer form and the item picker are both `'use client'`, so the shared predicate has to sit
 * in a module with no server imports. `OrganizationStockItemOption` is still imported from
 * `transfer-queries.ts` as a TYPE only, which is erased at compile time.
 *
 * WHY IT IS SHARED RATHER THAN WRITTEN TWICE. The picker asks the question when an item is
 * PICKED; the form asks it again when the DESTINATION CHANGES. Two copies of the rule is how the
 * second question came to not be asked at all -- the picker validated against whichever
 * destination was selected at pick time, and nothing re-asked when the destination moved
 * underneath a row that had already been filled in.
 */

/** An item's configuration footprint. Structural, so both the query type and test fixtures fit. */
export type ConfiguredAtLocations = {
  /** restaurant_ids where this canonical item currently has an active local stock_items mapping. */
  configuredRestaurantIds: string[]
}

/** Which end of the transfer the item is missing at, or `null` when both ends are configured. */
export type UnconfiguredTransferEnd = 'SOURCE' | 'DESTINATION'

/**
 * Source is checked first so the caller reports the end nearest the user before the far one.
 *
 * A `null` destination means "no destination chosen yet" and is NOT treated as unconfigured:
 * the source half is still worth reporting on its own, and a not-yet-chosen destination is not
 * a mapping gap.
 */
export function unconfiguredTransferEnd(
  item: ConfiguredAtLocations,
  sourceRestaurantId: string,
  destinationRestaurantId: string | null,
): UnconfiguredTransferEnd | null {
  if (!item.configuredRestaurantIds.includes(sourceRestaurantId)) {
    return 'SOURCE'
  }
  if (destinationRestaurantId && !item.configuredRestaurantIds.includes(destinationRestaurantId)) {
    return 'DESTINATION'
  }
  return null
}

/**
 * True when this item may be sent from `sourceRestaurantId` to `destinationRestaurantId` today.
 *
 * Deliberately distinct from `unconfiguredTransferEnd(...) === null`: with no destination chosen,
 * `unconfiguredTransferEnd` returns `null` (nothing to report) while this returns `false`
 * (nothing is transferable to nowhere). Callers deciding whether to CLEAR a chosen line want the
 * second reading; callers deciding what LABEL to show want the first.
 */
export function isTransferableBetween(
  item: ConfiguredAtLocations,
  sourceRestaurantId: string,
  destinationRestaurantId: string | null,
): boolean {
  if (!destinationRestaurantId) return false
  return unconfiguredTransferEnd(item, sourceRestaurantId, destinationRestaurantId) === null
}
