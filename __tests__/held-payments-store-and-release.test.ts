/**
 * #344 RULING 3 — POST /api/terminal/held-payments, the durable write the device treats as an
 * acknowledgement.
 *
 * THE TEST THAT MATTERS is 'a re-POST returns the SAME receiptId and writes no second row'. On a
 * 2xx carrying `stored: true` the terminal DELETES its only copy of a card transaction, so an
 * endpoint that answered 200 without having written would destroy the record it was asked to
 * preserve. Everything else here exists so that one cannot be satisfied trivially -- a route that
 * always answered 500 would also never destroy anything, and would be useless.
 *
 * The second-most-important group is the 400s, and it is the inverse worry. A non-2xx means the
 * device keeps holding, which is correct when nothing was written and a disaster when the write
 * COULD have happened but a validation rule declined it: the operator then has no way to clear a
 * record that will never be accepted. So these tests assert what the route REFUSES to validate as
 * much as what it validates.
 *
 * ============================================================================================
 * WHAT THIS FILE CANNOT PROVE, FOUND BY MUTATION AND WORTH KNOWING BEFORE TRUSTING IT
 * ============================================================================================
 *
 * Disabling the read-first branch entirely -- so the route never returns an existing receiptId and
 * always attempts an insert -- leaves all 24 tests GREEN. That is not a hole in the suite; it is
 * the design becoming visible. The insert then violates the unique index, the route takes the
 * 23505 branch, re-reads, and returns the stored id. Behaviour is identical.
 *
 * SO THE TWO-SIDED PROPERTY RESTS ON `held_payments_idempotency_unique`, NOT ON THE READ. The read
 * is an optimisation for the common case (a device retrying after a response it never received).
 * If that constraint is absent on a database, a re-POST writes a second row and issues a second
 * receiptId, and NOTHING IN THIS FILE WOULD NOTICE -- the mock enforces uniqueness because it was
 * written to, which is exactly the way a mock lies.
 *
 * The constraint's existence is therefore checked where it can be: against a live database, by
 * `scripts/verify-held-payments-staging.ts`, which POSTs the same record twice through the
 * deployed route and asserts one row and one receiptId.
 */
import { POST } from '@/app/api/terminal/held-payments/route'
import { HELD_PAYMENT_RECEIPT_ID_PATTERN } from '@/lib/payments/held-payment-receipt-id'

const RESTAURANT = 'aaaaaaaa-0000-0000-0000-000000000001'

type Row = Record<string, unknown>

let terminalPermissions: string[] = ['orders:update']
let authThrows: Response | null = null
let stored: Row[] = []
let readError: unknown = null
let insertErrorOverride: { code?: string; message: string } | null = null
/** Simulates another request winning the race between our read and our insert. */
let insertRacesInARow: Row | null = null

jest.mock('@/lib/terminal-auth', () => ({
  requireTerminalAuth: jest.fn(async () => {
    if (authThrows) throw authThrows
    return {
      terminalId: 'terminal-1',
      restaurantId: RESTAURANT,
      deviceSerial: 'SN-1',
      permissions: terminalPermissions,
    }
  }),
  validateTerminalRecord: jest.fn(async () => undefined),
}))

jest.mock('@/lib/supabase/server', () => ({
  createServerSupabaseClient: () => ({
    from(table: string) {
      if (table !== 'held_payments') throw new Error(`unexpected table ${table}`)
      const conditions: Record<string, unknown> = {}
      const builder: Record<string, unknown> = {
        select() {
          return builder
        },
        eq(col: string, val: unknown) {
          conditions[col] = val
          return builder
        },
        async maybeSingle() {
          if (readError) return { data: null, error: readError }
          const hit = stored.find(
            (r) =>
              r.restaurant_id === conditions.restaurant_id &&
              r.idempotency_key === conditions.idempotency_key,
          )
          return { data: hit ? { receipt_id: hit.receipt_id } : null, error: null }
        },
        async insert(row: Row) {
          if (insertErrorOverride) return { error: insertErrorOverride }
          if (insertRacesInARow) {
            // The row the racing writer stored lands first; ours violates the unique index.
            stored.push(insertRacesInARow)
            insertRacesInARow = null
            return { error: { code: '23505', message: 'duplicate key value' } }
          }
          const clash = stored.some(
            (r) =>
              r.restaurant_id === row.restaurant_id &&
              r.idempotency_key === row.idempotency_key,
          )
          if (clash) return { error: { code: '23505', message: 'duplicate key value' } }
          stored.push(row)
          return { error: null }
        },
      }
      return builder
    },
  }),
}))

