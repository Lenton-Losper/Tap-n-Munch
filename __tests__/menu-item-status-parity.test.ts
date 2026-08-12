/**
 * #272 — an item the checkout refuses must never appear orderable on the customer menu.
 *
 * The defect was a DENYLIST on one side and an ALLOWLIST on the other, written independently:
 *
 *   browse   lib/supabase/menu.ts          `status !== 'hidden'`
 *   pricing  lib/orders/calculate-order-pricing.ts  `status === 'available' || 'active'`
 *
 * Everything in neither set rendered with a live Add button, entered the cart at its listed
 * price, and was hard-rejected at submission. On production Riviera, 2026-08-12: 'Cappucinno'
 * (inactive, N$45) and 'Duck Confit' (out_of_stock, N$380).
 *
 * WHY THIS TEST DRIVES THE REAL CALL SITES rather than asserting the predicate table directly.
 * A test carrying its own copy of the rule proves nothing about shipped code — #205 stayed
 * green against a reverted render site for exactly that reason. So PARITY below calls the
 * actual customer menu query and the actual pricing function, with only Supabase faked, and
 * asserts the relationship BETWEEN their two answers. It imports `lib/menu/menu-item-status`
 * only to enumerate the statuses worth trying and to ask which are deliberately display-only —
 * never to re-derive either side's answer.
 *
 * Hermetic: no network, no Supabase, no Redis.
 */
import {
  KNOWN_MENU_ITEM_STATUSES,
  isChargeableMenuStatus,
  isCustomerVisibleMenuStatus,
  isDisplayOnlyMenuStatus,
} from '@/lib/menu/menu-item-status'

const RESTAURANT_UUID = 'a1999166-ddfa-40d1-ad1f-2f01282a1652'
const CATEGORY_ID = '6813cd3a-ffda-4946-8f12-a37fda3058fa'

/**
 * Every status either side could meet: the ones the table knows, plus values it does not.
 * 'inactive' and 'out_of_stock' are the two live production cases. The rest are the shapes a
 * future migration or a typo can produce — the gap was never a list of three known strings,
 * it was every string nobody had thought of.
 */
const STATUS_CORPUS = [
  ...KNOWN_MENU_ITEM_STATUSES,
  'INACTIVE',
  'Out_Of_Stock',
  'discontinued',
  'seasonal',
  'coming_soon',
  'draft',
  '86ed',
  'unavailable',
  '',
]

/** One menu_items row per status, ids derived from the index so both fakes agree. */
const ROWS = STATUS_CORPUS.map((status, i) => ({
  id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
  name: `item-${status || 'EMPTY'}`,
  status,
  base_price: 45,
  sizes: [],
  addons: [],
  tax_rate_id: null,
  category_id: CATEGORY_ID,
  subcategory_id: null,
  restaurant_id: RESTAURANT_UUID,
}))

// ---------------------------------------------------------------------------
// Fakes. Only Supabase is faked; both units under test run for real.
// ---------------------------------------------------------------------------

/** The browse query: menu_subcategories then menu_items, both awaited off the builder. */
function makeBrowseClient() {
  return {
    from(table: string) {
      const builder: Record<string, unknown> = {}
      const chain = () => builder
      Object.assign(builder, {
        select: chain,
        eq: chain,
        in: chain,
        order: chain,
        then: (resolve: (r: unknown) => unknown) => {
          if (table === 'menu_subcategories') return Promise.resolve(resolve({ data: [], error: null }))
          if (table === 'menu_items') return Promise.resolve(resolve({ data: ROWS, error: null }))
          return Promise.resolve(resolve({ data: [], error: null }))
        },
      })
      return builder
    },
  }
}

jest.mock('@/lib/supabase/client', () => ({ supabase: makeBrowseClient() }))
jest.mock('@/lib/supabase/server', () => ({ createServerSupabaseClient: () => makeBrowseClient() }))
jest.mock('@/lib/supabase/restaurants', () => ({
  resolveRestaurantUuid: async (id: string) => id,
  getRestaurantById: async () => ({ id: RESTAURANT_UUID }),
}))

