/**
 * ADR-005 §1 and §2 — the rulings a later refactor is most likely to undo by accident.
 *
 * Each of these looks like a bug to someone reading the code cold, and "tidying" any of them
 * silently breaks service:
 *
 *   1. A null route_to becomes 'unrouted', NOT 'kitchen'. The repo's existing helper does the
 *      opposite, deliberately, and the two must be allowed to disagree. The contrast is asserted
 *      directly so nobody unifies them without reading why.
 *   2. A 'both' item is ONE line with TWO states. An earlier draft made it two lines; that got
 *      independent bumping right and made a cancel have to find both rows while any sum counted
 *      the item twice. There is a regression guard below.
 *   3. Ready means EVERY OWNING station has marked it. A 'both' line with only the kitchen done
 *      is NOT ready, and getting that backwards sends half a plate out.
 *   4. order_lines carry NO money. Money has one home; a second copy is the one that goes stale.
 *
 * PROOF CEILING: UNIT. These prove what the builder produces from a given menu shape. They say
 * nothing about whether production's route_to values are correct — which is exactly the question
 * ADR-005 rules must be answered by Riviera against a report, not by this code.
 */
import {
  buildOrderLines,
  findInvalidLineNoteIndex,
  initialStatesFor,
  isLineReady,
  isStationOutstanding,
  routeToForLine,
  stationsOwnedBy,
  writeOrderLines,
} from '@/lib/orders/order-lines'
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

describe('routeToForLine — frozen at creation, and it refuses to guess', () => {
  it('recognises the three real values', () => {
    expect(routeToForLine('kitchen')).toBe('kitchen')
    expect(routeToForLine('bar')).toBe('bar')
    expect(routeToForLine('both')).toBe('both')
  })

  it('tolerates casing and whitespace, because a category was configured by a human', () => {
    expect(routeToForLine('  BOTH ')).toBe('both')
    expect(routeToForLine('Bar')).toBe('bar')
  })

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['empty string', ''],
    ['whitespace', '   '],
    ['an unrecognised value', 'grill'],
    ['a number', 7],
  ])('sends %s to unrouted and NEVER to kitchen', (_label, value) => {
    expect(routeToForLine(value)).toBe('unrouted')
  })

  /**
   * THE ASSERTION THAT PROTECTS THE RULING. If someone "fixes the inconsistency" by pointing
   * this module at normalizeRouteTo, this test fails and tells them why the divergence exists.
   */
  it('deliberately disagrees with normalizeRouteTo, which defaults null to kitchen', () => {
    expect(normalizeRouteTo(null)).toBe('kitchen')
    expect(normalizeRouteTo('grill')).toBe('kitchen')

    expect(routeToForLine(null)).toBe('unrouted')
    expect(routeToForLine('grill')).toBe('unrouted')
  })
})

describe('station ownership and initial state', () => {
  it('populates a state only for the stations that own the line', () => {
    expect(initialStatesFor('kitchen')).toEqual({ kitchen_state: 'outstanding', bar_state: null })
    expect(initialStatesFor('bar')).toEqual({ kitchen_state: null, bar_state: 'outstanding' })
    expect(initialStatesFor('both')).toEqual({
      kitchen_state: 'outstanding',
      bar_state: 'outstanding',
    })
  })

  it('gives an unrouted line to BOTH stations, because it shows on both screens', () => {
    expect(stationsOwnedBy('unrouted')).toEqual(['kitchen', 'bar'])
    expect(initialStatesFor('unrouted')).toEqual({
      kitchen_state: 'outstanding',
      bar_state: 'outstanding',
    })
  })
})

describe('isLineReady — READY means the pass passed it, not that the station cooked it', () => {
  it('a kitchen-only line is ready once the pass marks it, and the null bar cannot block it', () => {
    expect(isLineReady({ kitchen_state: 'ready', bar_state: null })).toBe(true)
  })

  it('a kitchen-only line is not ready while the kitchen is outstanding', () => {
    expect(isLineReady({ kitchen_state: 'outstanding', bar_state: null })).toBe(false)
  })

  /**
   * THE POINT OF THE FOUR-STATE VOCABULARY. A plated dish waiting on the pass is not ready to
   * run. If this ever returns true, the pass has been designed out again and a waiter will carry
   * food nobody passed.
   */
  it('COOKED IS NOT READY — a plated dish waiting on the pass must not read as ready', () => {
    expect(isLineReady({ kitchen_state: 'cooked', bar_state: null })).toBe(false)
    expect(isLineReady({ kitchen_state: 'cooked', bar_state: 'ready' })).toBe(false)
  })

  /** Half a plate must not go out. */
  it('a both line is NOT ready when only one station has been passed', () => {
    expect(isLineReady({ kitchen_state: 'ready', bar_state: 'outstanding' })).toBe(false)
    expect(isLineReady({ kitchen_state: 'ready', bar_state: 'cooked' })).toBe(false)
  })

  it('a both line is ready only once both stations have been passed', () => {
    expect(isLineReady({ kitchen_state: 'ready', bar_state: 'ready' })).toBe(true)
  })
})

