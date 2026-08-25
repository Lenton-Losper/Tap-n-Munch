/**
 * #244 — sendReceiptEmail had no ceiling, no dedup and no bound. `attempt_number` was derived,
 * written to the append-only log, and NEVER COMPARED TO ANYTHING.
 *
 * The issue records this as latent, on the grounds that "all three callers are explicit HTTP
 * endpoints requiring an address". That is true and not sufficient: one of the three,
 * `app/api/guest/orders/[orderId]/receipt/email`, takes NO session token (#304, still open). So
 * unbounded sends are reachable today, without waiting for issuance to be wired to delivery or for
 * a `customer_email` column to exist.
 *
 * FAILS WITHOUT THE FIX: at `ceea943` `sendReceiptEmail` exports neither
 * `RECEIPT_EMAIL_MAX_ATTEMPTS` nor `RECEIPT_EMAIL_DEDUP_WINDOW_MS`, and the eleventh call sends.
 *
 * THE LOAD-BEARING CASES:
 *   - the 11th attempt does not reach the provider. Delete the ceiling and this goes red.
 *   - a duplicate inside the window does not reach the provider AND does not write a new log row.
 *   - CASE AND WHITESPACE do not defeat the dedup. `Ada@Example.com ` is the same address.
 *   - the ceiling refusal writes NO receipt_deliveries row — the trail logs attempts to DELIVER,
 *     and this one never reached a provider.
 *
 * Resend and both renderers are mocked: this suite is about the gates, and rendering a PDF to
 * prove a send was REFUSED would be proving it by doing the thing.
 */
const sendMock = jest.fn()

jest.mock('@/lib/email/resend', () => ({
  getResend: () => ({ emails: { send: sendMock } }),
}))
jest.mock('@/lib/receipts/renderers/htmlRenderer', () => ({
  renderReceiptHtml: () => '<p>receipt</p>',
}))
jest.mock('@/lib/receipts/renderers/pdfRenderer', () => ({
  renderReceiptPdf: async () => new Uint8Array([1, 2, 3]),
}))

type Row = Record<string, unknown>

let priorAttemptCount: number
let countError: unknown
let recentSentRows: Row[]
let recentError: unknown
let inserted: Row[]

jest.mock('@/lib/supabase/server', () => ({
  createServerSupabaseClient: () => ({
    from(table: string) {
      if (table !== 'receipt_deliveries') throw new Error(`unexpected table ${table}`)
      return {
        select(_columns: string, options?: { count?: string; head?: boolean }) {
          if (options?.head) {
            // The attempt-number count.
            const chain: Record<string, unknown> = {
              eq: () => chain,
            }
            // Two .eq() calls then await.
            const thenable = {
              eq: () => thenable,
              then: (resolve: (v: unknown) => void) =>
                resolve({ count: priorAttemptCount, error: countError }),
            }
            return thenable
          }
          // The dedup read.
          const chain: Record<string, unknown> = {
            eq: () => chain,
            gte: () => chain,
            order: () => chain,
            limit: async () => ({ data: recentSentRows, error: recentError }),
          }
          return chain
        },
        insert(payload: Row) {
          inserted.push(payload)
          return {
            select: () => ({
              single: async () => ({ data: { id: 'delivery-new', status: payload.status }, error: null }),
            }),
          }
        },
      }
    },
  }),
}))

import {
  sendReceiptEmail,
  RECEIPT_EMAIL_MAX_ATTEMPTS,
  RECEIPT_EMAIL_DEDUP_WINDOW_MS,
} from '@/lib/receipts/delivery/sendReceiptEmail'

const RECEIPT = {
  id: 'receipt-1',
  document_number: 'RCT-000123',
  issued_at: '2026-08-25T10:00:00.000Z',
  snapshot_json: { outlet: { restaurant_name: 'FNB ChowNow' } },
} as never

