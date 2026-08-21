/**
 * #246 — the partial-failure banner must survive a search that matches nothing.
 *
 * THE ASSERTION THAT CARRIES THE FILE is `survives a search that matches nothing`. That is the
 * defect verbatim: the render site required `filteredGroupedEntries.length > 0`, so the banner
 * vanished exactly when the customer was searching for an item that might live in the part of
 * the menu that had failed to load. They were shown "No items found" — a claim about the
 * restaurant's menu — with no hint that the menu on screen was incomplete.
 *
 * AND IT MUST NOT OVERRULE THE RECORDED DECISION next to it. `menuBodyState` deliberately refuses
 * to let a stale notice displace "No items found" while searching:
 *
 *     // While searching, a stale notice must not displace the "no results" wording.
 *     if (notice && !searchQuery) return 'failed'
 *
 * That decision stands, and `bodyStateStillSaysNoResults` below pins it. The fix works precisely
 * because these are two different seams: the BODY keeps saying "no results", and a banner ABOVE
 * it says part of the menu could not be loaded. Anyone tempted to "simplify" them into one
 * should read both tests first.
 */
import {
  menuBodyState,
  shouldShowMenuNoticeBanner,
  type MenuBodyState,
} from '@/lib/menu/menu-body-state'
import type { MenuNotice } from '@/lib/menu/load-menu-categories'

const partial: MenuNotice = {
  tone: 'partial',
  title: 'Some items could not be loaded',
  description: 'Part of the menu is missing.',
  retryLabel: 'Try again',
} as MenuNotice

const total: MenuNotice = { ...partial, tone: 'total' } as MenuNotice

describe('the partial-failure banner', () => {
  it('survives a search that matches nothing — the defect', () => {
    // Nothing on screen, a search running, part of the menu failed to load.
    const bodyState = menuBodyState({
      hasEntries: false,
      notice: partial,
      loading: false,
      loadedOnce: true,
      searchQuery: 'espresso',
    })
    expect(shouldShowMenuNoticeBanner({ notice: partial, bodyState })).toBe(true)
  })

  it('shows alongside items, as it always did', () => {
    const bodyState = menuBodyState({
      hasEntries: true,
      notice: partial,
      loading: false,
      loadedOnce: true,
      searchQuery: '',
    })
    expect(bodyState).toBe('items')
    expect(shouldShowMenuNoticeBanner({ notice: partial, bodyState })).toBe(true)
  })

  it('is absent when nothing failed', () => {
    expect(shouldShowMenuNoticeBanner({ notice: null, bodyState: 'items' })).toBe(false)
  })

  /**
   * REVERSED BY #224, deliberately, and the old assertion is rewritten rather than deleted so the
   * change is visible where the original expectation was pinned.
   *
   * It used to read: `is absent for a TOTAL failure — that is the body's job, not a banner's`.
   * That is true when the body IS rendering the failure — and `menuBodyState` does not render it
   * while a search is running, because of its own recorded decision. So during a search a total
   * outage fell through to "No items found" with nothing saying the menu had not loaded.
   */
  /**
   * RETARGETED 2026-08-21 — #289 ruled B, and this expectation is what the ruling changed.
   *
   * It asserted `bodyState === 'empty'` mid-search during a TOTAL outage, and that the banner
   * therefore had to carry the truth alone. That was a faithful pin of the recorded decision at the
   * time, and it is why the ruling was needed rather than a quiet edit.
   *
   * The decision was narrowed: a total outage now returns `failed` even while searching, because
   * nothing loaded and "No items found" is a false claim about the restaurant's menu. The body
   * tells the truth itself, so the banner stands down to avoid saying it twice.
   *
   * Kept, inverted, rather than deleted — the case it covers is still the one that matters, and
   * losing it would leave the mid-search total outage untested in either direction.
   */
  it('#289: a TOTAL outage now fails the BODY while searching, and the banner stands down', () => {
    const bodyState = menuBodyState({
      hasEntries: false,
      notice: total,
      loading: false,
      loadedOnce: true,
      searchQuery: 'espresso',
    })
    // The body no longer claims "No items found" when nothing was ever loaded to search.
    expect(bodyState).toBe('failed')
    // And the banner does not repeat what the full-page failure block is already saying.
    expect(shouldShowMenuNoticeBanner({ notice: total, bodyState })).toBe(false)
  })

  it('#289: a PARTIAL failure is UNCHANGED — the body keeps "no results", the banner carries the rest', () => {
    // The half the ruling deliberately did not touch. Items loaded, the search matched none of
    // them, so "No items found" is true and must not be displaced.
    const bodyState = menuBodyState({
      hasEntries: false,
      notice: partial,
      loading: false,
      loadedOnce: true,
      searchQuery: 'espresso',
    })
    expect(bodyState).toBe('empty')
    expect(shouldShowMenuNoticeBanner({ notice: partial, bodyState })).toBe(true)
  })

  it('a TOTAL outage does NOT duplicate the full-page block when not searching', () => {
    const bodyState = menuBodyState({
      hasEntries: false,
      notice: total,
      loading: false,
      loadedOnce: true,
      searchQuery: '',
    })
    expect(bodyState).toBe('failed')
    expect(shouldShowMenuNoticeBanner({ notice: total, bodyState })).toBe(false)
  })

  it('does not duplicate the full-page failure block', () => {
    // When the body renders `failed` it already carries the same title, description and retry.
    expect(shouldShowMenuNoticeBanner({ notice: partial, bodyState: 'failed' })).toBe(false)
  })

  it.each<MenuBodyState>(['items', 'loading', 'empty'])(
    'shows in the %s body state, where the body says nothing about the failure',
    (bodyState) => {
      expect(shouldShowMenuNoticeBanner({ notice: partial, bodyState })).toBe(true)
    }
  )
})

describe('the recorded decision it must not overrule', () => {
  it('bodyStateStillSaysNoResults: a stale notice does not displace "no results" while searching', () => {
    // menu-body-state.ts: "While searching, a stale notice must not displace the 'no results'
    // wording." If this ever returns 'failed', that decision has been reversed.
    const bodyState = menuBodyState({
      hasEntries: false,
      notice: partial,
      loading: false,
      loadedOnce: true,
      searchQuery: 'espresso',
    })
    expect(bodyState).toBe('empty')
    expect(bodyState).not.toBe('failed')
  })

  it('and still reports failed when NOT searching', () => {
    const bodyState = menuBodyState({
      hasEntries: false,
      notice: partial,
      loading: false,
      loadedOnce: true,
      searchQuery: '',
    })
    expect(bodyState).toBe('failed')
  })
})
