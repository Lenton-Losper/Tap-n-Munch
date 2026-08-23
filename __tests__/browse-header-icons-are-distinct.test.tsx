/**
 * @jest-environment jsdom
 *
 * The browse header's right-hand row carries two outline buttons side by side. Both labels are
 * `hidden sm:inline`, so below the `sm` breakpoint — a 360px phone, which is the entire QR use
 * case — the ICON is the only thing telling them apart.
 *
 * Both rendered lucide's <Receipt />. Two identical glyphs, two different destinations, no way
 * to tell which was which.
 *
 * THE PAIR CHANGED, THE RULE DID NOT (2026-08-16, redesign spec sections 7/33/37). The first
 * button is now **Tab**, not Receipt: `/menu/[id]/receipt` is a running-bill screen rather than
 * a paid receipt, so it was demoted out of the header, and the Tab — previously reachable only
 * by tapping the strip — took the slot. This file was NOT deleted and its assertions were NOT
 * weakened. What it records is a decision about two adjacent icon-only controls, and that
 * decision outlives the particular pair; only the label it looks the buttons up by moved.
 *
 * The labels are not the fix: they collapse deliberately. The comment beside the button records
 * that a third labelled control pushed the left block past its truncation point, rendering the
 * restaurant name as "S…" and the table as "T…". So the icons have to carry the distinction.
 *
 * This asserts on the REAL page's rendered SVG, not on the source, because the defect was two
 * call sites agreeing rather than one being wrong — a name-level check would have passed.
 *
 * PROOF CEILING: jsdom knows nothing of the `sm` breakpoint or of what a glyph LOOKS like. It
 * proves the two buttons emit different vector data and each has an accessible name. That two
 * distinct glyphs are also legibly distinct at 16px is the human's check.
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

jest.mock('next/navigation', () => ({
  useParams: () => ({ restaurantId: 'riviera' }),
  useSearchParams: () => new URLSearchParams('table=4'),
  useRouter: () => ({ push: jest.fn(), replace: jest.fn(), back: jest.fn() }),
}))

jest.mock('next/image', () => ({ __esModule: true, default: () => null }))
jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ children }: any) => <span>{children}</span>,
}))

jest.mock('@/components/menu/food-item-image', () => ({ FoodItemImage: () => null }))
jest.mock('@/components/menu/item-detail-modal', () => ({ ItemDetailModal: () => null }))
jest.mock('@/components/OrderStatusBanner', () => ({ __esModule: true, default: () => null }))
jest.mock('@/components/menu/menu-order-status-tracker', () => ({
  MenuOrderStatusTracker: () => null,
}))

jest.mock('@/contexts/restaurant-context', () => ({
  useRestaurant: () => ({
    restaurant: { id: 'riviera', name: 'Riviera', currency: 'N$' },
    currency: 'N$',
  }),
}))
jest.mock('@/contexts/cart-context', () => ({
  useCart: () => ({
    items: [],
    getItemCount: () => 0,
    addItem: jest.fn(),
    clearCart: jest.fn(),
  }),
}))
/**
 * A customer WITH a tab, deliberately.
 *
 * The subject of this file is two adjacent icon-only buttons, and that pair only exists on a
 * tab: the first slot is now **Tab**, which is gated on being in one because there is nothing to
 * view otherwise. The fixture previously said `isInTab: false`, which was fine while the slot
 * held Receipt (gated on `table > 0`) and is not fine now.
 */
jest.mock('@/contexts/tab-context', () => ({
  useTab: () => ({
    isInTab: true,
    tabId: 'tab-1',
    tabTotal: 0,
    tabPending: 0,
    tabMembers: [{ session_id: 'sess-1', name: 'Lenton' }],
    tabStatus: 'open',
    clearTab: jest.fn(),
  }),
}))

jest.mock('@/hooks/useClearCartOnTableChange', () => ({
  useClearCartOnTableChange: () => undefined,
}))
jest.mock('@/hooks/useTabSessionEndedRedirect', () => ({
  useTabSessionEndedRedirect: () => ({ redirecting: false }),
}))