describe('isStationOutstanding — what the board still shows', () => {
  it('shows outstanding AND cooked, because a cooked dish is still the station’s business', () => {
    expect(isStationOutstanding('outstanding')).toBe(true)
    expect(isStationOutstanding('cooked')).toBe(true)
  })

  it('hides ready and voided', () => {
    expect(isStationOutstanding('ready')).toBe(false)
    expect(isStationOutstanding('voided')).toBe(false)
  })

  it('a station that does not own the line is not outstanding at it', () => {
    expect(isStationOutstanding(null)).toBe(false)
    expect(isStationOutstanding(undefined)).toBe(false)
  })
})

describe('buildOrderLines', () => {
  /** REGRESSION GUARD against the earlier two-row draft. */
  it("makes ONE line for a 'both' item, carrying two independent states", async () => {
    const supabase = fakeSupabase({
      menuItems: [{ id: 'm1', category_id: 'c1' }],
      categories: [{ id: 'c1', route_to: 'both' }],
    })

    const lines = await buildOrderLines(supabase, {
      ...BASE,
      items: [{ menuItemId: 'm1', name: 'Espresso Martini', quantity: 1 }],
    })

    expect(lines).toHaveLength(1)
    expect(lines[0].route_to).toBe('both')
    expect(lines[0].kitchen_state).toBe('outstanding')
    expect(lines[0].bar_state).toBe('outstanding')
  })

  it('produces exactly one line per item, so the bill and the pass agree on the count', async () => {
    const supabase = fakeSupabase({
      menuItems: [
        { id: 'a', category_id: 'cBoth' },
        { id: 'b', category_id: 'cKitchen' },
        { id: 'c', category_id: 'cBar' },
      ],
      categories: [
        { id: 'cBoth', route_to: 'both' },
        { id: 'cKitchen', route_to: 'kitchen' },
        { id: 'cBar', route_to: 'bar' },
      ],
    })

    const lines = await buildOrderLines(supabase, {
      ...BASE,
      items: [
        { menuItemId: 'a', name: 'Sharing platter', quantity: 1 },
        { menuItemId: 'b', name: 'Burger', quantity: 1 },
        { menuItemId: 'c', name: 'Coke', quantity: 1 },
      ],
    })

    expect(lines).toHaveLength(3)
    expect(lines.map((l) => l.source_item_index)).toEqual([0, 1, 2])
  })

  it('leaves the non-owning station NULL so it cannot hold the plate back', async () => {
    const supabase = fakeSupabase({
      menuItems: [{ id: 'm1', category_id: 'c1' }],
      categories: [{ id: 'c1', route_to: 'kitchen' }],
    })

    const lines = await buildOrderLines(supabase, {
      ...BASE,
      items: [{ menuItemId: 'm1', name: 'Steak', quantity: 1 }],
    })

    expect(lines[0].kitchen_state).toBe('outstanding')
    expect(lines[0].bar_state).toBeNull()
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

      expect(lines[0].route_to).toBe('unrouted')
      // Owned by both, so either station can clear it once someone works out what it is.
      expect(lines[0].kitchen_state).toBe('outstanding')
      expect(lines[0].bar_state).toBe('outstanding')
    })

    it('an item with no menu item id at all', async () => {
      const lines = await buildOrderLines(fakeSupabase({}), {
        ...BASE,
        items: [{ name: 'Off-menu special', quantity: 1 }],
      })

      expect(lines[0].route_to).toBe('unrouted')
      expect(lines[0].menu_item_id).toBeNull()
    })

    it('a FAILED menu_items read — the round still goes through, unrouted', async () => {
      const lines = await buildOrderLines(
        fakeSupabase({ menuItemsError: { message: 'connection reset' } }),
        { ...BASE, items: [{ menuItemId: 'm1', name: 'Steak', quantity: 1 }] },
      )

      // Not thrown, not dropped, not kitchen. The customer's order is taken and the failure is
      // visible on both screens.
      expect(lines).toHaveLength(1)
      expect(lines[0].route_to).toBe('unrouted')
    })

    it('a FAILED menu_categories read', async () => {
      const lines = await buildOrderLines(
        fakeSupabase({
          menuItems: [{ id: 'm1', category_id: 'c1' }],
          categoriesError: { message: 'timeout' },
        }),
        { ...BASE, items: [{ menuItemId: 'm1', name: 'Steak', quantity: 1 }] },
      )

      expect(lines[0].route_to).toBe('unrouted')
    })
  })

  it('returns nothing for an empty round rather than inventing a line', async () => {
    expect(await buildOrderLines(fakeSupabase({}), { ...BASE, items: [] })).toEqual([])
  })
})

