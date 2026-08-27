/**
 * ADR-005 §1 and §2 — the rulings that a later refactor is most likely to undo by accident.
 *
 * Three of them are asserted here because each one LOOKS like a bug to someone reading the code
 * cold, and "tidying" any of them silently breaks service:
 *
 *   1. A null route_to becomes 'unrouted', NOT 'kitchen'. The repo's existing helper does the
 *      opposite, deliberately, and the two must be allowed to disagree. The contrast is asserted
 *      directly so nobody unifies them without reading why.
 *   2. A 'both' item becomes TWO lines. Looks like duplication. Is not.
 *   3. order_lines carry NO money. Looks like an omission. Is a refusal — one billed item can be
 *      two lines, so a sum over them double-charges.
 *
 * PROOF CEILING: UNIT. These prove what the builder produces from a given menu shape. They say
 * nothing about whether production's route_to values are correct — which is exactly the question
 * ADR-005 rules must be answered by Riviera against a report, not by this code.
 */
import { buildOrderLines, stationsForRouteTo, writeOrderLines } from '@/lib/orders/order-lines'
import { normalizeRouteTo } from '@/lib/order-routing'

type MenuItemRow = { id: string; category_id: string | null }
type CategoryRow = { id: string; route_to: unknown }

function fakeSupabase(config: {
  menuItems?: MenuItemRow[]
  categories?: CategoryRow[]
  menuItemsError?: unknown
  categoriesError?: unknown
}) {
  return {
    from(table: string) {
      return {
        select() {
          return {
            in() {
              if (table === 'menu_items') {
                return Promise.resolve({
                  data: config.menuItemsError ? null : (config.menuItems ?? []),
                  error: config.menuItemsError ?? null,
                })
              }
              if (table === 'menu_categories') {
                return Promise.resolve({
                  data: config.categoriesError ? null : (config.categories ?? []),
                  error: config.categoriesError ?? null,
                })
              }
              return Promise.resolve({ data: [], error: null })
            },
          }
        },
      }
    },
  }
}

const BASE = { restaurantId: 'r1', orderId: 'o1', tabId: 't1' }

describe('stationsForRouteTo — the fan-out and the refusal to guess', () => {
  it('routes the three known values', () => {
    expect(stationsForRouteTo('kitchen')).toEqual(['kitchen'])
    expect(stationsForRouteTo('bar')).toEqual(['bar'])
    expect(stationsForRouteTo('both')).toEqual(['kitchen', 'bar'])
  })

  it('tolerates casing and whitespace, because a category name was typed by a human', () => {
    expect(stationsForRouteTo('  BOTH ')).toEqual(['kitchen', 'bar'])
    expect(stationsForRouteTo('Bar')).toEqual(['bar'])
  })

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['empty string', ''],
    ['whitespace', '   '],
    ['an unrecognised value', 'grill'],
    ['a number', 7],
  ])('sends %s to unrouted and NEVER to kitchen', (_label, value) => {
    expect(stationsForRouteTo(value)).toEqual(['unrouted'])
  })

  /**
   * THE ASSERTION THAT PROTECTS THE RULING. If someone "fixes the inconsistency" by pointing
   * this module at normalizeRouteTo, this test fails and tells them why the divergence exists.
   */
  it('deliberately disagrees with normalizeRouteTo, which defaults null to kitchen', () => {
    expect(normalizeRouteTo(null)).toBe('kitchen')
    expect(normalizeRouteTo('grill')).toBe('kitchen')

    expect(stationsForRouteTo(null)).toEqual(['unrouted'])
    expect(stationsForRouteTo('grill')).toEqual(['unrouted'])
  })
})