beforeEach(() => {
  priorAttemptCount = 0
  countError = null
  recentSentRows = []
  recentError = null
  inserted = []
  sendMock.mockReset()
  sendMock.mockResolvedValue({ data: { id: 'resend-1' }, error: null })
  jest.spyOn(console, 'error').mockImplementation(() => {})
  jest.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => jest.restoreAllMocks())

describe('#244 the happy path still works', () => {
  it('sends, and logs the attempt', async () => {
    const result = await sendReceiptEmail(RECEIPT, 'ada@example.com')
    expect(sendMock).toHaveBeenCalledTimes(1)
    expect(result.status).toBe('sent')
    expect(result.deduplicated).toBeUndefined()
    expect(inserted).toHaveLength(1)
    expect(inserted[0]).toMatchObject({ method: 'EMAIL', attempt_number: 1, destination: 'ada@example.com' })
  })

  it('the last attempt UNDER the ceiling still sends', async () => {
    priorAttemptCount = RECEIPT_EMAIL_MAX_ATTEMPTS - 1
    const result = await sendReceiptEmail(RECEIPT, 'ada@example.com')
    expect(sendMock).toHaveBeenCalledTimes(1)
    expect(result.status).toBe('sent')
    expect(inserted[0]).toMatchObject({ attempt_number: RECEIPT_EMAIL_MAX_ATTEMPTS })
  })
})

describe('#244 the ceiling', () => {
  it('REFUSES once the ceiling is reached, and never reaches the provider', async () => {
    priorAttemptCount = RECEIPT_EMAIL_MAX_ATTEMPTS
    const result = await sendReceiptEmail(RECEIPT, 'ada@example.com')
    expect(sendMock).not.toHaveBeenCalled()
    expect(result.status).toBe('failed')
    expect(result.errorMessage).toContain(String(RECEIPT_EMAIL_MAX_ATTEMPTS))
  })

  it('writes NO receipt_deliveries row for a refusal', async () => {
    // The trail logs attempts to DELIVER. This one never reached a provider, and a row that
    // corresponds to nothing having been attempted stops the table being an audit trail.
    priorAttemptCount = RECEIPT_EMAIL_MAX_ATTEMPTS + 5
    await sendReceiptEmail(RECEIPT, 'ada@example.com')
    expect(inserted).toEqual([])
  })

  it('FAILS CLOSED if the attempt count cannot be read', async () => {
    countError = { message: 'connection reset' }
    await expect(sendReceiptEmail(RECEIPT, 'ada@example.com')).rejects.toThrow(/attempt number/)
    expect(sendMock).not.toHaveBeenCalled()
  })
})

describe('#244 dedup', () => {
  it('suppresses an identical send inside the window and returns the ORIGINAL delivery id', async () => {
    recentSentRows = [{ id: 'delivery-earlier', destination: 'ada@example.com', status: 'sent' }]
    const result = await sendReceiptEmail(RECEIPT, 'ada@example.com')
    expect(sendMock).not.toHaveBeenCalled()
    expect(inserted).toEqual([])
    expect(result).toEqual({
      deliveryId: 'delivery-earlier',
      status: 'sent',
      errorMessage: null,
      deduplicated: true,
    })
  })

  it('CASE and WHITESPACE do not defeat it', async () => {
    recentSentRows = [{ id: 'delivery-earlier', destination: 'Ada@Example.COM', status: 'sent' }]
    const result = await sendReceiptEmail(RECEIPT, '  ada@example.com ')
    expect(sendMock).not.toHaveBeenCalled()
    expect(result.deduplicated).toBe(true)
  })

  it('a DIFFERENT address inside the window still sends — this is dedup, not a per-receipt lock', async () => {
    recentSentRows = [{ id: 'delivery-earlier', destination: 'ada@example.com', status: 'sent' }]
    const result = await sendReceiptEmail(RECEIPT, 'grace@example.com')
    expect(sendMock).toHaveBeenCalledTimes(1)
    expect(result.status).toBe('sent')
    expect(result.deduplicated).toBeUndefined()
  })

  it('FAILS OPEN if the dedup read errors — one extra email beats a stranded customer', async () => {
    recentError = { message: 'connection reset' }
    const result = await sendReceiptEmail(RECEIPT, 'ada@example.com')
    expect(sendMock).toHaveBeenCalledTimes(1)
    expect(result.status).toBe('sent')
  })

  it('the window is a real bound, not a per-receipt forever-lock', () => {
    expect(RECEIPT_EMAIL_DEDUP_WINDOW_MS).toBeGreaterThan(0)
    expect(RECEIPT_EMAIL_DEDUP_WINDOW_MS).toBeLessThanOrEqual(60 * 60 * 1000)
  })
})

describe('#244 a provider rejection is still logged, not swallowed', () => {
  it('records the failed attempt', async () => {
    sendMock.mockResolvedValue({ error: { name: 'validation_error', message: 'bad address' } })
    const result = await sendReceiptEmail(RECEIPT, 'ada@example.com')
    expect(result.status).toBe('failed')
    expect(inserted).toHaveLength(1)
    expect(inserted[0]).toMatchObject({ status: 'failed', error_code: 'validation_error' })
  })
})