const post = (body: unknown) =>
  POST(
    new Request('http://localhost/api/terminal/held-payments', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer t' },
      body: JSON.stringify(body),
    }),
  )

const RECORD = {
  idempotencyKey: '15|FT1787292588945|2026-08-26T09:15:00.123Z',
  businessOrderNo: 'FT1787292588945',
  voucherNo: 'V-001',
  heldAt: '2026-08-26T09:15:00.123Z',
  orphanOrderId: 'order-A',
  seenWhileChargingOrderId: 'order-B',
  reason: 'different_order',
  outcomeKind: 'orphaned_success',
}

beforeEach(() => {
  terminalPermissions = ['orders:update']
  authThrows = null
  stored = []
  readError = null
  insertErrorOverride = null
  insertRacesInARow = null
})

describe('the first POST stores and issues a receipt', () => {
  it('writes one row and answers stored:true with a receiptId', async () => {
    const res = await post(RECORD)
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.stored).toBe(true)
    expect(json.receiptId).toMatch(HELD_PAYMENT_RECEIPT_ID_PATTERN)
    expect(stored).toHaveLength(1)
  })

  it('stores every fact the device sent', async () => {
    await post(RECORD)
    expect(stored[0]).toMatchObject({
      restaurant_id: RESTAURANT,
      terminal_id: 'terminal-1',
      idempotency_key: RECORD.idempotencyKey,
      business_order_no: 'FT1787292588945',
      voucher_no: 'V-001',
      orphan_order_id: 'order-A',
      seen_while_charging_order_id: 'order-B',
      reason: 'different_order',
      outcome_kind: 'orphaned_success',
    })
    expect(stored[0].held_at).toBe('2026-08-26T09:15:00.123Z')
  })

  it('takes restaurant_id from the TOKEN, never from the body', async () => {
    // Cross-tenant. The body is device-supplied and the token is verified; a route that trusted
    // the body would let one terminal write evidence into another venue's ledger.
    await post({ ...RECORD, restaurantId: 'ffffffff-0000-0000-0000-00000000ffff' })
    expect(stored[0].restaurant_id).toBe(RESTAURANT)
  })

  it('THE RESPONSE CARRIES TWO FIELDS AND NOTHING ELSE — ruling 4', async () => {
    // "A field the device must ignore is a field someone will eventually read." The route knows
    // things it must not say -- whether the row was new, whether the business_order_no resolves --
    // so the assertion is on the exact key set, not on the two keys being present.
    const json = await (await post(RECORD)).json()
    expect(Object.keys(json).sort()).toEqual(['receiptId', 'stored'])
    expect(json).not.toHaveProperty('matchedOrderId')
  })
})

