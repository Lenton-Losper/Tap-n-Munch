/**
 * SETTLING A PART-ORDER CARD CHARGE — the shared writer, and the webhook branch that uses it.
 *
 * ================================================================================================
 * WHY THIS SUITE HAS A POSITIVE CONTROL AT ITS CENTRE
 * ================================================================================================
 *
 * Owner, on step 5: "that's money written against items by something nobody is watching. Failing-
 * first proof, and I want to see the positive control — a webhook that should settle, settling —
 * not just the refusals."
 *
 * A suite of refusals proves a route says no. It cannot tell a working settlement from a route that
 * settles NOTHING, ever, under any conditions — which would pass every refusal test and lose every
 * split payment silently. So the first thing asserted is that the happy path writes: the RPC is
 * called, with card, with this intent's allocations, and the fully-paid order is closed.
 *
 * ================================================================================================
 * THE RACE IS THE DESIGN, NOT A HAZARD
 * ================================================================================================
 *
 * The device and the webhook both prove the same charge and both call settleAllocationsForIntent.
 * `settle_order_line_allocations` claims each allocation and refuses one already settled, so the
 * loser applies nothing and is told so. "Nothing applied because it was already settled" is a
 * SUCCESS; "nothing applied for another reason" is a failure. Getting those two the wrong way round
 * would either double-settle or tell a waiter a real charge failed.
 */
import { settleAllocationsForIntent } from '@/lib/payments/settle-allocations-for-intent'
import type { PaymentIntent } from '@/lib/payments/payment-intents'

type Row = Record<string, unknown>

const intent = (over: Partial<PaymentIntent> = {}): PaymentIntent => ({
  id: 'intent-1',
  merchantOrderNo: 'FT-SPLIT-1',
  amountCents: 4750,
  scope: 'allocations',
  orderIds: [],
  allocationIds: ['a1', 'a2'],
  status: 'launched',
  restaurantId: 'r1',
  tabId: 'tab1',
  ...over,
})

/**
 * Records every RPC call and every write, so what is asserted is what the function DID rather than
 * what it returned.
 */
function fake(opts: {
  applied?: Array<{ allocation_id: string; amount_cents: number }>
  refused?: Array<{ allocation_id: string; reason: string }>
  rpcError?: string
  fullyPaid?: Record<string, boolean>
  fullyPaidError?: boolean
  allocationRows?: Row[]
  allocationReadError?: boolean
  calls?: Array<{ fn: string; args: unknown }>
  writes?: Array<{ table: string; patch: Row }>
}) {
  const calls = opts.calls ?? []
  const writes = opts.writes ?? []

  return {
    calls,
    writes,
    async rpc(fn: string, args: Record<string, unknown>) {
      calls.push({ fn, args })
      if (fn === 'settle_order_line_allocations') {
        if (opts.rpcError) return { data: null, error: { message: opts.rpcError } }
        return {
          data: { applied: opts.applied ?? [], refused: opts.refused ?? [] },
          error: null,
        }
      }
      if (fn === 'order_is_fully_paid_by_allocations') {
        if (opts.fullyPaidError) return { data: null, error: { message: 'check failed' } }
        return { data: opts.fullyPaid?.[String(args.p_order_id)] ?? false, error: null }
      }
      return { data: null, error: null }
    },
    from(table: string) {
      let pending: Row | null = null
      let isWrite = false
      const b: Record<string, unknown> = {
        select: () => b,
        update: (patch: Row) => {
          isWrite = true
          pending = patch
          return b
        },
        eq: () => b,
        not: () => b,
        in: () => b,
        then(resolve: (v: unknown) => unknown) {
          if (isWrite) {
            if (pending) writes.push({ table, patch: pending })
            return Promise.resolve({ data: [{ id: 'closed' }], error: null }).then(resolve)
          }
          if (table === 'order_line_allocations' && opts.allocationReadError) {
            return Promise.resolve({ data: null, error: { message: 'read failed' } }).then(resolve)
          }
          return Promise.resolve({
            data: opts.allocationRows ?? [{ id: 'a1', order_id: 'order-7' }, { id: 'a2', order_id: 'order-7' }],
            error: null,
          }).then(resolve)
        },
      }
      return b
    },
  } as never
}

