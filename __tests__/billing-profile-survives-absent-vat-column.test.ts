/**
 * Settings -> Billing must work on a database that has not had migration 20260901120000 applied.
 *
 * ================================================================================================
 * THE OUTAGE THESE TESTS CLOSE
 * ================================================================================================
 *
 * `restaurant_billing_profiles.vat_registered` arrives with migration 20260901120000, whose own
 * header records that it is applied on STAGING and that applying it to production is a separate,
 * deliberate step which has not been taken.
 *
 * The route selected that column in the same string as the six that do exist. PostgREST rejects
 * the whole select when one column is unknown, so on production:
 *
 *     select=registration_number,...,vat_registered  ->  400  42703  column ... does not exist
 *     select=registration_number,...                 ->  200  []
 *
 * Verified read-only against production 2026-09-13. Both GET and PATCH threw, both answered 500,
 * and the Settings page showed "Could not load billing profile" at every venue. That is why
 * `restaurant_billing_profiles` has ZERO rows in production: saving was never possible.
 *
 * ================================================================================================
 * THE RULE THESE TESTS DEFEND
 * ================================================================================================
 *
 * A column the database cannot yet hold costs exactly that column, never the other six. And an
 * explicit VAT-registration answer is never SILENTLY DROPPED -- a merchant told "Billing saved"
 * must not later find that the compliance answer they gave was discarded. It is refused instead.
 */
import { NextResponse } from 'next/server'
import { InMemoryDb, testUuid } from './helpers/in-memory-postgrest'

const RESTAURANT_ID = testUuid('b111')
const OTHER_RESTAURANT_ID = testUuid('b222')

const COLUMN_ABSENT = {
  code: '42703',
  message: 'column restaurant_billing_profiles.vat_registered does not exist',
}

type Mode = 'column_absent' | 'column_present'

let db: InMemoryDb
let mode: Mode
let permissionDenied: boolean
let callerRestaurantId: string | null
let authThrows: boolean

/**
 * Wraps the in-memory client so that a select naming `vat_registered` fails exactly the way
 * production's PostgREST fails, and only that select. Everything else behaves normally, which is
 * what makes this a reproduction of the outage rather than a table that is simply broken.
 */
function clientForMode() {
  const base = db.client()
  if (mode === 'column_present') return base
  return {
    ...base,
    from(table: string) {
      const builder = base.from(table)
      const originalSelect = builder.select.bind(builder)
      builder.select = (cols?: string) => {
        if (table === 'restaurant_billing_profiles' && cols?.includes('vat_registered')) {
          const failing = {
            eq: () => failing,
            maybeSingle: async () => ({ data: null, error: COLUMN_ABSENT }),
            single: async () => ({ data: null, error: COLUMN_ABSENT }),
            then: (resolve: (v: { data: unknown; error: unknown }) => unknown) =>
              resolve({ data: null, error: COLUMN_ABSENT }),
          }
          return failing as unknown as ReturnType<typeof originalSelect>
        }
        return originalSelect(cols)
      }
      return builder
    },
  }
}

jest.mock('@/lib/supabase/server', () => ({
  createServerSupabaseClient: () => clientForMode(),
}))

jest.mock('@/lib/supabase/admin-restaurant-auth', () => ({
  getUserFromRequest: async () => {
    if (authThrows) throw new Error('Unauthorized')
    return { id: 'user-billing' }
  },
  requireCallerRestaurantId: async () =>
    callerRestaurantId ??
    NextResponse.json({ error: 'You do not have permission to perform this action.' }, { status: 403 }),
}))