describe('a re-POST of the same record — the two-sided property', () => {
  it('returns the SAME receiptId and writes no second row', async () => {
    const first = await (await post(RECORD)).json()
    const second = await (await post(RECORD)).json()

    expect(second.stored).toBe(true)
    expect(second.receiptId).toBe(first.receiptId)
    expect(stored).toHaveLength(1)
  })

  it('is stable across many re-POSTs', async () => {
    const first = await (await post(RECORD)).json()
    for (let i = 0; i < 5; i++) {
      const again = await (await post(RECORD)).json()
      expect(again.receiptId).toBe(first.receiptId)
    }
    expect(stored).toHaveLength(1)
  })

  it('a DIFFERENT heldAt is a different record and gets its own row', async () => {
    // The deliberate asymmetry in the key: re-holding the same transaction produces a new heldAt
    // and is stored twice. A duplicate row is a bookkeeping annoyance; a released-but-unstored
    // record is a lost card transaction.
    await post(RECORD)
    await post({
      ...RECORD,
      idempotencyKey: '15|FT1787292588945|2026-08-26T09:19:44.900Z',
      heldAt: '2026-08-26T09:19:44.900Z',
    })
    expect(stored).toHaveLength(2)
  })

  it('a race that loses the unique index still returns the WINNER\'s receiptId', async () => {
    // 23505 between our read and our insert. The state the ruling cares about -- it exists
    // somewhere other than the device -- is satisfied, so this is an acknowledgement. It must
    // return the STORED id, not the one we generated and did not store.
    insertRacesInARow = {
      restaurant_id: RESTAURANT,
      idempotency_key: RECORD.idempotencyKey,
      receipt_id: 'HP-WINNER22',
    }
    const json = await (await post(RECORD)).json()
    expect(json).toEqual({ stored: true, receiptId: 'HP-WINNER22' })
    expect(stored).toHaveLength(1)
  })

  it('a 23505 with NO matching row is a 500, not an acknowledgement', async () => {
    // Something other than a duplicate produced the violation, so we do not know the record is
    // stored. Answering 200 here would release a transaction that exists nowhere.
    insertErrorOverride = { code: '23505', message: 'duplicate key value' }
    const res = await post(RECORD)
    expect(res.status).toBe(500)
  })
})

describe('what it REFUSES to validate — evidence is stored as sent', () => {
  it('stores a case-3 record that names no order at all', async () => {
    // The record verify-payment can never resolve, and the whole reason ruling 1 replaced
    // reconciliation with a durable write.
    const res = await post({ ...RECORD, orphanOrderId: '', reason: 'unknown_order' })
    expect(res.status).toBe(200)
    expect(stored[0].orphan_order_id).toBeNull()
    expect(stored[0].reason).toBe('unknown_order')
  })

  it('stores an orphanOrderId that is not a uuid', async () => {
    // No FK, no format check. A device-supplied id that does not resolve is still evidence.
    const res = await post({ ...RECORD, orphanOrderId: 'not-a-uuid-at-all' })
    expect(res.status).toBe(200)
    expect(stored[0].orphan_order_id).toBe('not-a-uuid-at-all')
  })

  it('stores a reason this build has never heard of', async () => {
    // An APK in the field outlives any given deploy. Refusing an unknown enum would strand the
    // record on that device permanently.
    const res = await post({ ...RECORD, reason: 'some_future_reason' })
    expect(res.status).toBe(200)
    expect(stored[0].reason).toBe('some_future_reason')
  })

  it('stores a record with no voucher and no businessOrderNo', async () => {
    const res = await post({ ...RECORD, voucherNo: '', businessOrderNo: '' })
    expect(res.status).toBe(200)
    expect(stored[0].voucher_no).toBeNull()
    expect(stored[0].business_order_no).toBeNull()
  })

  it('normalises whitespace-only fields to null rather than storing blanks', async () => {
    await post({ ...RECORD, voucherNo: '   ' })
    expect(stored[0].voucher_no).toBeNull()
  })
})

describe('the only two 400s, and they are both device-computed fields', () => {
  it('400 when idempotencyKey is missing — the row cannot be addressed', async () => {
    const res = await post({ ...RECORD, idempotencyKey: '' })
    expect(res.status).toBe(400)
    expect(stored).toHaveLength(0)
  })

  it('400 when heldAt is missing', async () => {
    const res = await post({ ...RECORD, heldAt: '' })
    expect(res.status).toBe(400)
  })

  it('400 when heldAt does not parse', async () => {
    const res = await post({ ...RECORD, heldAt: 'yesterday-ish' })
    expect(res.status).toBe(400)
    expect(stored).toHaveLength(0)
  })

  it('an empty body is a 400 and not a crash', async () => {
    const res = await post({})
    expect(res.status).toBe(400)
  })
})

