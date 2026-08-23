/**
 * #273. The pricer's refusal named a UUID and conflated two different situations.
 *
 * Observed live on Riviera 2026-08-12, adding a deliberately-deactivated item to a tab:
 *
 *     Menu item 7e70e5cf-a9f2-4da5-b8c8-403dd0b6d019 is not available for ordering
 *
 * A database primary key, shown to a customer, on a message that also reads as a stock problem —
 * the person who found it took it for one. It was a withdrawal.
 *
 * These bind to `calculateOrderPricing` itself rather than restating its rules, so they fail if
 * the shipped function stops naming items or stops distinguishing the two cases (#205).
 */
import {
  UnmatchedMenuItemError,
  calculateOrderPricing,
} from '@/lib/orders/calculate-order-pricing'
import { listNames } from '@/lib/orders/list-names'

const TAX_RATES = [
  { id: 'rate-1', name: 'VAT', percentage: 15, is_inclusive: true, is_default: true },
]

/** menu_items rows keyed by id, with whatever `status` the test wants. */
function makeClient(rows: Array<Record<string, unknown>>) {
  return {
    from(table: string) {
      if (table === 'tax_rates') {
        const b: Record<string, unknown> = {
          select: () => b,
          eq: () => b,
          order: () => Promise.resolve({ data: TAX_RATES, error: null }),
          then: (res: (v: unknown) => void) => res({ data: TAX_RATES, error: null }),
        }
        return b
      }
      if (table !== 'menu_items') throw new Error(`unexpected table ${table}`)
      const b: Record<string, unknown> = {
        select: (cols: string) => {
          selectedColumns = cols
          return b
        },
        eq: () => b,
        in: (_col: string, ids: string[]) =>
          Promise.resolve({
            // PROJECTS the selected columns, rather than handing back the whole fixture. This is
            // what makes the behavioural tests below actually bind to the select: a mock that
            // returns `name` whichever columns were asked for lets "the message names the item"
            // pass with `name` dropped from the query, which is precisely the half of #273 that
            // could regress silently.
            data: rows
              .filter((r) => ids.includes(String(r.id)))
              .map((r) => project(r, selectedColumns)),
            error: null,
          }),
      }
      return b
    },
  }
}

let selectedColumns = ''

/** PostgREST returns only what was selected. So does this. */
function project(row: Record<string, unknown>, cols: string): Record<string, unknown> {
  const wanted = cols.split(',').map((c) => c.trim()).filter(Boolean)
  const out: Record<string, unknown> = {}
  for (const col of wanted) {
    if (col in row) out[col] = row[col]
  }
  return out
}

/**
 * The mock is a structural stand-in for a SupabaseClient. Cast through the parameter type rather
 * than `any` so the call still typechecks against the real signature — an `any` here would let a
 * change to calculateOrderPricing's parameters go unnoticed by this suite.
 */
const asClient = (c: unknown) => c as Parameters<typeof calculateOrderPricing>[0]

const AVAILABLE = {
  id: 'item-ok',
  name: 'Americano',
  base_price: 30,
  sizes: [],
  addons: [],
  tax_rate_id: 'rate-1',
  status: 'available',
}
const WITHDRAWN = {
  id: 'item-off',
  name: 'Duck Confit',
  base_price: 380,
  sizes: [],
  addons: [],
  tax_rate_id: 'rate-1',
  status: 'inactive',
}
const ALSO_WITHDRAWN = {
  id: 'item-off-2',
  name: 'Cappuccino',
  base_price: 35,
  sizes: [],
  addons: [],
  tax_rate_id: 'rate-1',
  status: 'archived',
}

function line(menuItemId: string, name?: string) {
  return { menuItemId, quantity: 1, ...(name ? { name } : {}) }
}

