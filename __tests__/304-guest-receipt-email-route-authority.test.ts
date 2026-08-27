/**
 * #304 at the ROUTE, because a fix in the sender can ship inert.
 *
 * `__tests__/304-guest-receipt-recipient-is-bound.test.ts` proves `sendReceiptEmail`'s GATE 3
 * works. It cannot prove the guest route ASKS FOR IT. A route that implements a gate in a shared
 * module and then forgets the one argument that turns it on type-checks, passes every unit test,
 * and is exactly as exposed as before — so the wiring is asserted here, by driving the real
 * handler over a stub and mocking only the provider boundary. `sendReceiptEmail` itself is NOT
 * mocked; if it were, this file would be asserting its own configuration.
 *
 * ============================================================================================
 * WHAT IS ASSERTED, AND WHY EVERY REFUSAL HAS A CONTROL
 * ============================================================================================
 *
 *   POSITIVE CONTROL  a paid order, the session id it was placed under, a fresh receipt
 *                       -> 200, and the provider is handed exactly that address
 *   POSITIVE CONTROL  the same address again, long after #244's dedup window
 *                       -> 200
 *   POSITIVE CONTROL  the placer recorded in `member_session_id` instead of `session_id`
 *                       -> 200   (ownsOrder reads BOTH columns; one column was the #278 bug)
 *   BLOCKED           a SECOND, DIFFERENT address on a receipt already delivered
 *                       -> 429, nothing handed to the provider          <- this issue
 *   BLOCKED           the correct table_number and no session id
 *                       -> 404, and NOTHING IS ISSUED                   <- f339d42, pinned here
 *   BLOCKED           restaurant scope alone
 *                       -> 404, and NOTHING IS ISSUED                   <- QRA-19, pinned here
 *
 * The two 404 cases matter beyond regression cover. `issueReceiptForOrder` ALLOCATES a document
 * number and inserts a `receipt_documents` row; a gate that refused after issuing would still let
 * an unauthenticated caller stamp today's numbering onto an old sale. So the assertion is not
 * merely "404" but "404 and the issuer was never called".
 *
 * A 404 alone would be satisfied by a handler that had simply stopped working, which is why the
 * three controls above run in the same file: they must be green in the same run.
 */
import { MENU_COPY } from '@/lib/customer-copy/menu-copy'

type Row = Record<string, unknown>

const RESTAURANT = '11111111-1111-4111-8111-111111111111'
const ORDER_ID = '22222222-2222-4222-8222-222222222222'
const PLACER_SESSION = 'sess_9f3c1d2e-0000-4000-8000-abcdefabcdef'
const CUSTOMER = 'ada@example.com'
const ATTACKER = 'not-the-customer@example.com'
const LONG_AGO = '2026-08-25T10:05:00.000Z'

/** Mutated per test so one describe can move the placer between the two columns. */
let orderRow: Row
let deliveryRows: Row[]
let inserted: Row[]

const sendMock = jest.fn()
const issueMock = jest.fn()

jest.mock('@/lib/email/resend', () => ({
  getResend: () => ({ emails: { send: sendMock } }),
}))
jest.mock('@/lib/receipts/renderers/htmlRenderer', () => ({
  renderReceiptHtml: () => '<p>receipt</p>',
}))
jest.mock('@/lib/receipts/renderers/pdfRenderer', () => ({
  renderReceiptPdf: async () => new Uint8Array([1, 2, 3]),
}))
jest.mock('@/lib/receipts/issueReceipt', () => ({
  issueReceiptForOrder: (...args: unknown[]) => issueMock(...args),
}))

const BIND_COLUMNS = 'destination, requested_at'

