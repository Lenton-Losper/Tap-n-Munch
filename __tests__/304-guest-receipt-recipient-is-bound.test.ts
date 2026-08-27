/**
 * #304 — the guest receipt-email route sent a customer's receipt to an address the CALLER chose.
 *
 * The first narrowing (f339d42) removed the table number from the authority, because a table number
 * is printed on the QR code. This suite pins the SECOND narrowing: once a receipt has been
 * delivered to an address, that is the only address it may be delivered to. The caller keeps the
 * first choice — there is no `customer_email` column to take it from (#234, still true at HEAD) —
 * and loses every later one, which is the property the issue names as the difference between
 * exfiltration and nuisance.
 *
 * ============================================================================================
 * EVERY REFUSAL IN THIS FILE IS PAIRED WITH A POSITIVE CONTROL, DELIBERATELY.
 * ============================================================================================
 *
 * "attack REFUSED" cannot tell CLOSED from DEAD. A `sendReceiptEmail` that threw on everything, or
 * a mock wired so no send ever reaches the provider, would satisfy every "it was blocked" assertion
 * in here and prove nothing. So each blocked case has a sibling in the SAME run that must SEND:
 *
 *   blocked: a second, different address              <-> control: the first address, and the same
 *                                                                 address again, both send
 *   blocked: a different address, guest route          <-> control: the same different address with
 *            (binding on)                                          binding OFF (the two staff
 *                                                                  routes) still sends
 *   blocked: the bind read fails -> throws             <-> control: the bind read succeeding sends
 *
 * FAILS WITHOUT THE FIX: at `d80f037a`, `sendReceiptEmail` takes two parameters, exports no
 * `SendReceiptEmailOptions`, and the second address sends. Deleting the `bindRecipientToFirstDelivery`
 * argument from the guest route's call site is the whole revert, and it turns the blocked cases red
 * while leaving every control green — which is what tells you the controls are load-bearing.
 *
 * THE MOCK FILTERS FOR REAL. `deliveryRows` is the table, and the mock applies the `.eq()`/`.gte()`
 * the module itself writes. That matters for one case in particular: a prior FAILED attempt must
 * not bind, and it is `sendReceiptEmail`'s own `.eq('status', 'sent')` that has to make that true.
 * A mock that just handed back a canned "bound address" would be asserting its own configuration.
 *
 * Resend and both renderers are mocked: rendering a real PDF to prove a send was REFUSED would be
 * proving it by doing the thing.
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

/** The contents of receipt_deliveries for this test. */
let deliveryRows: Row[]
/** Injected read failures, one per read the module performs. */
let countError: unknown
let bindError: unknown
let dedupError: unknown
let inserted: Row[]

/** The bind read (GATE 3) and the dedup read (GATE 2) are told apart by their column list. */
const BIND_COLUMNS = 'destination, requested_at'

jest.mock('@/lib/supabase/server', () => ({
  createServerSupabaseClient: () => ({
    from(table: string) {
      if (table !== 'receipt_deliveries') throw new Error(`unexpected table ${table}`)
      return {
        select(columns: string, options?: { count?: string; head?: boolean }) {
          const eqs: Array<[string, unknown]> = []
          const gtes: Array<[string, unknown]> = []
          let sort: { column: string; ascending: boolean } | null = null

          const apply = () => {
            let out = deliveryRows.filter((row) =>
              eqs.every(([col, val]) => String(row[col] ?? '') === String(val ?? '')),
            )
            out = out.filter((row) =>
              gtes.every(([col, val]) => String(row[col] ?? '') >= String(val ?? '')),
            )
            if (sort) {
              const { column, ascending } = sort
              out = [...out].sort((a, b) => {
                const x = String(a[column] ?? '')
                const y = String(b[column] ?? '')
                return ascending ? x.localeCompare(y) : y.localeCompare(x)
              })
            }
            return out
          }

          if (options?.head) {
            // The attempt-number count: two .eq() calls, then awaited directly.
            const thenable: Record<string, unknown> = {
              eq: (col: string, val: unknown) => {
                eqs.push([col, val])
                return thenable
              },
              then: (resolve: (v: unknown) => void) =>
                resolve({ count: apply().length, error: countError }),
            }
            return thenable
          }

          const isBindRead = columns === BIND_COLUMNS
          const chain: Record<string, unknown> = {
            eq: (col: string, val: unknown) => {
              eqs.push([col, val])
              return chain
            },
            gte: (col: string, val: unknown) => {
              gtes.push([col, val])
              return chain
            },
            order: (col: string, opts?: { ascending?: boolean }) => {
              sort = { column: col, ascending: opts?.ascending !== false }
              return chain
            },
            limit: async (n: number) => {
              const error = isBindRead ? bindError : dedupError
              if (error) return { data: null, error }
              return { data: apply().slice(0, n), error: null }
            },
          }
          return chain
        },
        insert(payload: Row) {
          inserted.push(payload)
          return {
            select: () => ({
              single: async () => ({
                data: { id: 'delivery-new', status: payload.status },
                error: null,
              }),
            }),
          }
        },
      }
    },
  }),
}))

