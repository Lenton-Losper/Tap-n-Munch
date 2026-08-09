/**
 * #103 follow-ups on PATCH /api/orders/[orderId]/status, both found by the verification seat.
 *
 * The route coerced the caller's reason with String(...) and wrote the result unbounded, twice —
 * once to orders.cancellation_reason and once into the order.cancelled audit row's metadata:
 *
 *   - NO TYPE CHECK. `reason: {a:1}` stored the literal "[object Object]". `['a','b']` stored
 *     "a,b". `42` stored "42". None of those is a reason; the first is actively misleading,
 *     because a human reading the order history sees a string that looks like a bug report
 *     rather than an absent reason.
 *   - NO LENGTH CAP. A 10,000-character reason was written in full, to both places.
 *
 * WHAT MUST NOT CHANGE. The seat verified this route's effect on order state is additive across a
 * 10-case matrix, so neither fix may turn a request that cancels an order into one that does not.
 * A bad reason is therefore normalised, never rejected: an unusable reason falls back to the same
 * 'staff_cancelled' default an absent one already used, and an over-long one is truncated. The
 * order still cancels, still closes, still writes its audit row. Only the recorded text changes.
 */
import { PATCH } from '@/app/api/orders/[orderId]/status/route'

const RESTAURANT_ID = 'a1999166-ddfa-40d1-ad1f-2f01282a1652'
const ORDER_ID = 'order-1'

/** The route caps on code points, importing the same constant the UI uses. */
const MAX_REASON_LENGTH = 280

/**
 * A lone surrogate — half of a surrogate pair with no partner. Postgres cannot encode one as
 * UTF-8, so PostgREST rejects the whole request with PGRST102 before any row is touched.
 * `String.prototype.isWellFormed` is the same test (ES2024); spelled out here so the fake does
 * not depend on the Node version running the suite.
 */
function hasLoneSurrogate(value: string): boolean {
  return /[\uD800-\uDFFF]/.test(value.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, ''))
}

/** Every string the patch would write, including the JSONB audit metadata. */
function loneSurrogateIn(payload: unknown): boolean {
  if (typeof payload === 'string') return hasLoneSurrogate(payload)
  if (Array.isArray(payload)) return payload.some(loneSurrogateIn)
  if (payload && typeof payload === 'object') return Object.values(payload).some(loneSurrogateIn)
  return false
}

const PGRST102 = {
  code: 'PGRST102',
  message: 'Empty or invalid json',
  details: null,
  hint: null,
}

let existingOrder: Record<string, unknown>
let updatePatch: Record<string, unknown> | null
let auditRow: Record<string, unknown> | null
let updateRejected: boolean

jest.mock('@/lib/api/require-staff-permission', () => ({
  requireStaffPermission: async () => ({ userId: 'staff-1' }),
  isAuthError: () => false,
}))

jest.mock('@/lib/receipts/safeIssueReceipt', () => ({
  safeIssueReceiptForOrder: async () => undefined,
}))

function makeClient() {
  return {
    from(table: string) {
      const builder: Record<string, unknown> = {}
      const chain = () => builder

      Object.assign(builder, {
        select: chain,
        eq: chain,
        update: (patch: Record<string, unknown>) => {
          if (table === 'orders') {
            updatePatch = patch
            // Postgres refuses a lone surrogate, and this UPDATE also carries status, is_closed
            // and payment_status — so one bad character rejects the whole cancellation, not just
            // the reason. A fake that quietly accepted it would report a passing test for a
            // request that fails against the real database.
            updateRejected = loneSurrogateIn(patch)
          }
          return builder
        },
        maybeSingle: async () => {
          if (table !== 'orders') return { data: null, error: null }
          // First call is the pre-load; every later one is the conditional-claim update, which
          // must report success so the audit-row side effect actually runs.
          if (updatePatch === null) return { data: existingOrder, error: null }
          if (updateRejected) return { data: null, error: PGRST102 }
          return {
            data: {
              id: ORDER_ID,
              status: updatePatch.status ?? existingOrder.status,
              payment_status: updatePatch.payment_status ?? 'pending',
              paid_at: null,
              is_closed: updatePatch.is_closed ?? false,
              cancelled_at: updatePatch.cancelled_at ?? null,
            },
            error: null,
          }
        },
        insert: async (row: Record<string, unknown>) => {
          if (table === 'audit_logs') {
            if (loneSurrogateIn(row)) return { error: PGRST102 }
            auditRow = row
          }
          return { error: null }
        },
      })

      return builder
    },
  }
}

