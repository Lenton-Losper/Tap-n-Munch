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
  shouldShowPartialMenuNotice,
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
    expect(shouldShowPartialMenuNotice({ notice: partial, bodyState })).toBe(true)
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
    expect(shouldShowPartialMenuNotice({ notice: partial, bodyState })).toBe(true)
  })

  it('is absent when nothing failed', () => {
    expect(shouldShowPartialMenuNotice({ notice: null, bodyState: 'items' })).toBe(false)
  })

  it('is absent for a TOTAL failure — that is the body’s job, not a banner’s', () => {
    expect(shouldShowPartialMenuNotice({ notice: total, bodyState: 'empty' })).toBe(false)
  })

  it('does not duplicate the full-page failure block', () => {
    // When the body renders `failed` it already carries the same title, description and retry.
    expect(shouldShowPartialMenuNotice({ notice: partial, bodyState: 'failed' })).toBe(false)
  })

  it.each<MenuBodyState>(['items', 'loading', 'empty'])(
    'shows in the %s body state, where the body says nothing about the failure',
    (bodyState) => {
      expect(shouldShowPartialMenuNotice({ notice: partial, bodyState })).toBe(true)
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