jest.mock('@/lib/supabase/server', () => ({
  createServerSupabaseClient: () => ({
    from(table: string) {
      if (table === 'orders') {
        const eqs: Array<[string, unknown]> = []
        const chain: Record<string, unknown> = {
          select: () => chain,
          eq: (col: string, val: unknown) => {
            eqs.push([col, val])
            return chain
          },
          // APPLIES the filters, so a cross-restaurant request fails for the right reason.
          maybeSingle: async () => {
            const match = eqs.every(([col, val]) => {
              const key = col === 'id' ? 'id' : col
              return String(orderRow[key] ?? '') === String(val ?? '')
            })
            return { data: match ? orderRow : null, error: null }
          },
        }
        return chain
      }

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
            const thenable: Record<string, unknown> = {
              eq: (col: string, val: unknown) => {
                eqs.push([col, val])
                return thenable
              },
              then: (resolve: (v: unknown) => void) =>
                resolve({ count: apply().length, error: null }),
            }
            return thenable
          }

          void (columns === BIND_COLUMNS)
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
            limit: async (n: number) => ({ data: apply().slice(0, n), error: null }),
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

import { POST } from '@/app/api/guest/orders/[orderId]/receipt/email/route'

const delivered = (destination: string, requested_at = LONG_AGO): Row => ({
  id: `delivery-${destination}`,
  receipt_document_id: 'receipt-1',
  method: 'EMAIL',
  status: 'sent',
  destination,
  requested_at,
})

function call(query: string, email: string) {
  const req = new Request(
    `https://flashtap.app/api/guest/orders/${ORDER_ID}/receipt/email?${query}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email }),
    },
  )
  return POST(req, { params: Promise.resolve({ orderId: ORDER_ID }) })
}

/** What the kiosk receipt screen actually sends: restaurantId plus every id the browser holds. */
const asOwner = `restaurantId=${RESTAURANT}&session_id=${encodeURIComponent(PLACER_SESSION)}`

beforeEach(() => {
  orderRow = {
    id: ORDER_ID,
    restaurant_id: RESTAURANT,
    table_number: 7,
    session_id: PLACER_SESSION,
    member_session_id: null,
    is_closed: false,
    status: 'completed',
    payment_status: 'paid',
  }
  deliveryRows = []
  inserted = []
  sendMock.mockReset()
  sendMock.mockResolvedValue({ data: { id: 'resend-1' }, error: null })
  issueMock.mockReset()
  issueMock.mockResolvedValue({
    id: 'receipt-1',
    document_number: 'RCT-000123',
    issued_at: '2026-08-25T10:00:00.000Z',
    snapshot_json: { outlet: { restaurant_name: 'FNB ChowNow' } },
  })
  jest.spyOn(console, 'error').mockImplementation(() => {})
  jest.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => jest.restoreAllMocks())

describe('#304 POSITIVE CONTROLS — the customer at the kiosk still gets their receipt', () => {
  it('a paid order, its own session id, a fresh receipt -> 200 and the provider is asked', async () => {
    const res = await call(asOwner, CUSTOMER)

    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toMatchObject({ success: true })
    expect(issueMock).toHaveBeenCalledWith(ORDER_ID)
    expect(sendMock).toHaveBeenCalledTimes(1)
    expect(sendMock.mock.calls[0][0].to).toEqual([CUSTOMER])
  })

  it('the same address again, long after the dedup window -> 200', async () => {
    deliveryRows = [delivered(CUSTOMER)]

    const res = await call(asOwner, CUSTOMER)

    expect(res.status).toBe(200)
    expect(sendMock).toHaveBeenCalledTimes(1)
  })

  it('the placer recorded in member_session_id instead of session_id -> 200', async () => {
    orderRow.session_id = null
    orderRow.member_session_id = PLACER_SESSION

    const res = await call(asOwner, CUSTOMER)

    expect(res.status).toBe(200)
    expect(sendMock).toHaveBeenCalledTimes(1)
  })
})

describe('#304 THE FIX — a second, different recipient is refused at the route', () => {
  it('answers 429 and hands nothing to the provider', async () => {
    deliveryRows = [delivered(CUSTOMER)]

    const res = await call(asOwner, ATTACKER)

    expect(res.status).toBe(429)
    expect(sendMock).not.toHaveBeenCalled()
    expect(inserted).toHaveLength(0)
  })

  it('tells the caller one signed sentence and names no address', async () => {
    deliveryRows = [delivered(CUSTOMER)]

    const res = await call(asOwner, ATTACKER)
    const body = await res.json()

    expect(body.error).toBe(MENU_COPY.receiptCouldNotBeSent)
    expect(JSON.stringify(body)).not.toContain(CUSTOMER)
  })

  it('THE WIRING: removing the option from this call site is what turns the two above red', async () => {
    // Stated so the revert is unambiguous. The gate is opt-in; the guest route is the only caller
    // that opts in, and the staff routes are covered by the sender's own suite.
    deliveryRows = [delivered(CUSTOMER)]
    const blocked = await call(asOwner, ATTACKER)
    expect(blocked.status).toBe(429)

    // CONTROL in the same run: the bound address is still deliverable.
    sendMock.mockClear()
    const allowed = await call(asOwner, CUSTOMER)
    expect(allowed.status).toBe(200)
    expect(sendMock).toHaveBeenCalledTimes(1)
  })
})

describe('#304 first narrowing (f339d42) — a table number authorises nothing', () => {
  it('the correct table_number with no session id -> 404, and NOTHING is issued', async () => {
    const res = await call(`restaurantId=${RESTAURANT}&table_number=7`, CUSTOMER)

    expect(res.status).toBe(404)
    await expect(res.json()).resolves.toMatchObject({ error: MENU_COPY.guestOrderNotFound })
    // issueReceiptForOrder allocates a document number. A gate that refuses after issuing has
    // still let an unauthenticated caller write.
    expect(issueMock).not.toHaveBeenCalled()
    expect(sendMock).not.toHaveBeenCalled()
  })

  it('restaurant scope alone -> 404, and NOTHING is issued', async () => {
    const res = await call(`restaurantId=${RESTAURANT}`, CUSTOMER)

    expect(res.status).toBe(404)
    expect(issueMock).not.toHaveBeenCalled()
    expect(sendMock).not.toHaveBeenCalled()
  })

  it('another diner session id at the same table -> 404', async () => {
    const res = await call(
      `restaurantId=${RESTAURANT}&table_number=7&session_id=sess_someone-else`,
      CUSTOMER,
    )

    expect(res.status).toBe(404)
    expect(issueMock).not.toHaveBeenCalled()
    expect(sendMock).not.toHaveBeenCalled()
  })
})