describe('buildOrderLines', () => {
  it("fans a 'both' item into two independently bumpable lines sharing one source index", async () => {
    const supabase = fakeSupabase({
      menuItems: [{ id: 'm1', category_id: 'c1' }],
      categories: [{ id: 'c1', route_to: 'both' }],
    })

    const lines = await buildOrderLines(supabase, {
      ...BASE,
      items: [{ menuItemId: 'm1', name: 'Espresso Martini', quantity: 1 }],
    })

    expect(lines).toHaveLength(2)
    expect(lines.map((l) => l.station).sort()).toEqual(['bar', 'kitchen'])
    // One billed item -> one index, carried by both lines. This is the join back to money, and
    // it is what makes the double-count detectable instead of silent.
    expect(new Set(lines.map((l) => l.source_item_index))).toEqual(new Set([0]))
  })

  it('carries no monetary field on any line, by construction', async () => {
    const supabase = fakeSupabase({
      menuItems: [{ id: 'm1', category_id: 'c1' }],
      categories: [{ id: 'c1', route_to: 'both' }],
    })

    const lines = await buildOrderLines(supabase, {
      ...BASE,
      items: [{ menuItemId: 'm1', name: 'Steak', quantity: 2, price: 189, total: 378 }],
    })

    for (const line of lines) {
      for (const forbidden of ['price', 'total', 'subtotal', 'tax', 'amount', 'unit_price']) {
        expect(line).not.toHaveProperty(forbidden)
      }
    }
  })

  it('keeps quantity on ONE line rather than exploding into N bumpable rows', async () => {
    const supabase = fakeSupabase({
      menuItems: [{ id: 'm1', category_id: 'c1' }],
      categories: [{ id: 'c1', route_to: 'kitchen' }],
    })

    const lines = await buildOrderLines(supabase, {
      ...BASE,
      items: [{ menuItemId: 'm1', name: 'Steak', quantity: 3 }],
    })

    expect(lines).toHaveLength(1)
    expect(lines[0].quantity).toBe(3)
  })

  it('carries the per-line note the kitchen actually needs', async () => {
    const supabase = fakeSupabase({
      menuItems: [{ id: 'm1', category_id: 'c1' }],
      categories: [{ id: 'c1', route_to: 'kitchen' }],
    })

    const lines = await buildOrderLines(supabase, {
      ...BASE,
      items: [{ menuItemId: 'm1', name: 'Steak', quantity: 1, note: 'medium' }],
    })

    expect(lines[0].line_note).toBe('medium')
  })

  it('splits a mixed order so each station sees only its own lines', async () => {
    const supabase = fakeSupabase({
      menuItems: [
        { id: 'food', category_id: 'cFood' },
        { id: 'drink', category_id: 'cBar' },
      ],
      categories: [
        { id: 'cFood', route_to: 'kitchen' },
        { id: 'cBar', route_to: 'bar' },
      ],
    })

    const lines = await buildOrderLines(supabase, {
      ...BASE,
      items: [
        { menuItemId: 'food', name: 'Burger', quantity: 1 },
        { menuItemId: 'drink', name: 'Coke', quantity: 2 },
      ],
    })

    expect(lines.filter((l) => l.station === 'kitchen').map((l) => l.name_snapshot)).toEqual([
      'Burger',
    ])
    expect(lines.filter((l) => l.station === 'bar').map((l) => l.name_snapshot)).toEqual(['Coke'])
  })

  describe('everything unroutable becomes visible rather than quietly landing in the kitchen', () => {
    it('an item whose category route_to is null', async () => {
      const supabase = fakeSupabase({
        menuItems: [{ id: 'm1', category_id: 'c1' }],
        categories: [{ id: 'c1', route_to: null }],
      })

      const lines = await buildOrderLines(supabase, {
        ...BASE,
        items: [{ menuItemId: 'm1', name: 'Mystery', quantity: 1 }],
      })

      expect(lines).toHaveLength(1)
      expect(lines[0].station).toBe('unrouted')
    })

    it('an item with no menu item id at all', async () => {
      const supabase = fakeSupabase({})

      const lines = await buildOrderLines(supabase, {
        ...BASE,
        items: [{ name: 'Off-menu special', quantity: 1 }],
      })

      expect(lines[0].station).toBe('unrouted')
      expect(lines[0].menu_item_id).toBeNull()
    })

    it('a FAILED menu_items read — the round still goes through, unrouted', async () => {
      const supabase = fakeSupabase({
        menuItemsError: { message: 'connection reset' },
      })

      const lines = await buildOrderLines(supabase, {
        ...BASE,
        items: [{ menuItemId: 'm1', name: 'Steak', quantity: 1 }],
      })

      // Not thrown, not dropped, not kitchen. The customer's order is taken and the failure is
      // visible on both screens.
      expect(lines).toHaveLength(1)
      expect(lines[0].station).toBe('unrouted')
    })

    it('a FAILED menu_categories read', async () => {
      const supabase = fakeSupabase({
        menuItems: [{ id: 'm1', category_id: 'c1' }],
        categoriesError: { message: 'timeout' },
      })

      const lines = await buildOrderLines(supabase, {
        ...BASE,
        items: [{ menuItemId: 'm1', name: 'Steak', quantity: 1 }],
      })

      expect(lines[0].station).toBe('unrouted')
    })
  })

  it('returns nothing for an empty round rather than inventing a line', async () => {
    expect(await buildOrderLines(fakeSupabase({}), { ...BASE, items: [] })).toEqual([])
  })
})