jest.mock('@/lib/supabase/server', () => ({
  createServerSupabaseClient: () => makeClient(),
}))

beforeEach(() => {
  updatePatch = null
  auditRow = null
  updateRejected = false
  existingOrder = { id: ORDER_ID, restaurant_id: RESTAURANT_ID, status: 'pending' }
})

async function cancel(body: Record<string, unknown>) {
  const res = await PATCH(
    new Request(`https://example.test/api/orders/${ORDER_ID}/status`, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'cancelled', ...body }),
    }),
    { params: Promise.resolve({ orderId: ORDER_ID }) },
  )
  return { status: res.status, body: (await res.json()) as Record<string, unknown> }
}

/** The reason as it was written to the two places that record it. */
function recordedReason() {
  return {
    column: updatePatch?.cancellation_reason,
    audit: (auditRow?.metadata as Record<string, unknown> | undefined)?.cancellation_reason,
    suppliedByCaller: (auditRow?.metadata as Record<string, unknown> | undefined)
      ?.reason_supplied_by_caller,
  }
}

describe('#103 — cancellation_reason must be a string', () => {
  it('does not store "[object Object]" when the reason is an object', async () => {
    await cancel({ reason: { a: 1 } })

    const { column, audit } = recordedReason()
    expect(column).not.toBe('[object Object]')
    expect(column).toBe('staff_cancelled')
    expect(audit).toBe('staff_cancelled')
  })

  it('does not store a comma-joined array', async () => {
    await cancel({ cancellation_reason: ['a', 'b'] })

    const { column, audit } = recordedReason()
    expect(column).not.toBe('a,b')
    expect(column).toBe('staff_cancelled')
    expect(audit).toBe('staff_cancelled')
  })

  it('does not stringify a number into the reason', async () => {
    await cancel({ cancellationReason: 42 })

    const { column } = recordedReason()
    expect(column).not.toBe('42')
    expect(column).toBe('staff_cancelled')
  })

  it('does not stringify a boolean or null into the reason', async () => {
    await cancel({ reason: true })
    expect(recordedReason().column).toBe('staff_cancelled')

    updatePatch = null
    auditRow = null
    updateRejected = false
    await cancel({ reason: null })
    expect(recordedReason().column).toBe('staff_cancelled')
  })

  it('records a non-string reason as NOT supplied by the caller', async () => {
    // The audit row's own account of itself has to stay truthful: nothing usable was supplied.
    await cancel({ reason: { a: 1 } })

    expect(recordedReason().suppliedByCaller).toBe(false)
  })

  it('still accepts a genuine string reason, under all three spellings', async () => {
    await cancel({ reason: 'table walked out' })
    expect(recordedReason()).toMatchObject({
      column: 'table walked out',
      audit: 'table walked out',
      suppliedByCaller: true,
    })

    updatePatch = null
    auditRow = null
    updateRejected = false
    await cancel({ cancellation_reason: '  duplicate order  ' })
    expect(recordedReason().column).toBe('duplicate order')

    updatePatch = null
    auditRow = null
    updateRejected = false
    await cancel({ cancellationReason: 'kitchen out of stock' })
    expect(recordedReason().column).toBe('kitchen out of stock')
  })
})

describe('#103 — cancellation_reason must be length-capped', () => {
  it('truncates a 10,000-character reason in the column AND in the audit metadata', async () => {
    await cancel({ reason: 'x'.repeat(10_000) })

    const { column, audit } = recordedReason()
    expect(String(column)).toHaveLength(MAX_REASON_LENGTH)
    expect(String(audit)).toHaveLength(MAX_REASON_LENGTH)
  })

  it('leaves a reason at the limit untouched', async () => {
    const atLimit = 'y'.repeat(MAX_REASON_LENGTH)
    await cancel({ reason: atLimit })

    expect(recordedReason().column).toBe(atLimit)
  })

  it('still counts a truncated reason as supplied by the caller', async () => {
    await cancel({ reason: 'z'.repeat(10_000) })

    expect(recordedReason().suppliedByCaller).toBe(true)
  })
})

