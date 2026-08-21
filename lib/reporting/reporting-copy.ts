/**
 * Staff-facing strings for the reporting surfaces.
 *
 * PENDING COPY -- placeholders, not drafted wording. Do not write final copy here; it is signed off
 * by the owner. `scripts/check-no-pending-copy.mjs` will fail the production deploy while these
 * remain, which is the intended behaviour: the pre-launch notice must not reach a staff screen
 * before somebody has decided what it says.
 */
export const REPORTING_PENDING_COPY = {
  /**
   * Renders: Order History, in place of the Total Revenue / Total Orders / Average Order Value
   * cards, when the venue has not opened.
   *
   * IT REPLACES THE FIGURES RATHER THAN ZEROING THEM. A rendered 0.00 is indistinguishable from a
   * real week with no sales, so the wording has to say the numbers are WITHHELD and why -- not that
   * they are zero.
   */
  preLaunchTitle: 'PENDING COPY - figures withheld until this location opens',
  preLaunchBody:
    'PENDING COPY - orders below are test data and are not counted as revenue. Nothing has been ' +
    'changed or deleted.',
} as const
