/**
 * #195 — a settlement write that FAILS must not be followed by marking the tab's orders paid.
 *
 * `lib/supabase/apply-tab-settlement.ts` discarded the result of every write it made. The
 * consequential one is the `tabs` settlement update: PostgREST rejects the whole payload when it
 * names a column that does not exist, so the update wrote NOTHING -- status unchanged, settled_at
 * unset -- and execution continued straight into `markTabOrdersPaid`, which marks every order on
 * the tab paid. Orders paid, tab still open, nothing surfaced to the caller.
 *
 * Two of the columns it named do not exist on `tabs` in either environment, and no migration in
 * supabase/migrations/ defines them:
 *
 *   settlement_type -- ABSENT   (settled_type already carries card_payment / manual_close)
 *   updated_at      -- ABSENT   (nothing on tabs maintains it; baseline has no such column)
 *
 * So the payload assertions below are not style: with either column present the real PostgREST
 * rejects the statement and the settlement silently does nothing.
 *
 * Hermetic: @/lib/supabase/server and @/lib/supabase/restaurants are mocked, no live rows.
 */

const RESTAURANT_UUID = 'a1999166-ddfa-40d1-ad1f-2f01282a1652'
const TAB_ID = '7c2f9a51-3f0e-4a6d-9a3e-1f5c2b8d4e77'
const MEMBER_SESSION = 'member-session-1'

type Op = {
  table: string
  op: 'select' | 'update'
  payload: Record<string, unknown> | null
}

/** Every operation the module performed, in order. */
let ops: Op[] = []
/** Rows returned for `orders` selects. */
let orderRows: Record<string, unknown>[] = []
/** Row returned for the single() read of `tabs`. */
let tabRow: Record<string, unknown> = {}
/**
 * Injects a PostgREST error. Returns an error object for the op it wants to fail, else null --
 * so a test can fail exactly one write and leave the rest working, as reality does.
 */
let failOp: (op: Op) => { message: string; code: string } | null = () => null

jest.mock('@/lib/supabase/restaurants', () => ({
  resolveRestaurantUuid: async (id: string) => id,
}))

jest.mock('@/lib/supabase/server', () => ({
  createServerSupabaseClient: () => ({
    from: (table: string) => {
      const state: Op = { table, op: 'select', payload: null }
      const b: Record<string, unknown> = {}
      const settle = () => {
        ops.push({ ...state })
        const error = failOp(state)
        if (error) return { data: null, error }
        if (state.op === 'update') return { data: null, error: null }
        return { data: state.table === 'orders' ? orderRows : [tabRow], error: null }
      }
      Object.assign(b, {
        select: () => b,
        update: (payload: Record<string, unknown>) => {
          state.op = 'update'
          state.payload = payload
          return b
        },
        eq: () => b,
        neq: () => b,
        in: () => b,
        is: () => b,
        single: async () => {
          ops.push({ ...state })
          const error = failOp(state)
          if (error) return { data: null, error }
          return { data: tabRow, error: null }
        },
        then: (resolve: (v: unknown) => unknown) => resolve(settle()),
      })
      return b
    },
  }),
}))

const PG_ERROR = { message: 'column tabs.settlement_type does not exist', code: '42703' }

async function load() {
  return import('@/lib/supabase/apply-tab-settlement')
}

const ordersUpdated = () => ops.filter((o) => o.table === 'orders' && o.op === 'update')
const tabsUpdated = () => ops.filter((o) => o.table === 'tabs' && o.op === 'update')

beforeEach(() => {
  ops = []
  failOp = () => null
  tabRow = { id: TAB_ID, total: 120 }
  orderRows = [
    { id: 'order-1', total: 60, payment_status: 'pending', member_session_id: MEMBER_SESSION },
    { id: 'order-2', total: 60, payment_status: 'pending', member_session_id: MEMBER_SESSION },
  ]
})

// ------------------------------------------------------------------ full settlement

describe('applyTabSettlementSideEffects — full tab settlement', () => {
  const settle = async () => {
    const { applyTabSettlementSideEffects } = await load()
    return applyTabSettlementSideEffects(RESTAURANT_UUID, {
      tab_settlement_for_tab_id: TAB_ID,
      total: 120,
    })
  }

  it('does NOT mark the orders paid when the tab settlement write fails', async () => {
    failOp = (op) => (op.table === 'tabs' && op.op === 'update' ? PG_ERROR : null)

    await expect(settle()).rejects.toMatchObject({ code: '42703' })

    // The whole point. The tab is still open; nobody may be told these orders are paid.
    expect(ordersUpdated()).toHaveLength(0)
  })

  it('marks the orders paid when the tab settlement write succeeds', async () => {
    // Two-sided: the guard must not make a HEALTHY settlement stop short either.
    await expect(settle()).resolves.toBe('full')
    expect(ordersUpdated()).toHaveLength(2)
  })

  it('writes only columns that exist on tabs', async () => {
    await settle()

    const [update] = tabsUpdated()
    expect(update.payload).toEqual({
      status: 'settled',
      settled_at: expect.any(String),
      settled_type: 'card_payment',
    })
  })

  it('surfaces a failed orders update instead of reporting the settlement as done', async () => {
    failOp = (op) => (op.table === 'orders' && op.op === 'update' ? PG_ERROR : null)

    await expect(settle()).rejects.toMatchObject({ code: '42703' })
  })
})

// ------------------------------------------------------------------ member settlement

describe('applyTabSettlementSideEffects — member settlement', () => {
  const settle = async () => {
    const { applyTabSettlementSideEffects } = await load()
    return applyTabSettlementSideEffects(RESTAURANT_UUID, {
      tab_settlement_for_tab_id: TAB_ID,
      tab_settlement_member_session_id: MEMBER_SESSION,
      total: 120,
    })
  }

  it('surfaces a failed member order update', async () => {
    failOp = (op) => (op.table === 'orders' && op.op === 'update' ? PG_ERROR : null)

    await expect(settle()).rejects.toMatchObject({ code: '42703' })
  })

  it('surfaces a failed tab total write instead of leaving the member paid against an unchanged tab', async () => {
    failOp = (op) => (op.table === 'tabs' && op.op === 'update' ? PG_ERROR : null)

    await expect(settle()).rejects.toMatchObject({ code: '42703' })
  })

  it('decrements the tab total without naming a column tabs does not have', async () => {
    await expect(settle()).resolves.toBe('member')

    const [update] = tabsUpdated()
    expect(update.payload).toEqual({ total: 0 })
  })
})
