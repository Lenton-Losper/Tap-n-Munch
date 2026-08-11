/**
 * Which of the browse page's body states to render — #214.
 *
 * The page used to have TWO states where it needs THREE: it showed either the items or the
 * "Menu coming soon!" empty state, and it decided between them on `items.length > 0` alone. The
 * page's `loading` flag covers only the category-list fetch, so the moment the CATEGORY NAMES
 * arrived — with the ITEMS still in flight — the page fell through and affirmatively told the
 * customer the restaurant sells nothing.
 *
 * Extracted rather than written inline so the test binds to the shipped rule instead of carrying
 * its own copy of it (#205: five tests stayed green against a render site that had been reverted,
 * because the test restated the logic).
 *
 * The residual is stated honestly: this proves the RULE. That the browse page calls it is covered
 * by reading the call site and by `tsc`, not by this module.
 */
import type { MenuNotice } from './load-menu-categories'

export type MenuBodyState =
  /** Items to show. */
  | 'items'
  /** We do not yet know what there is. NEVER a claim about what the restaurant sells. */
  | 'loading'
  /** A fetch REJECTED. The notice, with its retry. */
  | 'failed'
  /** A fetch COMPLETED SUCCESSFULLY and returned nothing. Only here is "Menu coming soon!" true. */
  | 'empty'

export type MenuBodyStateInput = {
  /** Whether anything survived filtering and is renderable right now. */
  hasEntries: boolean
  /** `menuLoadNotice(...)` for the source currently on screen, or null. */
  notice: MenuNotice | null
  /** A fetch for the source currently on screen is in flight. */
  loading: boolean
  /**
   * A fetch for the source currently on screen has COMPLETED SUCCESSFULLY at least once.
   *
   * Separate from `!loading` because "not loading" is also true before the first fetch has been
   * dispatched — which is exactly the window the defect lived in.
   */
  loadedOnce: boolean
  /** The active search text. A search that matches nothing is not an empty menu. */
  searchQuery: string
}

export function menuBodyState({
  hasEntries,
  notice,
  loading,
  loadedOnce,
  searchQuery,
}: MenuBodyStateInput): MenuBodyState {
  if (hasEntries) return 'items'

  // Checked before the notice so a RETRY reads as loading rather than re-asserting the failure
  // the customer is in the middle of retrying.
  if (loading) return 'loading'

  // The notice is only ever non-null after a fetch REJECTED, so this cannot capture a slow load.
  // While searching, a stale notice must not displace the "no results" wording.
  if (notice && !searchQuery) return 'failed'

  // Nothing in flight, nothing failed, and nothing has successfully come back yet: we still do
  // not know. This is the window between the category list arriving and the items arriving.
  if (!loadedOnce) return 'loading'

  return 'empty'
}