import { sendReceiptEmail } from '@/lib/receipts/delivery/sendReceiptEmail'

const RECEIPT = {
  id: 'receipt-1',
  document_number: 'RCT-000123',
  issued_at: '2026-08-25T10:00:00.000Z',
  snapshot_json: { outlet: { restaurant_name: 'FNB ChowNow' } },
} as never

const CUSTOMER = 'ada@example.com'
const ATTACKER = 'not-the-customer@example.com'

/** Old enough that #244's five-minute dedup window can never be what refused a send. */
const LONG_AGO = '2026-08-25T10:05:00.000Z'

const delivered = (destination: string, requested_at = LONG_AGO): Row => ({
  id: `delivery-${destination}-${requested_at}`,
  receipt_document_id: 'receipt-1',
  method: 'EMAIL',
  status: 'sent',
  destination,
  requested_at,
})

const attemptedAndFailed = (destination: string, requested_at = LONG_AGO): Row => ({
  ...delivered(destination, requested_at),
  status: 'failed',
})

beforeEach(() => {
  deliveryRows = []
  countError = null
  bindError = null
  dedupError = null
  inserted = []
  sendMock.mockReset()
  sendMock.mockResolvedValue({ data: { id: 'resend-1' }, error: null })
  jest.spyOn(console, 'error').mockImplementation(() => {})
  jest.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => jest.restoreAllMocks())

const GUEST = { bindRecipientToFirstDelivery: true } as const

describe('#304 POSITIVE CONTROLS — the customer still gets their receipt', () => {
  it('a receipt with no delivery history sends to the address the customer typed', async () => {
    const result = await sendReceiptEmail(RECEIPT, CUSTOMER, GUEST)

    expect(result.status).toBe('sent')
    expect(result.failure).toBeUndefined()
    expect(sendMock).toHaveBeenCalledTimes(1)
    expect(sendMock.mock.calls[0][0].to).toEqual([CUSTOMER])
    expect(inserted).toHaveLength(1)
  })

  it('the SAME address again, long after the dedup window, still sends', async () => {
    deliveryRows = [delivered(CUSTOMER)]

    const result = await sendReceiptEmail(RECEIPT, CUSTOMER, GUEST)

    expect(result.status).toBe('sent')
    expect(result.deduplicated).toBeUndefined()
    expect(sendMock).toHaveBeenCalledTimes(1)
    expect(inserted).toHaveLength(1)
  })

  it('case and stray whitespace are not a different recipient', async () => {
    deliveryRows = [delivered(CUSTOMER)]

    const result = await sendReceiptEmail(RECEIPT, '  Ada@Example.COM ', GUEST)

    expect(result.status).toBe('sent')
    expect(sendMock).toHaveBeenCalledTimes(1)
  })

  it('a prior FAILED attempt to another address does not bind — no denial of service', async () => {
    // If binding drew on every attempt rather than on deliveries, one bouncing address would pin
    // this receipt for ever and the customer below would be refused their own receipt.
    deliveryRows = [attemptedAndFailed(ATTACKER)]

    const result = await sendReceiptEmail(RECEIPT, CUSTOMER, GUEST)

    expect(result.status).toBe('sent')
    expect(sendMock).toHaveBeenCalledTimes(1)
  })
})

describe('#304 THE REFUSAL — a second, different recipient', () => {
  it('is refused, reaches no provider, and writes no delivery row', async () => {
    deliveryRows = [delivered(CUSTOMER)]

    const result = await sendReceiptEmail(RECEIPT, ATTACKER, GUEST)

    expect(result.status).toBe('failed')
    expect(result.failure).toBe('recipient_not_bound')
    expect(sendMock).not.toHaveBeenCalled()
    // The trail logs attempts to DELIVER. This one never reached a provider.
    expect(inserted).toHaveLength(0)
    expect(result.deliveryId).toBe('')
  })

  it('names neither address in what the caller is handed', async () => {
    // The route puts `errorMessage` into an API body reachable without a session token.
    deliveryRows = [delivered(CUSTOMER)]

    const result = await sendReceiptEmail(RECEIPT, ATTACKER, GUEST)

    expect(result.errorMessage).not.toContain(CUSTOMER)
    expect(result.errorMessage).not.toContain(ATTACKER)
  })

  it('binds to the FIRST delivery, not the most recent one', async () => {
    // An attacker who got one send through must not be able to re-point the receipt afterwards.
    deliveryRows = [
      delivered(CUSTOMER, '2026-08-25T10:05:00.000Z'),
      delivered(ATTACKER, '2026-08-25T11:00:00.000Z'),
    ]

    const stillBlocked = await sendReceiptEmail(RECEIPT, ATTACKER, GUEST)
    expect(stillBlocked.failure).toBe('recipient_not_bound')

    sendMock.mockClear()
    const control = await sendReceiptEmail(RECEIPT, CUSTOMER, GUEST)
    expect(control.status).toBe('sent')
    expect(sendMock).toHaveBeenCalledTimes(1)
  })
})

describe('#304 THE GATE IS OPT-IN — the two staff routes are not narrowed', () => {
  it('the same different address sends when binding is not requested', async () => {
    // app/api/orders/[orderId]/receipt/email (requireStaffPermission) and
    // app/api/terminal/receipts/[orderId]/email (terminal JWT) pass no options.
    deliveryRows = [delivered(CUSTOMER)]

    const result = await sendReceiptEmail(RECEIPT, ATTACKER)

    expect(result.status).toBe('sent')
    expect(result.failure).toBeUndefined()
    expect(sendMock).toHaveBeenCalledTimes(1)
    expect(inserted).toHaveLength(1)
  })

  it('an explicit false is the same as omitting it', async () => {
    deliveryRows = [delivered(CUSTOMER)]

    const result = await sendReceiptEmail(RECEIPT, ATTACKER, {
      bindRecipientToFirstDelivery: false,
    })

    expect(result.status).toBe('sent')
    expect(sendMock).toHaveBeenCalledTimes(1)
  })
})

describe('#304 THE GATE FAILS CLOSED', () => {
  it('a bind read that errors throws rather than sending', async () => {
    deliveryRows = [delivered(CUSTOMER)]
    bindError = { message: 'connection reset' }

    await expect(sendReceiptEmail(RECEIPT, ATTACKER, GUEST)).rejects.toThrow(/bound recipient/)
    expect(sendMock).not.toHaveBeenCalled()
    expect(inserted).toHaveLength(0)
  })

  it('CONTROL: the identical call with the read working sends', async () => {
    // Without this line the test above cannot tell a gate that fails closed from a module that
    // throws on everything.
    deliveryRows = [delivered(CUSTOMER)]
    bindError = null

    const result = await sendReceiptEmail(RECEIPT, CUSTOMER, GUEST)

    expect(result.status).toBe('sent')
    expect(sendMock).toHaveBeenCalledTimes(1)
  })

  it('a dedup read that errors still fails OPEN, unchanged by this fix', async () => {
    // #244 made that choice deliberately and it is not this issue's to revisit: the dedup's worst
    // outcome is one duplicate to an address already bound.
    deliveryRows = [delivered(CUSTOMER)]
    dedupError = { message: 'connection reset' }

    const result = await sendReceiptEmail(RECEIPT, CUSTOMER, GUEST)

    expect(result.status).toBe('sent')
    expect(sendMock).toHaveBeenCalledTimes(1)
  })
})

describe('#304 the gate sits BEHIND the ceiling, so #244 still answers first', () => {
  it('a receipt at its ceiling is refused as attempt_ceiling, not as recipient_not_bound', async () => {
    deliveryRows = Array.from({ length: 10 }, (_, i) =>
      delivered(CUSTOMER, `2026-08-25T10:0${i}:00.000Z`),
    )

    const result = await sendReceiptEmail(RECEIPT, ATTACKER, GUEST)

    expect(result.failure).toBe('attempt_ceiling')
    expect(sendMock).not.toHaveBeenCalled()
  })
})
