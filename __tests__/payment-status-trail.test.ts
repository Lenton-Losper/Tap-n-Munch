import { readFileSync } from 'node:fs'
import {
  recordPaymentStatusChange,
  PAYMENT_STATUS_CHANGED_ACTION,
} from '@/lib/orders/record-payment-status-change'

/**
 * #329 — EVERY payment_status WRITE LEAVES A ROW.
 *
 * The ruling on 2026-08-24 was to trail the transitions where no money moves too, because #329 is
 * not really about N$201 — it is that three orders could not be RECONSTRUCTED. A gap in the middle
 * of a sequence kills an investigation as surely as a gap at the end.
 *
 * Two halves, and the second is the one with teeth:
 *   1. the helper writes what it promises
 *   2. no site under app/api writes payment_status without calling it
 *
 * The second is a source scan on purpose. A test that only exercised the helper would pass forever
 * while a fifth writer was added next to it — which is exactly how `expireHostedPendingOrders` sat
 * untrailed while four other cancel paths were correct.
 */

function fakeSupabase() {
  const inserts: Record<string, unknown>[] = []
  return {
    inserts,
    client: {
      from() {
        return { insert: (row: Record<string, unknown>) => { inserts.push(row); return Promise.resolve({ error: null }) } }
      },
    },
  }
}

describe('the helper records enough to reconstruct a transition', () => {
  it('writes from, to, source and a human note', async () => {
    const { client, inserts } = fakeSupabase()
    const ok = await recordPaymentStatusChange(client as never, {
      orderId: 'order-1',
      restaurantId: 'rest-1',
      from: 'pending',
      to: 'terminal_pending',
      source: 'payments/push-to-terminal',
      note: 'claimed for a push',
    })

    expect(ok).toBe(true)
    expect(inserts).toHaveLength(1)
    const row = inserts[0] as { action: string; entity_id: string; metadata: Record<string, unknown> }
    expect(row.action).toBe(PAYMENT_STATUS_CHANGED_ACTION)
    expect(row.entity_id).toBe('order-1')
    expect(row.metadata.from).toBe('pending')
    expect(row.metadata.to).toBe('terminal_pending')
    expect(row.metadata.source).toBe('payments/push-to-terminal')
    expect(row.metadata.note).toBe('claimed for a push')
    expect(row.metadata.changedAt).toEqual(expect.any(String))
  })

  it('uses an action distinct from order.cancelled', () => {
    // Collapsing them would make "was this order cancelled" a question about metadata again, which
    // is the thing ORDER_CANCELLED_ACTION exists to stop.
    expect(PAYMENT_STATUS_CHANGED_ACTION).not.toBe('order.cancelled')
  })

  it('reports failure instead of throwing', async () => {
    // The status change has already been written by the time this runs. Throwing would report a
    // failure for work that happened.
    const client = { from: () => ({ insert: () => Promise.resolve({ error: { message: 'nope' } }) }) }
    await expect(
      recordPaymentStatusChange(client as never, {
        orderId: 'o', restaurantId: 'r', from: 'a', to: 'b',
        source: 'payments/cancel-terminal', note: 'n',
      }),
    ).resolves.toBe(false)
  })
})

describe('no route writes payment_status without trailing it', () => {
  // Every file that assigns payment_status in an update payload, and the trail it must carry.
  // `orders/[orderId]/status` and the webhook write their own audit rows directly and predate the
  // helper; they are listed with what to look for rather than exempted.
  const WRITERS: { file: string; expect: RegExp }[] = [
    { file: 'app/api/payments/push-to-terminal/route.ts', expect: /recordPaymentStatusChange/ },
    { file: 'app/api/payments/cancel-terminal/route.ts', expect: /recordPaymentStatusChange/ },
    { file: 'app/api/orders/route.ts', expect: /recordPaymentStatusChange/ },
    { file: 'app/api/orders/[orderId]/status/route.ts', expect: /audit_logs/ },
    { file: 'app/api/webhooks/paycloud/route.ts', expect: /audit_logs|payment_events/ },
    { file: 'lib/orders/expire-hosted-pending-orders.ts', expect: /audit_logs/ },
    { file: 'lib/orders/auto-cancel-stale-pos-orders.ts', expect: /audit_logs/ },
    { file: 'lib/orders/cancel-order-with-trail.ts', expect: /audit_logs/ },
    { file: 'lib/payments/handle-terminal-payment-failed.ts', expect: /audit_logs/ },
    { file: 'lib/payments/mark-order-paid-confirmed.ts', expect: /audit_logs/ },
    { file: 'lib/payments/reconcile-orphan-payments.ts', expect: /audit_logs|payment_events/ },
  ]

  it.each(WRITERS)('$file carries a trail', ({ file, expect: pattern }) => {
    expect(readFileSync(file, 'utf8')).toMatch(pattern)
  })

  it('push-to-terminal trails BOTH the claim and the release', () => {
    // The release is the easy one to miss: without it the order appears to have gone to
    // terminal_pending and back on its own.
    const source = readFileSync('app/api/payments/push-to-terminal/route.ts', 'utf8')
    const calls = source.match(/recordPaymentStatusChange\(/g) ?? []
    expect(calls.length).toBeGreaterThanOrEqual(2)
    expect(source).toMatch(/payments\/push-to-terminal:release/)
  })

  it('the orders route trails both of its failure paths', () => {
    const source = readFileSync('app/api/orders/route.ts', 'utf8')
    const failedWrites = source.match(/payment_status: 'failed'/g) ?? []
    const trails = source.match(/recordPaymentStatusChange\(/g) ?? []
    expect(trails.length).toBeGreaterThanOrEqual(failedWrites.length)
  })

  it('lib/supabase/orders.ts no longer exports an untrailed payment writer', () => {
    // Deleted 2026-08-24: it set payment_status to anything including 'paid', wrote no audit row,
    // and was scoped by id only -- no restaurant_id. Dead, but one import from being live.
    const source = readFileSync('lib/supabase/orders.ts', 'utf8')
    expect(source).not.toMatch(/export async function updateSupabaseOrderPayment/)
    expect(source).not.toMatch(/export async function updateOrderPayment/)
    expect(source).not.toMatch(/export async function updateSupabaseOrderByMerchantNo/)
    expect(source).not.toMatch(/export async function closeSupabaseTableOrders/)
  })
})
