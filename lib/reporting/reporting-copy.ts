/**
 * Staff-facing strings for the reporting surfaces.
 *
 * SIGNED OFF by the owner 2026-08-23. `scripts/check-no-pending-copy.mjs` failed the production
 * deploy while these carried the PENDING COPY marker, which is exactly what it is for -- the
 * pre-launch notice must not reach a staff screen before somebody has decided what it says.
 *
 * Do not reword without the owner. Anything a venue is told about its own revenue is money-adjacent.
 */
export const REPORTING_COPY = {
  /**
   * Renders: Order History, in place of the Total Revenue / Total Orders / Average Order Value
   * cards, when the venue has not opened.
   *
   * IT REPLACES THE FIGURES RATHER THAN ZEROING THEM. A rendered 0.00 is indistinguishable from a
   * real week with no sales, so the wording has to say the numbers are WITHHELD and why -- not that
   * they are zero.
   */
  preLaunchTitle: 'figures withheld until this location opens',
  preLaunchBody:
    "orders below are test data and aren't counted as revenue. nothing has been changed or " +
    'deleted.',
} as const
