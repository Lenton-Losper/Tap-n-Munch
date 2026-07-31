/**
 * The refusal a customer sees when part of their basket is out of stock.
 *
 * Policy: reject the WHOLE order and name every unavailable item. An order must never
 * silently become something other than what the customer selected, and they should not have
 * to discover unavailable items one refusal at a time.
 */
import { checkStockSufficiency } from '../lib/orders/check-stock-sufficiency'

type Row = Record<string, unknown>

/**
 * Minimal stand-in for the query chain checkStockSufficiency uses. Each table returns a
 * fixed set of rows; filters are irrelevant because the fixtures are already scoped.
 */
function fakeSupabase(tables: Record<string, Row[]>) {
  // A thenable that also answers select/eq/in with itself, so any length of chain works and
  // awaiting it at any point yields the table's rows. Filters are irrelevant: the fixtures
  // are already scoped to one restaurant.
  const query = (rows: Row[]) => {
    const chain = {
      select: () => chain,
      eq: () => chain,
      in: () => chain,
      then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
        Promise.resolve({ data: rows, error: null }).then(resolve, reject),
    }
    return chain
  }
  return {
    from: (table: string) => query(tables[table] ?? []),
    // Report the locked RPC as unavailable so these tests exercise the query-by-query
    // fallback. The fallback is what runs if the migration has not been applied, so its
    // message construction needs cover in its own right.
    rpc: async () => ({ data: null, error: { message: 'rpc not available in this test' } }),
  } as never
}

/** Builds a scenario: menu items, their recipes, ingredients and ledger balances. */
function scenario(items: Array<{ id: string; name: string; tracked: boolean; balance: number }>) {
  return fakeSupabase({
    menu_items: items.map((i) => ({ id: i.id, name: i.name, track_inventory: i.tracked })),
    recipes: items.map((i) => ({ id: `r-${i.id}`, menu_item_id: i.id })),
    recipe_items: items.map((i) => ({ recipe_id: `r-${i.id}`, stock_item_id: `s-${i.id}` })),
    stock_movements: items.map((i) => ({ stock_item_id: `s-${i.id}`, quantity_delta: i.balance })),
    stock_items: items.map((i) => ({ id: `s-${i.id}`, name: `${i.name} stock` })),
  })
}

const line = (id: string, name: string) => ({ menuItemId: id, displayName: name, quantity: 1 })

describe('checkStockSufficiency messaging', () => {
  it('names a single unavailable item', async () => {
    const db = scenario([{ id: 'a', name: 'Biltong', tracked: true, balance: 0 }])
    const result = await checkStockSufficiency(db, 'r1', [line('a', 'Biltong')])
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.unavailable).toHaveLength(1)
    expect(result.reason).toBe('Biltong is out of stock and cannot be ordered right now.')
  })

  it('names two unavailable items with "and", not just the first', async () => {
    const db = scenario([
      { id: 'a', name: 'Biltong', tracked: true, balance: 0 },
      { id: 'b', name: 'Droe wors', tracked: true, balance: -3 },
    ])
    const result = await checkStockSufficiency(db, 'r1', [line('a', 'Biltong'), line('b', 'Droe wors')])
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.unavailable.map((u) => u.itemName)).toEqual(['Biltong', 'Droe wors'])
    expect(result.reason).toContain('Biltong and Droe wors')
    expect(result.reason).toMatch(/are out of stock/)
  })

  it('uses a readable list for three or more', async () => {
    const db = scenario([
      { id: 'a', name: 'Biltong', tracked: true, balance: 0 },
      { id: 'b', name: 'Droe wors', tracked: true, balance: 0 },
      { id: 'c', name: 'Chili bites', tracked: true, balance: 0 },
    ])
    const result = await checkStockSufficiency(db, 'r1', [
      line('a', 'Biltong'), line('b', 'Droe wors'), line('c', 'Chili bites'),
    ])
    if (result.ok) throw new Error('unreachable')
    expect(result.reason).toContain('Biltong, Droe wors and Chili bites')
    expect(result.reason).not.toMatch(/,\s*and/) // no Oxford comma pile-up
    expect(result.reason).not.toMatch(/\d+ more/) // never "and 2 more"
  })

  it('lists only the unavailable items, not the whole basket', async () => {
    const db = scenario([
      { id: 'a', name: 'Biltong', tracked: true, balance: 0 },
      { id: 'b', name: 'Coke', tracked: true, balance: 50 },
    ])
    const result = await checkStockSufficiency(db, 'r1', [line('a', 'Biltong'), line('b', 'Coke')])
    if (result.ok) throw new Error('unreachable')
    expect(result.unavailable.map((u) => u.itemName)).toEqual(['Biltong'])
    expect(result.reason).not.toContain('Coke')
  })

  it('does not repeat an item that appears on more than one line', async () => {
    const db = scenario([{ id: 'a', name: 'Biltong', tracked: true, balance: 0 }])
    const result = await checkStockSufficiency(db, 'r1', [line('a', 'Biltong'), line('a', 'Biltong')])
    if (result.ok) throw new Error('unreachable')
    expect(result.unavailable).toHaveLength(1)
  })

  it('ignores untracked items entirely, even at zero stock', async () => {
    const db = scenario([{ id: 'a', name: 'Sugar sachet', tracked: false, balance: 0 }])
    const result = await checkStockSufficiency(db, 'r1', [line('a', 'Sugar sachet')])
    expect(result.ok).toBe(true)
  })

  it('never leaks a uuid or a raw column name into the message', async () => {
    const db = scenario([{ id: 'a', name: 'Biltong', tracked: true, balance: 0 }])
    const result = await checkStockSufficiency(db, 'r1', [line('a', 'Biltong')])
    if (result.ok) throw new Error('unreachable')
    expect(result.reason).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}/i)
    expect(result.reason).not.toMatch(/track_inventory|stock_item|quantity_delta/)
  })
})
