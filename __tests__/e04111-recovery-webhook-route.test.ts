/**
 * PR1 — route-level: a Finatic-verified payment that we FAIL to apply must never be
 * ACKed. A 200 tells Finatic to stop retrying, so a swallowed claim result is the exact
 * shape of "real payment discarded, success logged".
 */
import { POST } from '@/app/api/webhooks/paycloud/route'

const verifyWebhook = jest.fn()
const enforceWebhookRateLimit = jest.fn((..._args: unknown[]) => ({ allowed: true }))
jest.mock('@/payments/webhook', () => ({
  verifyWebhook: (...args: unknown[]) => verifyWebhook(...args),
  enforceWebhookRateLimit: (...args: unknown[]) => enforceWebhookRateLimit(...args),
}))

const resolveOrderIdsByMerchantOrderNo = jest.fn()
jest.mock('@/lib/payments/resolve-order-by-merchant-order', () => ({
  resolveOrderIdsByMerchantOrderNo: (...args: unknown[]) =>
    resolveOrderIdsByMerchantOrderNo(...args),
}))

const confirmWebhookOrderViaFinaticFallback = jest.fn()
jest.mock('@/lib/payments/webhook-sig-fallback', () => ({
  confirmWebhookOrderViaFinaticFallback: (...args: unknown[]) =>
    confirmWebhookOrderViaFinaticFallback(...args),
}))

const markOrderPaidConfirmed = jest.fn()
jest.mock('@/lib/payments/mark-order-paid-confirmed', () => ({
  markOrderPaidConfirmed: (...args: unknown[]) => markOrderPaidConfirmed(...args),
}))

let orderRow: Record<string, unknown>
const auditInserts: Record<string, unknown>[] = []

jest.mock('@/lib/supabase/server', () => ({
  createServerSupabaseClient: () => ({
    from: (table: string) => {
      if (table === 'orders') {
        return {
          select: () => ({
            in: async () => ({ data: [orderRow], error: null }),
          }),
          update: () => ({ in: () => ({ is: async () => ({ error: null }) }) }),
        }
      }
      if (table === 'audit_logs') {
        return {
          insert: async (row: Record<string, unknown>) => {
            auditInserts.push(row)
            return { error: null }
          },
        }
      }
      throw new Error(`unexpected table ${table}`)
    },
  }),
}))

function makeReq(body: Record<string, unknown>) {
  return new Request('https://example.test/api/webhooks/paycloud', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-paycloud-sign': 'deadbeef' },
    body: JSON.stringify(body),
  })
}

const PAID_FALLBACK = {
  path: 'fallback_verified_paid',
  finatic: {
    paid: true,
    merchantOrderNo: 'FT17857583233613303',
    status: '2',
    transactionId: 'TXN-149',
    amount: 42.5,
    raw: {},
  },
  orderIds: ['ord-1'],
  restaurantId: 'rest-1',
  orderTotal: 42.5,
}