/**
 * line_note is a TEXT column and Postgres coerces rather than refusing, so an object lands as the
 * literal "[object Object]" and a cook reads that off the pass. Dropping it silently is worse
 * still: the steak comes out wrong and nothing recorded that a note was ever sent.
 */
describe('findInvalidLineNoteIndex — a note that is not text refuses the round', () => {
  it.each([
    ['an object', { text: 'medium' }],
    ['an array', ['medium']],
    ['a nested object', { note: { text: 'medium' } }],
  ])('flags %s', (_label, note) => {
    expect(findInvalidLineNoteIndex([{ menuItemId: 'm1', note }])).toBe(0)
  })

  it('names the offending index, not just that something is wrong', () => {
    expect(
      findInvalidLineNoteIndex([
        { menuItemId: 'a', note: 'medium' },
        { menuItemId: 'b' },
        { menuItemId: 'c', note: { text: 'well done' } },
      ]),
    ).toBe(2)
  })

  it('accepts strings, numbers, absent and null notes', () => {
    expect(
      findInvalidLineNoteIndex([
        { menuItemId: 'a', note: 'medium' },
        { menuItemId: 'b', note: 3 },
        { menuItemId: 'c', note: null },
        { menuItemId: 'd' },
      ]),
    ).toBeNull()
  })

  it('catches the alternate note spellings too, not just `note`', () => {
    expect(findInvalidLineNoteIndex([{ menuItemId: 'a', specialInstructions: { t: 'x' } }])).toBe(0)
    expect(findInvalidLineNoteIndex([{ menuItemId: 'a', line_note: ['x'] }])).toBe(0)
  })

  it('never coerces an object into a note', async () => {
    const supabase = fakeSupabase({
      menuItems: [{ id: 'm1', category_id: 'c1' }],
      categories: [{ id: 'c1', route_to: 'kitchen' }],
    })

    const lines = await buildOrderLines(supabase, {
      ...BASE,
      items: [{ menuItemId: 'm1', name: 'Steak', quantity: 1, note: { text: 'medium' } }],
    })

    // The route refuses this shape before it reaches here; if it ever does reach here, the note
    // must be null and must NEVER be the string "[object Object]".
    expect(lines[0].line_note).toBeNull()
    expect(lines[0].line_note).not.toBe('[object Object]')
  })

  it('stringifies a numeric note rather than dropping it', async () => {
    const supabase = fakeSupabase({
      menuItems: [{ id: 'm1', category_id: 'c1' }],
      categories: [{ id: 'c1', route_to: 'kitchen' }],
    })

    const lines = await buildOrderLines(supabase, {
      ...BASE,
      items: [{ menuItemId: 'm1', name: 'Steak', quantity: 1, note: 3 }],
    })

    expect(lines[0].line_note).toBe('3')
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
                        : (rows as Array<{ route_to: string }>).map((r, i) => ({
                            id: `line-${i}`,
                            route_to: r.route_to,
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
    route_to: 'kitchen' as const,
    kitchen_state: 'outstanding' as const,
    bar_state: null,
  }

  it('writes ONE creation event for a single-station line', async () => {
    const { client, captured } = insertCapturingSupabase()

    await writeOrderLines(client, [LINE], { actorKind: 'terminal', actorUserId: 'u1' })

    expect(captured.order_line_events).toHaveLength(1)
    expect(captured.order_line_events[0]).toMatchObject({
      station: 'kitchen',
      from_state: null,
      to_state: 'outstanding',
      actor_kind: 'terminal',
      actor_user_id: 'u1',
    })
  })

  it("writes TWO creation events for a 'both' line, one per station it owns", async () => {
    const { client, captured } = insertCapturingSupabase()

    await writeOrderLines(
      client,
      [{ ...LINE, route_to: 'both' as const, bar_state: 'outstanding' as const }],
      { actorKind: 'terminal', actorUserId: 'u1' },
    )

    expect(captured.order_line_events).toHaveLength(2)
    expect(
      (captured.order_line_events as Array<{ station: string }>).map((e) => e.station).sort(),
    ).toEqual(['bar', 'kitchen'])
  })

  it('counts a both line to both screens, and an unrouted line to all three', async () => {
    const { client } = insertCapturingSupabase()

    const result = await writeOrderLines(
      client,
      [
        LINE,
        { ...LINE, route_to: 'bar' as const, kitchen_state: null, bar_state: 'outstanding' as const },
        { ...LINE, route_to: 'both' as const, bar_state: 'outstanding' as const },
        { ...LINE, route_to: 'unrouted' as const, bar_state: 'outstanding' as const },
      ],
      { actorKind: 'terminal', actorUserId: 'u1' },
    )

    expect(result.lineCount).toBe(4)
    // kitchen: kitchen + both + unrouted = 3. bar: bar + both + unrouted = 3. unrouted: 1.
    expect(result.stationCounts).toEqual({ kitchen: 3, bar: 3, unrouted: 1 })
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