describe('writeOrderLines', () => {
  function insertCapturingSupabase(opts: { linesError?: unknown; eventsError?: unknown } = {}) {
    const captured: Record<string, unknown[]> = { order_lines: [], order_line_events: [] }
    return {
      captured,
      client: {
        from(table: string) {
          return {
            insert(rows: unknown[]) {
              captured[table] = rows
              if (table === 'order_lines') {
                return {
                  select: () =>
                    Promise.resolve({
                      data: opts.linesError
                        ? null
                        : (rows as Array<{ station: string }>).map((r, i) => ({
                            id: `line-${i}`,
                            station: r.station,
                          })),
                      error: opts.linesError ?? null,
                    }),
                }
              }
              return Promise.resolve({ data: null, error: opts.eventsError ?? null })
            },
          }
        },
      },
    }
  }

  const LINE = {
    restaurant_id: 'r1',
    order_id: 'o1',
    tab_id: 't1',
    source_item_index: 0,
    menu_item_id: 'm1',
    name_snapshot: 'Steak',
    quantity: 1,
    line_note: null,
    station: 'kitchen' as const,
    state: 'outstanding' as const,
  }

  it('writes a creation event per line with from_state NULL', async () => {
    const { client, captured } = insertCapturingSupabase()

    await writeOrderLines(client, [LINE], { actorKind: 'terminal', actorUserId: 'u1' })

    expect(captured.order_line_events).toHaveLength(1)
    expect(captured.order_line_events[0]).toMatchObject({
      from_state: null,
      to_state: 'outstanding',
      actor_kind: 'terminal',
      actor_user_id: 'u1',
    })
  })

  it('counts lines per station so the waiter can be told where the round went', async () => {
    const { client } = insertCapturingSupabase()

    const result = await writeOrderLines(
      client,
      [LINE, { ...LINE, station: 'bar' as const }, { ...LINE, station: 'unrouted' as const }],
      { actorKind: 'terminal', actorUserId: 'u1' },
    )

    expect(result.lineCount).toBe(3)
    expect(result.stationCounts).toEqual({ kitchen: 1, bar: 1, unrouted: 1 })
  })

  it('THROWS when the lines fail, so the caller can refuse the round loudly', async () => {
    const { client } = insertCapturingSupabase({ linesError: { message: 'insert failed' } })

    await expect(
      writeOrderLines(client, [LINE], { actorKind: 'terminal', actorUserId: 'u1' }),
    ).rejects.toBeTruthy()
  })

  it('does NOT throw when only the audit events fail — the food still gets made', async () => {
    const { client } = insertCapturingSupabase({ eventsError: { message: 'events insert failed' } })

    const result = await writeOrderLines(client, [LINE], {
      actorKind: 'terminal',
      actorUserId: 'u1',
    })

    expect(result.lineCount).toBe(1)
  })
})