describe('THE POSITIVE CONTROL — a charge that should settle, settling', () => {
  it('settles the intent\'s allocations, as card, and closes the order that is now fully paid', async () => {
    const calls: Array<{ fn: string; args: unknown }> = []
    const writes: Array<{ table: string; patch: Row }> = []
    const db = fake({
      applied: [
        { allocation_id: 'a1', amount_cents: 2500 },
        { allocation_id: 'a2', amount_cents: 2250 },
      ],
      fullyPaid: { 'order-7': true },
      calls,
      writes,
    })

    const result = await settleAllocationsForIntent(db, {
      intent: intent(),
      paymentReference: 'FT-SPLIT-1',
      source: 'test',
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return

    // It actually settled, and it settled THESE items.
    expect(result.settledAllocationIds.sort()).toEqual(['a1', 'a2'])

    const settleCall = calls.find((c) => c.fn === 'settle_order_line_allocations')
    expect(settleCall).toBeDefined()
    const args = settleCall!.args as Record<string, unknown>
    expect(args.p_allocation_ids).toEqual(['a1', 'a2'])
    expect(args.p_method).toBe('card')
    expect(args.p_payment_reference).toBe('FT-SPLIT-1')
    expect(args.p_restaurant_id).toBe('r1')

    // And the order it completed is closed, with card and this reference on it.
    expect(result.ordersClosed).toEqual(['order-7'])
    const orderWrite = writes.find((w) => w.table === 'orders')
    expect(orderWrite).toBeDefined()
    expect(orderWrite!.patch.payment_status).toBe('paid')
    expect(orderWrite!.patch.payment_method).toBe('card')
    expect(orderWrite!.patch.status).toBe('completed')
  })

  it('names no staff member on the ledger row', async () => {
    /**
     * On the cash path that column holds the person whose PIN was verified. A card charge has no
     * such person — the customer authorised it at the reader — and writing the waiter there would
     * put a name on an append-only row saying they took money they never handled.
     */
    const calls: Array<{ fn: string; args: unknown }> = []
    await settleAllocationsForIntent(
      fake({ applied: [{ allocation_id: 'a1', amount_cents: 4750 }], calls }),
      { intent: intent({ allocationIds: ['a1'] }), paymentReference: 'FT-1', source: 'test' },
    )
    const args = calls.find((c) => c.fn === 'settle_order_line_allocations')!.args as Record<string, unknown>
    expect(args.p_staff_user_id).toBeNull()
  })
})

describe('an order that is NOT yet fully paid stays open', () => {
  it('settles the items and closes nothing', async () => {
    /**
     * The case the whole feature exists for: customer one pays for their items, customer four is
     * still ordering. The order simply never becomes fully paid, so nothing tries to close it.
     */
    const writes: Array<{ table: string; patch: Row }> = []
    const result = await settleAllocationsForIntent(
      fake({
        applied: [{ allocation_id: 'a1', amount_cents: 2500 }],
        fullyPaid: { 'order-7': false },
        writes,
      }),
      { intent: intent({ allocationIds: ['a1'] }), paymentReference: 'FT-1', source: 'test' },
    )

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.settledAllocationIds).toEqual(['a1'])
    expect(result.ordersClosed).toEqual([])
    expect(writes.filter((w) => w.table === 'orders')).toEqual([])
  })

  it('a failed fully-paid check skips the order rather than closing it', async () => {
    // Not knowing whether an order is fully paid is not permission to mark it paid.
    const writes: Array<{ table: string; patch: Row }> = []
    const result = await settleAllocationsForIntent(
      fake({ applied: [{ allocation_id: 'a1', amount_cents: 2500 }], fullyPaidError: true, writes }),
      { intent: intent({ allocationIds: ['a1'] }), paymentReference: 'FT-1', source: 'test' },
    )
    expect(result.ok).toBe(true)
    expect(writes.filter((w) => w.table === 'orders')).toEqual([])
  })
})

describe('the race between the device and the webhook', () => {
  it('the LOSER succeeds, reporting that everything was already settled', async () => {
    /**
     * Both prove the same charge. The RPC claims each allocation and refuses one already settled,
     * so the second caller applies nothing — and that is SUCCESS, because the items are paid.
     * Reporting it as a failure would make the device tell a waiter the charge did not land.
     */
    const result = await settleAllocationsForIntent(
      fake({
        applied: [],
        refused: [
          { allocation_id: 'a1', reason: 'already settled' },
          { allocation_id: 'a2', reason: 'already settled' },
        ],
      }),
      { intent: intent(), paymentReference: 'FT-1', source: 'test' },
    )

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.alreadySettled).toBe(true)
    expect(result.settledAllocationIds).toEqual([])
  })

  it('but nothing-applied for ANY OTHER reason is a failure', async () => {
    // "Already settled" and "refused because the allocation was voided" both apply nothing, and
    // only one of them means the customer's items are paid for.
    const result = await settleAllocationsForIntent(
      fake({ applied: [], refused: [{ allocation_id: 'a1', reason: 'voided' }] }),
      { intent: intent(), paymentReference: 'FT-1', source: 'test' },
    )
    expect(result.ok).toBe(false)
  })

  it('a mix — one already settled, one voided — is a failure', async () => {
    const result = await settleAllocationsForIntent(
      fake({
        applied: [],
        refused: [
          { allocation_id: 'a1', reason: 'already settled' },
          { allocation_id: 'a2', reason: 'voided' },
        ],
      }),
      { intent: intent(), paymentReference: 'FT-1', source: 'test' },
    )
    expect(result.ok).toBe(false)
  })
})