jest.mock('@/lib/session', () => ({
  getOrCreateSession: () => 'sess-1',
  getCurrentSession: () => 'sess-1',
  getSessionInfo: () => ({ table: '4', restaurant: 'riviera' }),
}))
jest.mock('@/lib/session-recovery', () => ({ restoreSessionFromTable: async () => 'sess-1' }))
jest.mock('@/lib/tab-storage', () => ({ readStoredTabId: () => '' }))
jest.mock('@/lib/tab-session', () => ({ fetchTabById: async () => null }))
jest.mock('@/lib/restaurant-logo', () => ({ restaurantLogoDisplayUrl: () => null }))
jest.mock('@/lib/supabase/tables', () => ({
  getSupabaseTableByNumber: async () => ({ is_view_only: false }),
}))
jest.mock('@/lib/supabase/menu', () => ({ getSupabaseCategories: jest.fn() }))

import BrowsePage from '@/app/menu/[restaurantId]/browse/page'
import { getSupabaseCategories } from '@/lib/supabase/menu'
import { CUSTOMER_NAV_COPY } from '@/lib/customer-nav-copy'
import { QR_REDESIGN_PENDING_COPY } from '@/lib/customer-copy/qr-redesign-copy'

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  ;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  ;(globalThis as any).fetch = jest.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({}),
  }))
  ;(getSupabaseCategories as jest.Mock).mockReset()
  ;(getSupabaseCategories as jest.Mock).mockResolvedValue([{ id: 'cat-food', name: 'Food' }])
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  jest.restoreAllMocks()
})

async function renderBrowse() {
  await act(async () => {
    root.render(<BrowsePage />)
  })
  for (let i = 0; i < 4; i++) {
    await act(async () => {
      await Promise.resolve()
    })
  }
}

/** The button whose accessible name is `label`. Throws rather than returning null, so a button
 *  that lost its aria-label fails here instead of silently skipping the icon assertion. */
function buttonLabelled(label: string): HTMLButtonElement {
  const button = container.querySelector(`button[aria-label="${label}"]`)
  if (!button) throw new Error(`no button with accessible name "${label}"`)
  return button as HTMLButtonElement
}

/** The vector data of the icon inside a button — what actually reaches the customer's eye. */
function iconGeometry(button: HTMLButtonElement): string {
  const svg = button.querySelector('svg')
  if (!svg) throw new Error('button renders no icon')
  return Array.from(svg.querySelectorAll('path, circle, rect, line, polyline'))
    .map((node) => `${node.tagName}:${node.getAttribute('d') ?? node.outerHTML}`)
    .join('|')
}

describe('browse header — Tab and My Orders are tellable apart', () => {
  it('renders a different icon in each button', async () => {
    await renderBrowse()

    const tab = iconGeometry(buttonLabelled(QR_REDESIGN_PENDING_COPY.navTab))
    const myOrders = iconGeometry(buttonLabelled(CUSTOMER_NAV_COPY.myOrders))

    expect(tab).not.toBe('')
    expect(myOrders).not.toBe('')
    // The defect verbatim: below `sm` these two are the whole of what the customer can see.
    expect(myOrders).not.toBe(tab)
  })

  it('gives both buttons an accessible name, since below `sm` they are icon-only', async () => {
    await renderBrowse()

    // buttonLabelled throws if the name is missing; assert the pair explicitly so the reason
    // the names matter is on the record next to the icon assertion.
    expect(buttonLabelled(QR_REDESIGN_PENDING_COPY.navTab)).toBeTruthy()
    expect(buttonLabelled(CUSTOMER_NAV_COPY.myOrders)).toBeTruthy()
  })

  it('no longer offers Receipt from the browse header', async () => {
    await renderBrowse()

    // Spec sections 33/37. The ROUTE survives and is still linked from the landing, /menu, the
    // gateway-return confirmation and ActiveOrderBanner -- this asserts only that the header
    // stopped presenting it as a primary destination.
    expect(container.querySelector('button[aria-label="Receipt"]')).toBeNull()
  })
})