describe('#103 — the effect on order state is unchanged', () => {
  it('still cancels, closes and voids payment when the reason is unusable', async () => {
    // The guard the seat's 10-case matrix rests on: normalising a bad reason must not turn a
    // cancel into a rejection.
    const { status, body } = await cancel({ reason: { a: 1 } })

    expect(status).toBe(200)
    expect(body.success).toBe(true)
    expect(updatePatch).toMatchObject({
      status: 'cancelled',
      is_closed: true,
      payment_status: 'cancelled',
    })
    expect(updatePatch?.cancelled_at).toEqual(expect.any(String))
  })

  it('still writes the order.cancelled audit row when the reason is unusable', async () => {
    await cancel({ reason: 'q'.repeat(10_000) })

    expect(auditRow).toMatchObject({
      restaurant_id: RESTAURANT_ID,
      action: 'order.cancelled',
      entity_type: 'order',
      entity_id: ORDER_ID,
    })
    expect((auditRow?.metadata as Record<string, unknown>).previous_status).toBe('pending')
    expect((auditRow?.metadata as Record<string, unknown>).staff_user_id).toBe('staff-1')
  })

  it('leaves non-cancel transitions alone', async () => {
    const res = await PATCH(
      new Request(`https://example.test/api/orders/${ORDER_ID}/status`, {
        method: 'PATCH',
        body: JSON.stringify({ status: 'accepted', reason: { a: 1 } }),
      }),
      { params: Promise.resolve({ orderId: ORDER_ID }) },
    )

    expect(res.status).toBe(200)
    expect(updatePatch).toMatchObject({ status: 'accepted' })
    expect(updatePatch).not.toHaveProperty('cancellation_reason')
    expect(auditRow).toBeNull()
  })
})

describe('#103 — truncation must not split a surrogate pair', () => {
  /**
   * 281 UTF-16 code units, and unit 280 is the HIGH half of the last emoji. A cap that counts
   * code units cuts between the halves and emits a lone surrogate.
   *
   * That lone surrogate does not merely corrupt the reason. It travels in the SAME update as
   * status/is_closed/payment_status, and again in the audit row's JSONB metadata, and Postgres
   * cannot encode it as UTF-8 — so PostgREST rejects the whole request with PGRST102 and the
   * order is never cancelled at all. The first version of this fix turned a working cancellation
   * into a 400 for these inputs, which is precisely the state-effect change it argued against.
   */
  const SPLITTING_REASON = 'a' + '😀'.repeat(140)

  it('cancels the order rather than failing on an invalid-JSON rejection', async () => {
    const { status, body } = await cancel({ reason: SPLITTING_REASON })

    expect(status).toBe(200)
    expect(body.success).toBe(true)
    expect(updatePatch).toMatchObject({
      status: 'cancelled',
      is_closed: true,
      payment_status: 'cancelled',
    })
  })

  it('writes a well-formed reason to the column and the audit metadata', async () => {
    await cancel({ reason: SPLITTING_REASON })

    const { column, audit } = recordedReason()
    expect(hasLoneSurrogate(String(column))).toBe(false)
    expect(hasLoneSurrogate(String(audit))).toBe(false)
    expect(auditRow).not.toBeNull()
  })

  it('caps on code points, not UTF-16 code units', async () => {
    // 400 emoji = 800 code units. The cap must keep 280 CODE POINTS, so the stored string is
    // 560 units long — longer than 280 units, and correct.
    await cancel({ reason: '😀'.repeat(400) })

    const column = String(recordedReason().column)
    expect(Array.from(column)).toHaveLength(MAX_REASON_LENGTH)
    expect(hasLoneSurrogate(column)).toBe(false)
  })

  it('still truncates plain ASCII to exactly the cap', async () => {
    // The control that would catch a "fix" that simply stopped truncating.
    await cancel({ reason: 'x'.repeat(10_000) })

    expect(String(recordedReason().column)).toHaveLength(MAX_REASON_LENGTH)
  })

  it('CONTROL: the fake really can reject a lone surrogate', async () => {
    // Without this, every test above would pass against a fake that silently accepts anything.
    expect(hasLoneSurrogate('a' + '😀'.repeat(140)).valueOf()).toBe(false)
    expect(hasLoneSurrogate(('a' + '😀'.repeat(140)).slice(0, 280))).toBe(true)
    expect(loneSurrogateIn({ metadata: { r: '\uD83D' } })).toBe(true)
  })
})
