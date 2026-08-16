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
  it('#224: a TOTAL outage shows the banner while searching, because the body will not', () => {
    const bodyState = menuBodyState({
      hasEntries: false,
      notice: total,
      loading: false,
      loadedOnce: true,
      searchQuery: 'espresso',
    })
    // The body keeps its recorded wording...
    expect(bodyState).toBe('empty')
    // ...and the banner carries the truth the body is not allowed to.
    expect(shouldShowMenuNoticeBanner({ notice: total, bodyState })).toBe(true)
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