describe('auth and failure — every non-2xx leaves the device holding', () => {
  it('returns the thrown Response unchanged, so a 401 stays a 401', async () => {
    // requireTerminalAuth throws a Response, not an Error. An `instanceof Error` check here would
    // turn every expired token into a 500 and the device would never refresh.
    authThrows = new Response(JSON.stringify({ error: 'Missing terminal token' }), { status: 401 })
    const res = await post(RECORD)
    expect(res.status).toBe(401)
    expect(stored).toHaveLength(0)
  })

  it('a NON-Response throw from auth is still 401, not 500', async () => {
    /*
     * FOUND ON PRODUCTION, NOT HERE, AND THE MOCK IS WHY.
     *
     * `requireTerminalAuth` throws a `Response` for a MISSING header, but for a malformed or
     * expired token it calls jose's `jwtVerify`, which throws a JOSEError. The first version of
     * this route had one outer catch that answered 500 for anything that was not a Response, so
     * `Bearer not-a-real-token` returned 500 on all four production hostnames.
     *
     * That is not cosmetic: `terminalFetch` refreshes the token and retries on 401 and NOT on 500,
     * so a device with an hour-old token would have been answered 500 forever and never recovered
     * -- on the one flow whose purpose is releasing a card transaction that exists nowhere else.
     *
     * This suite could not have caught it, because it MOCKS terminal-auth (it must; jose is
     * ESM-only and ts-jest cannot load it) and the mock threw the one shape the old code handled.
     * So the mock is now made to throw the other shape too.
     */
    authThrows = new Error('JWSInvalid: Invalid Compact JWS') as unknown as Response
    const res = await post(RECORD)
    expect(res.status).toBe(401)
    expect(stored).toHaveLength(0)
  })

  it('403 without orders:update', async () => {
    terminalPermissions = ['orders:read']
    const res = await post(RECORD)
    expect(res.status).toBe(403)
    expect(stored).toHaveLength(0)
  })

  it('500 when the lookup fails — an unreadable table is not an acknowledgement', async () => {
    readError = { message: 'connection reset' }
    const res = await post(RECORD)
    expect(res.status).toBe(500)
    expect(stored).toHaveLength(0)
  })

  it('500 when the insert fails for any other reason', async () => {
    insertErrorOverride = { code: '23514', message: 'check violation' }
    const res = await post(RECORD)
    expect(res.status).toBe(500)
  })

  it('no failure path ever answers stored:true', async () => {
    // The single property the device depends on. Asserted across every failure this route models,
    // because a 200 with stored:true is what deletes the transaction.
    const failures: Array<() => void> = [
      () => { terminalPermissions = ['orders:read'] },
      () => { readError = { message: 'down' } },
      () => { insertErrorOverride = { code: '23514', message: 'nope' } },
      () => { authThrows = new Response('{}', { status: 401 }) },
      () => { authThrows = new Error('JWSInvalid') as unknown as Response },
    ]
    for (const arrange of failures) {
      stored = []
      terminalPermissions = ['orders:update']
      authThrows = null
      readError = null
      insertErrorOverride = null
      arrange()
      const res = await post(RECORD)
      const json = await res.json().catch(() => ({}))
      expect(json.stored).not.toBe(true)
    }
  })
})

describe('the receipt id is meant to be read aloud', () => {
  it('is uppercase, prefixed, and free of the characters people mistype', async () => {
    const seen = new Set<string>()
    for (let i = 0; i < 200; i++) {
      stored = []
      const { receiptId } = await (await post(RECORD)).json()
      expect(receiptId).toMatch(HELD_PAYMENT_RECEIPT_ID_PATTERN)
      // I/L/1 and O/0 are the pairs that get mistyped; U is out so no run spells a word.
      expect(receiptId.slice(3)).not.toMatch(/[ILOU01]/)
      seen.add(receiptId)
    }
    // Not a randomness test, a not-a-constant test: an id generator that returned the same string
    // every time would pass every other assertion in this file.
    expect(seen.size).toBeGreaterThan(150)
  })
})
