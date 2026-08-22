import {
  queryFinaticOrderPaid,
  type FinaticOrderPaidResult,
} from '@/lib/payments/query-finatic-order-paid'

/**
 * Staging/preview-only Finatic stub for HTTP probes.
 * Honored when:
 *   - ENVIRONMENT=staging (Cloudflare staging Worker wrangler.toml [vars]), or
 *   - VERCEL_ENV=preview (PR previews; production uses Cloudflare, not Vercel)
 * and the request includes `__stagingFinaticStub`:
 * 'paid' | 'not_paid' | 'unreachable' | 'e04111'.
 * Production Workers set ENVIRONMENT=production, so this is a no-op there.
 */
export function stagingFinaticQueryStub(
  stub: unknown,
): typeof queryFinaticOrderPaid | undefined {
  const env = String(process.env.ENVIRONMENT || '').trim().toLowerCase()
  const vercelEnv = String(process.env.VERCEL_ENV || '').trim().toLowerCase()
  const stubAllowed = env === 'staging' || vercelEnv === 'preview'
  if (!stubAllowed) {
    return undefined
  }
  const mode = String(stub ?? '')
    .trim()
    .toLowerCase()
  if (!mode) return undefined

  return async (params: {
    merchantOrderNo: string
    merchantNo: string
    storeNo: string
  }): Promise<FinaticOrderPaidResult> => {
    if (mode === 'paid') {
      return {
        paid: true,
        // The stub simulates a status we DO recognise -- it stands in for a real gateway
        // answer, not for an unknown one. A stub reporting statusRecognised:false would exercise
        // the skip path, which is not what any caller uses it for.
        statusRecognised: true,
        merchantOrderNo: params.merchantOrderNo,
        status: '2',
        transactionId: `STUB-TXN-${params.merchantOrderNo.slice(-6)}`,
        amount: null,
        raw: { code: '0', stub: 'paid' },
      }
    }
    if (mode === 'not_paid' || mode === 'declined') {
      return {
        paid: false,
        statusRecognised: true,
        merchantOrderNo: params.merchantOrderNo,
        status: 'failed',
        transactionId: null,
        amount: null,
        raw: { code: '0', stub: 'not_paid' },
      }
    }
    if (mode === 'unreachable' || mode === 'error') {
      throw new Error('STAGING_STUB: PayCloud service unavailable (network failure)')
    }
    if (mode === 'e04111') {
      const err = new Error(
        'PayCloud query failed: E04111 [E04111]Merchant order number is invalid',
      ) as Error & { responseBody?: Record<string, unknown>; phase?: string }
      err.responseBody = {
        code: 'E04111',
        msg: '[E04111]Merchant order number is invalid',
        merchant_order_no: params.merchantOrderNo,
      }
      err.phase = 'business'
      throw err
    }
    throw new Error(`STAGING_STUB: unknown __stagingFinaticStub mode: ${mode}`)
  }
}