jest.mock('@/lib/permissions/authorize', () => ({
  requirePermission: async () =>
    permissionDenied
      ? NextResponse.json({ error: 'You do not have permission to perform this action.' }, { status: 403 })
      : null,
}))

 
const route = require('@/app/api/admin/restaurants/[id]/billing-profile/route') as {
  GET: (req: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response>
  PATCH: (req: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response>
}

const ctx = (id = RESTAURANT_ID) => ({ params: Promise.resolve({ id }) })

function patchRequest(body: unknown) {
  return new Request('http://localhost/api/admin/restaurants/x/billing-profile', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

const getRequest = (_id?: string) =>
  new Request('http://localhost/api/admin/restaurants/x/billing-profile')

const FULL_PROFILE = {
  registration_number: 'CC/2026/0001',
  vat_number: 'VAT-778899',
  bank_name: 'Bank Windhoek',
  bank_account_name: 'Riviera Trading CC',
  bank_account_number: '8001 2233 44',
  bank_branch_code: '481972',
}

beforeEach(() => {
  db = new InMemoryDb(
    { restaurant_billing_profiles: [] },
    { restaurant_billing_profiles: { unique: [['restaurant_id']] } },
  )
  mode = 'column_absent'
  permissionDenied = false
  callerRestaurantId = RESTAURANT_ID
  authThrows = false
})

// ── GET ──────────────────────────────────────────────────────────────────────

describe('GET billing profile', () => {
  test('an empty profile loads as 200 on a database with no vat_registered column', async () => {
    const res = await route.GET(getRequest(), ctx())
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.billingProfile.registration_number).toBeNull()
    expect(body.billingProfile.vat_registered).toBeNull()
    expect(body.vatRegistrationSupported).toBe(false)
  })

  test('an existing profile loads all six text fields when the column is absent', async () => {
    db.rows('restaurant_billing_profiles').push({ restaurant_id: RESTAURANT_ID, ...FULL_PROFILE })

    const res = await route.GET(getRequest(), ctx())
    expect(res.status).toBe(200)
    const body = await res.json()

    // The whole point: one absent column must not take the other six down with it.
    expect(body.billingProfile).toMatchObject(FULL_PROFILE)
    expect(body.billingProfile.vat_registered).toBeNull()
  })

  test('the real answer is returned when the column exists', async () => {
    mode = 'column_present'
    db.rows('restaurant_billing_profiles').push({
      restaurant_id: RESTAURANT_ID,
      ...FULL_PROFILE,
      vat_registered: true,
    })

    const res = await route.GET(getRequest(), ctx())
    const body = await res.json()
    expect(body.billingProfile.vat_registered).toBe(true)
    expect(body.vatRegistrationSupported).toBe(true)
  })

  test('an unauthenticated caller gets 401 and no profile', async () => {
    authThrows = true
    const res = await route.GET(getRequest(), ctx())
    expect(res.status).toBe(401)
    expect((await res.json()).billingProfile).toBeUndefined()
  })

  test('a caller without documents:read gets 403', async () => {
    permissionDenied = true
    const res = await route.GET(getRequest(), ctx())
    expect(res.status).toBe(403)
  })

  test('a cross-restaurant read is refused before any row is returned', async () => {
    db.rows('restaurant_billing_profiles').push({
      restaurant_id: OTHER_RESTAURANT_ID,
      ...FULL_PROFILE,
    })
    callerRestaurantId = null // requireCallerRestaurantId returns its 403

    const res = await route.GET(getRequest(OTHER_RESTAURANT_ID), ctx(OTHER_RESTAURANT_ID))
    expect(res.status).toBe(403)
    const body = await res.json()
    expect(JSON.stringify(body)).not.toContain('Riviera Trading CC')
  })
})

// ── PATCH ────────────────────────────────────────────────────────────────────

describe('PATCH billing profile', () => {
  test('saves a new profile on a database with no vat_registered column', async () => {
    const res = await route.PATCH(patchRequest(FULL_PROFILE), ctx())
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.success).toBe(true)
    expect(body.billingProfile).toMatchObject(FULL_PROFILE)

    const stored = db.rows('restaurant_billing_profiles')
    expect(stored).toHaveLength(1)
    expect(stored[0]).toMatchObject({ restaurant_id: RESTAURANT_ID, ...FULL_PROFILE })
    // Never written where it cannot exist.
    expect(stored[0].vat_registered).toBeUndefined()
  })

  test('updates an existing profile in place rather than inserting a second row', async () => {
    db.rows('restaurant_billing_profiles').push({ restaurant_id: RESTAURANT_ID, ...FULL_PROFILE })

    const res = await route.PATCH(
      patchRequest({ ...FULL_PROFILE, bank_name: 'First National Bank' }),
      ctx(),
    )
    expect(res.status).toBe(200)

    const stored = db.rows('restaurant_billing_profiles')
    expect(stored).toHaveLength(1)
    expect(stored[0].bank_name).toBe('First National Bank')
  })

  test('an explicit VAT registration answer is REFUSED, not silently dropped', async () => {
    const res = await route.PATCH(
      patchRequest({ ...FULL_PROFILE, vat_registered: true }),
      ctx(),
    )

    expect(res.status).toBe(409)
    expect((await res.json()).code).toBe('VAT_REGISTRATION_UNAVAILABLE')
    // Atomic: the refusal happens before anything is written.
    expect(db.rows('restaurant_billing_profiles')).toHaveLength(0)
  })

  test('an explicit VAT registration answer is stored when the column exists', async () => {
    mode = 'column_present'
    const res = await route.PATCH(
      patchRequest({ ...FULL_PROFILE, vat_registered: true }),
      ctx(),
    )
    expect(res.status).toBe(200)
    expect(db.rows('restaurant_billing_profiles')[0].vat_registered).toBe(true)
  })

  test('vat_number is required when the merchant claims registration', async () => {
    mode = 'column_present'
    const res = await route.PATCH(
      patchRequest({ ...FULL_PROFILE, vat_number: null, vat_registered: true }),
      ctx(),
    )
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/vat_number is required/i)
    expect(db.rows('restaurant_billing_profiles')).toHaveLength(0)
  })

  test('a bank account number with letters is refused', async () => {
    const res = await route.PATCH(
      patchRequest({ ...FULL_PROFILE, bank_account_number: 'ACC-12x' }),
      ctx(),
    )
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/digits, spaces, and hyphens/i)
    expect(db.rows('restaurant_billing_profiles')).toHaveLength(0)
  })

  test('an over-long field is refused', async () => {
    const res = await route.PATCH(
      patchRequest({ ...FULL_PROFILE, registration_number: 'x'.repeat(101) }),
      ctx(),
    )
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/must not exceed 100 characters/i)
  })

  test('a non-string field is refused as an invalid payload', async () => {
    const res = await route.PATCH(patchRequest({ bank_name: 42 }), ctx())
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/Invalid billing profile payload/i)
  })

  test('a caller without documents:write gets 403 and writes nothing', async () => {
    permissionDenied = true
    const res = await route.PATCH(patchRequest(FULL_PROFILE), ctx())
    expect(res.status).toBe(403)
    expect(db.rows('restaurant_billing_profiles')).toHaveLength(0)
  })

  test('a cross-restaurant write is refused and writes nothing', async () => {
    callerRestaurantId = null
    const res = await route.PATCH(patchRequest(FULL_PROFILE), ctx(OTHER_RESTAURANT_ID))
    expect(res.status).toBe(403)
    expect(db.rows('restaurant_billing_profiles')).toHaveLength(0)
  })

  test('the restaurant_id written is the authorized one, never the client-supplied one', async () => {
    // The route is handed OTHER_RESTAURANT_ID in the URL, but authorization resolves RESTAURANT_ID.
    callerRestaurantId = RESTAURANT_ID
    const res = await route.PATCH(patchRequest(FULL_PROFILE), ctx(OTHER_RESTAURANT_ID))
    expect(res.status).toBe(200)
    expect(db.rows('restaurant_billing_profiles')[0].restaurant_id).toBe(RESTAURANT_ID)
  })
})
