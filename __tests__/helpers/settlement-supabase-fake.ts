/**
 * A Supabase fake for the routes that settle a gateway-confirmed whole-order payment.
 *
 * NOT A TEST FILE. Named without `.test.ts` so Jest's testMatch does not collect it as a suite
 * with no assertions in it.
 *
 * ==================================================================================================
 * WHY ONE SHARED FAKE
 * ==================================================================================================
 *
 * Before the 2026-09-19 hardening every webhook suite carried its own three-line `from('orders')`
 * stub, because the route did its own per-order reads and writes. Those stubs encoded the OLD
 * architecture -- one order in, one `markOrderPaidConfirmed` out -- so the moment the settlement
 * became a single atomic RPC over a whole target set, six suites broke in six slightly different
 * ways and each had to be re-derived.
 *
 * This fake models what the new path actually touches:
 *
 *   from('orders').select(...).in('id', ids)[.eq('restaurant_id', r)]      the target resolution
 *   from('orders').select(...).in('pending_settlement_id', ids).eq(...)    the expansion
 *   from('audit_logs').insert(row)                                          refusals
 *   rpc('settle_order_payment', args)                                       the settlement
 *
 * `rpc` is recorded rather than executed: what the function DOES is proved against a real
 * Postgres by supabase/tests/run-db-tests.mjs, where it can be. What these suites prove is what
 * the ROUTE hands it -- above all that the ids it passes are the whole target set and not a
 * subset, which is the Riviera defect and is a property of the caller.
 */

export type Row = Record<string, unknown>

export type RpcCall = { fn: string; args: Row }

export type FakeState = {
  /** Orders the fake will return, keyed by id. */
  orders: Map<string, Row>
  auditInserts: Row[]
  rpcCalls: RpcCall[]
  /** What `settle_order_payment` should return. Defaults to a successful full settlement. */
  rpcResult: (args: Row) => Row
  /** Set to force the orders read to fail, for the fail-closed assertions. */
  ordersReadError: { message: string } | null
}

export function createFakeState(): FakeState {
  return {
    orders: new Map(),
    auditInserts: [],
    rpcCalls: [],
    ordersReadError: null,
    rpcResult: (args: Row) => {
      const ids = (args.p_order_ids as string[]) ?? []
      return {
        ok: true,
        reason: 'settled',
        applied: true,
        claimed_order_ids: ids,
        intended_order_ids: ids,
        expected_amount_cents: args.p_expected_amount_cents,
        gateway_amount_cents: args.p_gateway_amount_cents,
        payment_method: args.p_payment_method,
        ledger_row_written: true,
      }
    },
  }
}

/**
 * An order row shaped the way `TARGET_ORDER_COLUMNS` selects it.
 *
 * `pending_charge_cents` defaults to the order total in cents, because that is what
 * prepare-payment records and because leaving it null silently routes every test through
 * `expectedChargeFor`'s legacy fallback -- which would make a suite pass for the wrong reason.
 */
export function order(
  id: string,
  total: number,
  overrides: Row = {},
): Row {
  return {
    id,
    restaurant_id: 'rest-1',
    tab_id: 'tab-1',
    total,
    payment_status: 'pending',
    payment_method: 'cash',
    cancellation_reason: null,
    cancelled_at: null,
    pending_charge_cents: Math.round(total * 100),
    pending_tip_cents: 0,
    pending_settlement_id: null,
    ...overrides,
  }
}

/**
 * A chainable query stub. Every filter narrows `rows`; awaiting it yields what is left, so the
 * fake enforces the same scoping the real client would instead of ignoring the filters.
 */
function query(rows: Row[], state: FakeState) {
  const api: Record<string, unknown> = {}
  let current = rows

  const chain = {
    select: () => chain,
    eq: (col: string, value: unknown) => {
      current = current.filter((r) => String(r[col] ?? '') === String(value))
      return chain
    },
    in: (col: string, values: unknown[]) => {
      const want = new Set(values.map(String))
      current = current.filter((r) => want.has(String(r[col] ?? '')))
      return chain
    },
    is: (col: string, value: unknown) => {
      current = current.filter((r) => (value === null ? r[col] == null : r[col] === value))
      return chain
    },
    then: (resolve: (v: { data: Row[] | null; error: unknown }) => unknown) =>
      resolve(
        state.ordersReadError
          ? { data: null, error: state.ordersReadError }
          : { data: current, error: null },
      ),
  }
  Object.assign(api, chain)
  return chain
}

export function createFakeClient(state: FakeState) {
  return {
    from: (table: string) => {
      if (table === 'orders') {
        const rows = [...state.orders.values()]
        return {
          select: () => query(rows, state),
          update: () => ({
            in: () => ({ is: async () => ({ error: null }) }),
            eq: () => ({ eq: async () => ({ error: null }) }),
          }),
        }
      }
      if (table === 'audit_logs') {
        return {
          insert: async (row: Row) => {
            state.auditInserts.push(row)
            return { error: null }
          },
        }
      }
      throw new Error(`settlement fake: unexpected table ${table}`)
    },
    rpc: async (fn: string, args: Row) => {
      state.rpcCalls.push({ fn, args })
      if (fn !== 'settle_order_payment') {
        throw new Error(`settlement fake: unexpected rpc ${fn}`)
      }
      return { data: state.rpcResult(args), error: null }
    },
  }
}

/** The ids the route asked `settle_order_payment` to settle. The Riviera assertion reads this. */
export function settledOrderIds(state: FakeState): string[] {
  const call = state.rpcCalls.find((c) => c.fn === 'settle_order_payment')
  return call ? ((call.args.p_order_ids as string[]) ?? []).map(String) : []
}