describe('failures do not invent success', () => {
  it('an RPC error is a failure, and settles nothing', async () => {
    const writes: Array<{ table: string; patch: Row }> = []
    const result = await settleAllocationsForIntent(
      fake({ rpcError: 'deadlock detected', writes }),
      { intent: intent(), paymentReference: 'FT-1', source: 'test' },
    )
    expect(result.ok).toBe(false)
    expect(writes.filter((w) => w.table === 'orders')).toEqual([])
  })

  it('an intent naming no allocations is refused before any RPC', async () => {
    const calls: Array<{ fn: string; args: unknown }> = []
    const result = await settleAllocationsForIntent(fake({ calls }), {
      intent: intent({ allocationIds: [] }),
      paymentReference: 'FT-1',
      source: 'test',
    })
    expect(result.ok).toBe(false)
    expect(calls).toEqual([])
  })

  it('an orders-scoped intent is refused — it settles items, not orders', async () => {
    const calls: Array<{ fn: string; args: unknown }> = []
    const result = await settleAllocationsForIntent(fake({ calls }), {
      intent: intent({ scope: 'orders', allocationIds: [], orderIds: ['o1'] }),
      paymentReference: 'FT-1',
      source: 'test',
    })
    expect(result.ok).toBe(false)
    expect(calls).toEqual([])
  })

  it('a failed re-read still reports the money as settled', async () => {
    /**
     * The ledger write already succeeded. Only the closing sweep is affected, and the next
     * settlement on the tab performs it — so reporting failure here would tell a waiter a real
     * charge did not land.
     */
    const result = await settleAllocationsForIntent(
      fake({ applied: [{ allocation_id: 'a1', amount_cents: 2500 }], allocationReadError: true }),
      { intent: intent({ allocationIds: ['a1'] }), paymentReference: 'FT-1', source: 'test' },
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.settledAllocationIds).toEqual(['a1'])
    expect(result.ordersClosed).toEqual([])
  })
})
