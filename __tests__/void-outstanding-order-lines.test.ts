import { voidOutstandingOrderLines } from '@/lib/orders/order-lines'

/**
 * docs/followup-cancelled-order-lines-not-voided.md, 2026-08-28: cancelling an order left its
 * lines at whatever state they were in -- 7 cancelled orders, 16 lines, every kitchen/both line
 * still `outstanding`, indistinguishable from real, live, unstarted work.
 */
const RESTAURANT = 'rest-1'
const ORDER = 'order-1'

type Row = Record<string, unknown>

function makeSupabase(lines: Row[]) {
  const updates: Row[] = []
  const inserted: Row[] = []

  const client = {
    from(table: string) {
      const chain: Record<string, unknown> = {}
      let patch: Row | null = null
      let updateTargetId: string | null = null

      chain.select = () => chain
      chain.eq = (col: string, val: unknown) => {
        if (table === 'order_lines' && patch && col === 'id') updateTargetId = String(val)
        return chain
      }
      chain.insert = (rows: Row | Row[]) => {
        if (table === 'order_line_events') inserted.push(...(Array.isArray(rows) ? rows : [rows]))
        return { error: null }
      }
      chain.update = (next: Row) => {
        patch = next
        return chain
      }
      chain.then = (resolve: (v: unknown) => unknown) => {
        if (table === 'order_lines' && !patch) {
          return Promise.resolve({ data: lines, error: null }).then(resolve)
        }
        if (table === 'order_lines' && patch && updateTargetId) {
          const line = lines.find((l) => l.id === updateTargetId)
          if (line) Object.assign(line, patch)
          updates.push({ id: updateTargetId, ...patch })
        }
        return Promise.resolve({ data: null, error: null }).then(resolve)
      }
      return chain
    },
  }
  return { client: client as never, updates, inserted }
}

describe('voidOutstandingOrderLines', () => {
  it('voids an outstanding kitchen line', async () => {
    const { client, updates, inserted } = makeSupabase([
      { id: 'l1', kitchen_state: 'outstanding', bar_state: null },
    ])

    const result = await voidOutstandingOrderLines(client, {
      orderId: ORDER,
      restaurantId: RESTAURANT,
      actorKind: 'system',
      actorUserId: null,
    })

    expect(result.voidedLineCount).toBe(1)
    expect(updates).toEqual([{ id: 'l1', kitchen_state: 'voided' }])
    expect(inserted).toEqual([
      {
        restaurant_id: RESTAURANT,
        order_line_id: 'l1',
        station: 'kitchen',
        from_state: 'outstanding',
        to_state: 'voided',
        actor_kind: 'system',
        actor_user_id: null,
      },
    ])
  })

  it('voids only the still-outstanding half of a "both" line -- a ready half is untouched', async () => {
    const { client, updates } = makeSupabase([
      { id: 'l1', kitchen_state: 'ready', bar_state: 'cooked' },
    ])

    await voidOutstandingOrderLines(client, {
      orderId: ORDER,
      restaurantId: RESTAURANT,
      actorKind: 'terminal',
      actorUserId: null,
    })

    // Only bar_state changes -- kitchen already reached 'ready' and cancelling afterward must
    // not un-cook a plate the pass already passed.
    expect(updates).toEqual([{ id: 'l1', bar_state: 'voided' }])
  })

  it('a line already ready on both halves is untouched -- no update, no event', async () => {
    const { client, updates, inserted } = makeSupabase([
      { id: 'l1', kitchen_state: 'ready', bar_state: 'ready' },
    ])

    const result = await voidOutstandingOrderLines(client, {
      orderId: ORDER,
      restaurantId: RESTAURANT,
      actorKind: 'system',
      actorUserId: null,
    })

    expect(result.voidedLineCount).toBe(0)
    expect(updates).toHaveLength(0)
    expect(inserted).toHaveLength(0)
  })

  it('a line already voided is untouched -- voiding is not re-applied', async () => {
    const { client, updates } = makeSupabase([
      { id: 'l1', kitchen_state: 'voided', bar_state: null },
    ])

    await voidOutstandingOrderLines(client, {
      orderId: ORDER,
      restaurantId: RESTAURANT,
      actorKind: 'system',
      actorUserId: null,
    })

    expect(updates).toHaveLength(0)
  })

  it('an order with no lines is a no-op, not an error', async () => {
    const { client } = makeSupabase([])

    const result = await voidOutstandingOrderLines(client, {
      orderId: ORDER,
      restaurantId: RESTAURANT,
      actorKind: 'system',
      actorUserId: null,
    })

    expect(result.voidedLineCount).toBe(0)
  })
})