async function priceExpectingRefusal(
  rows: Array<Record<string, unknown>>,
  items: Array<Record<string, unknown>>,
): Promise<UnmatchedMenuItemError> {
  try {
    await calculateOrderPricing(asClient(makeClient(rows)), 'rest-1', items)
  } catch (err) {
    if (err instanceof UnmatchedMenuItemError) return err
    throw err
  }
  throw new Error('expected a refusal, got none')
}

describe('#273 — the refusal names the item, not its UUID', () => {
  it('selects `name`, which is the whole reason a name is available', () => {
    // Guards the one-line half of the fix: drop `name` from the select and the message silently
    // falls back to the cart label for withdrawals, which is not what the issue asked for.
    return calculateOrderPricing(asClient(makeClient([AVAILABLE])), 'rest-1', [line('item-ok')]).then(
      () => {
        expect(selectedColumns).toContain('name')
      },
    )
  })

  it('names a withdrawn item and never prints its id', async () => {
    const err = await priceExpectingRefusal([WITHDRAWN], [line('item-off')])
    expect(err.message).toContain('Duck Confit')
    expect(err.message).not.toContain('item-off')
    expect(err.message).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}/i)
  })

  it('says "no longer on the menu", not something that reads as out of stock', async () => {
    const err = await priceExpectingRefusal([WITHDRAWN], [line('item-off')])
    expect(err.message).toMatch(/no longer on the menu/i)
    // The whole defect: a withdrawal read as a stock problem. Nothing here may imply it is
    // coming back shortly — that wording belongs to checkStockSufficiency.
    expect(err.message).not.toMatch(/out of stock|right now|try again/i)
  })

  it('carries a code, so probes and clients do not match on prose', async () => {
    const err = await priceExpectingRefusal([WITHDRAWN], [line('item-off')])
    expect(err.code).toBe('MENU_ITEM_NOT_ORDERABLE')
  })

  it('distinguishes a withdrawn item from one that is not on this menu at all', async () => {
    const missing = await priceExpectingRefusal([AVAILABLE], [line('item-ghost', 'Mystery Dish')])
    expect(missing.code).toBe('MENU_ITEM_NOT_FOUND')
    // No catalog row, so no catalog name — the cart's own label still beats a UUID.
    expect(missing.message).toContain('Mystery Dish')
    expect(missing.message).not.toContain('item-ghost')
  })

  it('names EVERY offending line at once, like the out-of-stock refusal does', async () => {
    // The old version threw from inside the pricing map, so a customer with two bad lines was
    // refused once, removed that item, and was refused again.
    const err = await priceExpectingRefusal(
      [AVAILABLE, WITHDRAWN, ALSO_WITHDRAWN],
      [line('item-ok'), line('item-off'), line('item-off-2')],
    )
    expect(err.items).toHaveLength(2)
    expect(err.message).toContain('Duck Confit')
    expect(err.message).toContain('Cappuccino')
    // Same list punctuation as the stock message, because both import the same joiner.
    expect(err.message).toContain(listNames(['Duck Confit', 'Cappuccino']))
  })

  it('reports a malformed line as a client bug, separately from a withdrawal', async () => {
    const err = await priceExpectingRefusal([AVAILABLE], [{ quantity: 1 }])
    expect(err.code).toBe('MENU_ITEM_MISSING_ID')
  })

  it('prefers the withdrawal message when a cart has both problems', async () => {
    // "No longer on the menu" is the one the customer can act on; "not found" is likelier to be
    // a stale cart and says less.
    const err = await priceExpectingRefusal(
      [WITHDRAWN],
      [line('item-off'), line('item-ghost', 'Mystery Dish')],
    )
    expect(err.code).toBe('MENU_ITEM_NOT_ORDERABLE')
  })

  it('still prices a good cart, and still refuses nothing', async () => {
    const result = await calculateOrderPricing(asClient(makeClient([AVAILABLE])), 'rest-1', [
      line('item-ok'),
    ])
    expect(result.total).toBe(30)
    expect(result.items).toHaveLength(1)
  })
})
