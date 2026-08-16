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

/**
 * Whether to show the inline menu-failure banner (#246, extended by #224).
 *
 * Named for the BANNER rather than for `partial`, because it stopped meaning "partial only" when
 * #224 brought total outages in. A predicate whose name is narrower than its behaviour is how the
 * next person introduces a bug in it.
 *
 * A DIFFERENT SEAM FROM THE ONE ABOVE, and the distinction is the whole fix. `menuBodyState`
 * decides what the BODY says, and it deliberately refuses to let a stale notice displace "No
 * items found" while the customer is searching — that is a recorded decision and it stands. This
 * decides whether an inline amber strip appears ABOVE the body, which is a separate question the
 * body-state rule never answered.
 *
 * THE DEFECT. The render site read `menuNotice.tone === 'partial' && filteredGroupedEntries.length > 0`,
 * so the banner vanished the moment a search matched nothing in the part of the menu that HAD
 * loaded. That is the worst possible moment to hide it: the customer is searching for something,
 * finding nothing, and the reason may be that the category it lives in failed to load. They were
 * shown "No items found" — a claim about the restaurant's menu — with no hint that the menu on
 * screen was incomplete.
 *
 * The two now coexist: the body still says "No items found", and the banner above it says part of
 * the menu could not be loaded, with its retry.
 *
 * `bodyState !== 'failed'` is the only exclusion, and it is about duplication rather than
 * suppression: when the body is already rendering the full-page failure block, that block carries
 * the same title, description and retry, so the banner would be the same message twice.
 */
export function shouldShowMenuNoticeBanner(input: {
  notice: MenuNotice | null
  bodyState: MenuBodyState
}): boolean {
  if (!input.notice) return false
  /**
   * TOTAL FAILURES SHOW HERE TOO, WHILE SEARCHING (#224).
   *
   * A total outage normally renders the full-page `failed` block, and this returns false for it
   * because `bodyState === 'failed'` — that block already carries the same title, description and
   * retry, so a banner would be the message twice.
   *
   * But `menuBodyState` deliberately does NOT return `failed` while a search is running: its
   * recorded decision is *"while searching, a stale notice must not displace the 'no results'
   * wording."* So during a search a total outage falls to `empty`, and the customer was shown a
   * bare **"No items found"** — a claim about the restaurant's menu — when in fact NOTHING had
   * loaded and there was nothing to search.
   *
   * That decision is not overruled here and `menuBodyState` is untouched. The body still says
   * "No items found"; this puts the outage and its retry ABOVE it, which is the same two-seam
   * split #246 established. Whether the BODY's own wording should change for a total outage is a
   * separate question and is the human's — filed rather than built.
   */
  if (input.notice.tone !== 'partial' && input.notice.tone !== 'total') return false
  return input.bodyState !== 'failed'
}