// Imported AFTER the mocks so the module-level client is the fake one.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { getSupabaseMenuItemsByCategory } = require('@/lib/supabase/menu')
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { calculateOrderPricing, UnmatchedMenuItemError } = require('@/lib/orders/calculate-order-pricing')

/** The pricing query: menu_items filtered by id, plus tax_rates. */
function makePricingClient() {
  return {
    from(table: string) {
      const builder: Record<string, unknown> = {}
      const chain = () => builder
      Object.assign(builder, {
        select: chain,
        eq: chain,
        order: chain,
        in: (_col: string, ids: string[]) => {
          Object.assign(builder, {
            then: (resolve: (r: unknown) => unknown) =>
              Promise.resolve(resolve({ data: ROWS.filter((r) => ids.includes(r.id)), error: null })),
          })
          return builder
        },
        then: (resolve: (r: unknown) => unknown) => Promise.resolve(resolve({ data: [], error: null })),
      })
      return builder
    },
  } as never
}

/** Does the REAL customer menu query return this row? */
async function menuShows(rowId: string): Promise<boolean> {
  const grouped = await getSupabaseMenuItemsByCategory(RESTAURANT_UUID, CATEGORY_ID, false)
  const shown: Array<{ id: string }> = Object.values(grouped).flatMap(
    (g: unknown) => (g as { items?: Array<{ id: string }> }).items ?? [],
  )
  return shown.some((i) => i.id === rowId)
}

/** Does the REAL pricing function accept this row? */
async function pricingAccepts(rowId: string): Promise<boolean> {
  try {
    await calculateOrderPricing(makePricingClient(), RESTAURANT_UUID, [
      { menuItemId: rowId, quantity: 1 },
    ])
    return true
  } catch (err) {
    if (err instanceof UnmatchedMenuItemError) return false
    throw err
  }
}

describe('#272 — menu visibility and chargeability cannot drift apart', () => {
  /**
   * THE REGRESSION. Both answers come from shipped code; this asserts only the relationship
   * between them. On the code before this fix, 'inactive' is shown=true / priced=false and
   * this fails by name for every status in the gap.
   */
  it.each(ROWS)('parity for status "$status"', async ({ id, status }) => {
    const shown = await menuShows(id)
    const priced = await pricingAccepts(id)

    if (shown && !priced) {
      // The one legal case: deliberately rendered as unavailable (the "Out of stock" badge
      // and disabled Add button in browse/page.tsx). Anything else here is #272 reopening.
      expect(isDisplayOnlyMenuStatus(status)).toBe(true)
    }

    // The other direction: the checkout must never accept something a customer cannot see.
    if (priced) expect(shown).toBe(true)
  })

  it('the two live production cases behave as #272 requires', async () => {
    const cappucinno = ROWS.find((r) => r.status === 'inactive')!
    expect(await menuShows(cappucinno.id)).toBe(false)
    expect(await pricingAccepts(cappucinno.id)).toBe(false)

    const duckConfit = ROWS.find((r) => r.status === 'out_of_stock')!
    expect(await menuShows(duckConfit.id)).toBe(true) // badge preserved, deliberately
    expect(await pricingAccepts(duckConfit.id)).toBe(false)
  })

  it('an unknown status fails closed on both sides', async () => {
    for (const status of ['discontinued', 'seasonal', '86ed', 'coming_soon']) {
      const row = ROWS.find((r) => r.status === status)!
      expect(await menuShows(row.id)).toBe(false)
      expect(await pricingAccepts(row.id)).toBe(false)
    }
  })

  it('case does not smuggle a status past either side', async () => {
    const shouty = ROWS.find((r) => r.status === 'INACTIVE')!
    expect(await menuShows(shouty.id)).toBe(false)
    expect(await pricingAccepts(shouty.id)).toBe(false)
  })

  it('null/undefined/empty still mean available, as both predicates always did', async () => {
    const empty = ROWS.find((r) => r.status === '')!
    expect(await menuShows(empty.id)).toBe(true)
    expect(await pricingAccepts(empty.id)).toBe(true)
    expect(isCustomerVisibleMenuStatus(null)).toBe(true)
    expect(isChargeableMenuStatus(undefined)).toBe(true)
  })
})