describe('webhook must not ACK a payment it could not apply', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    auditInserts.length = 0
    enforceWebhookRateLimit.mockReturnValue({ allowed: true })
    verifyWebhook.mockReturnValue({ ok: false, reason: 'Encryption block is invalid.' })
    resolveOrderIdsByMerchantOrderNo.mockResolvedValue({ orderIds: ['ord-1'], source: 'orders' })
    confirmWebhookOrderViaFinaticFallback.mockResolvedValue(PAID_FALLBACK)
    orderRow = {
      id: 'ord-1',
      restaurant_id: 'rest-1',
      total: 42.5,
      payment_method: 'card',
      payment_status: 'pending',
      cancellation_reason: null,
      cancelled_at: null,
    }
  })

  test('claim_conflict → 503 so Finatic retries, NOT a 200 ACK', async () => {
    markOrderPaidConfirmed.mockResolvedValue({ claimed: false, reason: 'claim_conflict' })

    const res = await POST(makeReq({ merchant_order_no: 'FT17857583233613303', trans_status: 2 }))
    const json = await res.json()
    console.log('CLAIM_CONFLICT_NOT_ACKED', JSON.stringify({ status: res.status, json }, null, 2))

    expect(res.status).toBe(503)
    expect(String(json.error || '')).toMatch(/not applied/i)
    expect(json.unclaimed).toEqual([{ orderId: 'ord-1', reason: 'claim_conflict' }])
  })

  test('already_paid is benign → 200 ACK (another caller won the race)', async () => {
    markOrderPaidConfirmed.mockResolvedValue({ claimed: false, reason: 'already_paid' })

    const res = await POST(makeReq({ merchant_order_no: 'FT17857583233613303', trans_status: 2 }))
    const text = await res.text()
    console.log('ALREADY_PAID_ACKED', JSON.stringify({ status: res.status, text }, null, 2))

    expect(res.status).toBe(200)
    expect(text.trim()).toBe('success')
  })

  test('successful claim still ACKs 200', async () => {
    markOrderPaidConfirmed.mockResolvedValue({ claimed: true, orderId: 'ord-1', tabId: null })

    const res = await POST(makeReq({ merchant_order_no: 'FT17857583233613303', trans_status: 2 }))
    expect(res.status).toBe(200)
    expect((await res.text()).trim()).toBe('success')
  })

  test('valid-signature path also refuses to ACK an unapplied claim', async () => {
    verifyWebhook.mockReturnValue({ ok: true, mode: 'rsa' })
    markOrderPaidConfirmed.mockResolvedValue({ claimed: false, reason: 'claim_conflict' })

    const res = await POST(makeReq({ merchant_order_no: 'FT17857583233613303', trans_status: 2 }))
    console.log('VALID_SIG_CLAIM_CONFLICT', res.status)
    expect(res.status).toBe(503)
  })
})

describe('auto-cancelled order recovery through the webhook', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    auditInserts.length = 0
    enforceWebhookRateLimit.mockReturnValue({ allowed: true })
    verifyWebhook.mockReturnValue({ ok: false, reason: 'Encryption block is invalid.' })
    resolveOrderIdsByMerchantOrderNo.mockResolvedValue({ orderIds: ['ord-1'], source: 'orders' })
    confirmWebhookOrderViaFinaticFallback.mockResolvedValue(PAID_FALLBACK)
    markOrderPaidConfirmed.mockResolvedValue({ claimed: true, orderId: 'ord-1', tabId: null })
    orderRow = {
      id: 'ord-1',
      restaurant_id: 'rest-1',
      total: 42.5,
      payment_method: 'card',
      payment_status: 'cancelled',
      cancellation_reason: 'auto_cancelled_e04111_persistent',
      cancelled_at: '2026-08-03T10:00:00.000Z',
    }
  })

  test('widens the claim to cancelled and raises payment.recovered_after_auto_cancel', async () => {
    const res = await POST(makeReq({ merchant_order_no: 'FT17857583233613303', trans_status: 2 }))

    expect(res.status).toBe(200)
    expect(markOrderPaidConfirmed).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        orderId: 'ord-1',
        fromPaymentStatuses: expect.arrayContaining(['cancelled']),
        extraAuditMetadata: expect.objectContaining({ recoveredAfterAutoCancel: true }),
      }),
    )

    const recovery = auditInserts.find((a) => a.action === 'payment.recovered_after_auto_cancel')
    console.log('RECOVERY_AUDIT', JSON.stringify(recovery, null, 2))
    expect(recovery).toBeDefined()
    expect(recovery!.entity_id).toBe('ord-1')
    expect(recovery!.metadata).toEqual(
      expect.objectContaining({
        severity: 'error',
        previousCancellationReason: 'auto_cancelled_e04111_persistent',
        previousCancelledAt: '2026-08-03T10:00:00.000Z',
        requiresReconciliation: true,
      }),
    )
  })

  test('a staff-cancelled order is NOT revived by a webhook', async () => {
    orderRow.cancellation_reason = 'terminal_cancelled'

    await POST(makeReq({ merchant_order_no: 'FT17857583233613303', trans_status: 2 }))

    expect(markOrderPaidConfirmed).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        fromPaymentStatuses: expect.not.arrayContaining(['cancelled']),
      }),
    )
    expect(auditInserts.find((a) => a.action === 'payment.recovered_after_auto_cancel')).toBeUndefined()
  })
})
