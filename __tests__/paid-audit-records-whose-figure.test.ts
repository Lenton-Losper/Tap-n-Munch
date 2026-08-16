/**
 * #238 / #268 — what the `payment.completed` audit entry says about WHOSE figure the amount is.
 *
 * THE ASSERTION THAT CARRIES THIS FILE is `distinguishes a gateway that reported zero from a
 * caller that had no gateway figure`. Those are completely different facts — "Finatic said the
 * customer paid N$0" versus "this code path never asked Finatic" — and collapsing them is how an
 * audit trail stops being able to answer the question it exists for. A `?? null` on a number is
 * the exact shape that collapses them if written as `|| null`.
 *
 * `clientAmount` is asserted ABSENT rather than just untested. It was write-only — nothing in
 * *.ts, *.tsx, *.sql, __tests__ or the terminal app read it — so removing it is safe, and a
 * future edit that reinstates it would reintroduce a field whose name is wrong for four of the
 * six callers.
 */
import { markOrderPaidConfirmed } from '@/lib/payments/mark-order-paid-confirmed'

type Insert = { table: string; row: Record<string, unknown> }

function makeSupabase(inserts: Insert[]) {
  return {
    from(table: string) {
      return {
        update: () => ({
          eq: function () {
            return this
          },
          in: function () {
            return this
          },
          select: () => ({
            maybeSingle: async () => ({
              data: { id: 'order-1', tab_id: null, payment_status: 'paid' },
              error: null,
            }),
          }),
        }),
        insert: async (row: Record<string, unknown>) => {
          inserts.push({ table, row })
          return { error: null }
        },
        select: () => ({
          eq: function () {
            return this
          },
          maybeSingle: async () => ({ data: null, error: null }),
        }),
      }
    },
  } as never
}

jest.mock('@/lib/receipts/safeIssueReceipt', () => ({
  safeIssueReceiptForOrder: async () => undefined,
}))

async function auditMetadataFor(extra: Record<string, unknown>) {
  const inserts: Insert[] = []
  await markOrderPaidConfirmed(makeSupabase(inserts), {
    orderId: 'order-1',
    restaurantId: 'rest-1',
    reference: 'REF-123',
    amount: 100,
    source: 'test',
    ...extra,
  })
  const audit = inserts.find((i) => i.table === 'audit_logs')
  return (audit?.row.metadata ?? {}) as Record<string, unknown>
}

describe('the payment.completed audit entry', () => {
  it('no longer writes clientAmount', async () => {
    const metadata = await auditMetadataFor({})
    expect(metadata).not.toHaveProperty('clientAmount')
  })

  it('records the order total as such when no gateway figure is known', async () => {
    const metadata = await auditMetadataFor({})
    expect(metadata.amount).toBe(100)
    expect(metadata.gatewayAmount).toBeNull()
    expect(metadata.amountMeaning).toBe('order_total')
  })

  it("records the gateway's figure, and says that is what it is", async () => {
    const metadata = await auditMetadataFor({ amount: 95, gatewayAmount: 95 })
    expect(metadata.amount).toBe(95)
    expect(metadata.gatewayAmount).toBe(95)
    expect(metadata.amountMeaning).toBe('gateway_reported')
  })

  it('keeps a MISMATCH between the two figures visible — this is what #268 is for', async () => {
    // The whole point: the caller asserted 100, the gateway said 95. Both survive.
    const metadata = await auditMetadataFor({ amount: 100, gatewayAmount: 95 })
    expect(metadata.amount).toBe(100)
    expect(metadata.gatewayAmount).toBe(95)
  })

  it('distinguishes a gateway that reported zero from a caller that had no gateway figure', async () => {
    // `|| null` instead of `?? null` collapses these two into the same audit row, and they are
    // completely different facts.
    const reportedZero = await auditMetadataFor({ gatewayAmount: 0 })
    expect(reportedZero.gatewayAmount).toBe(0)
    expect(reportedZero.amountMeaning).toBe('gateway_reported')

    const notKnown = await auditMetadataFor({})
    expect(notKnown.gatewayAmount).toBeNull()
    expect(notKnown.amountMeaning).toBe('order_total')
  })

  it('treats an explicit null gateway amount as not-known, not as zero', async () => {
    const metadata = await auditMetadataFor({ gatewayAmount: null })
    expect(metadata.gatewayAmount).toBeNull()
    expect(metadata.amountMeaning).toBe('order_total')
  })

  it('still carries the reference, method and source the trail already relied on', async () => {
    const metadata = await auditMetadataFor({ paymentMethod: 'card', terminalId: 'term-9' })
    expect(metadata).toMatchObject({
      reference: 'REF-123',
      paymentMethod: 'card',
      terminalId: 'term-9',
      source: 'test',
    })
  })

  it('lets extraAuditMetadata through unchanged', async () => {
    const metadata = await auditMetadataFor({ extraAuditMetadata: { correctionReason: 'x' } })
    expect(metadata.correctionReason).toBe('x')
  })
})
