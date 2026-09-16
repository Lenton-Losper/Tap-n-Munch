/**
 * PATCH /api/admin/restaurants/[id]/billing-profile IS A PATCH.
 *
 * ================================================================================================
 * THE TWO DEFECTS THESE TESTS CLOSE, AND WHY THEY ARE ONE DEFECT
 * ================================================================================================
 *
 * The route used to build the profile it would write by starting from `emptyBillingProfile()` and
 * filling in whatever keys the request happened to carry. Every key the request did not carry came
 * back as an explicit `null`, and from that point on nothing could tell "the merchant cleared this
 * field" apart from "the request never mentioned it".
 *
 *   D1  DESTRUCTIVE SAVE. Settings -> Billing sends the six text fields and no `vat_registered`.
 *       The absent key became `vat_registered: null` and was UPSERT into the row, so saving a bank
 *       branch code silently un-answered the venue's VAT registration -- and said "Billing saved".
 *
 *   D2  FALSE REFUSAL. `PATCH {"vat_registered": true}` became
 *       `{vat_registered: true, vat_number: null, ...}`, so validation refused it with
 *       "vat_number is required when the business is VAT registered" against a stored profile that
 *       had a VAT number all along. Validation was judging the REQUEST, not the resulting row.
 *
 * Both are the same mistake seen from two sides, so both are fixed in one place: the patch is
 * merged over the stored profile, and it is the merged row -- what the database will hold after
 * the write -- that is validated and written.
 *
 * ================================================================================================
 * WHAT WOULD MAKE THESE TESTS GO RED AGAIN
 * ================================================================================================
 *
 * Reintroducing `emptyBillingProfile()` as the basis of the update. Verified by doing exactly that
 * on 2026-09-16: the five tests marked D1/D2 below fail, and the rest of the suite still passes --
 * which is the point, since the happy path never noticed this defect in the first place.
 */
import { NextResponse } from 'next/server'
import { InMemoryDb, testUuid } from './helpers/in-memory-postgrest'

const RESTAURANT_ID = testUuid('c111')

const COLUMN_ABSENT = {
  code: '42703',
  message: 'column restaurant_billing_profiles.vat_registered does not exist',
}

type Mode = 'column_absent' | 'column_present'

let db: InMemoryDb
let mode: Mode

/** `vat_registered` fails exactly as production's PostgREST fails, and only that select. */
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
  getUserFromRequest: async () => ({ id: 'user-billing' }),
  requireCallerRestaurantId: async () => RESTAURANT_ID,
}))

jest.mock('@/lib/permissions/authorize', () => ({
  requirePermission: async () => null,
}))


const route = require('@/app/api/admin/restaurants/[id]/billing-profile/route') as {
  GET: (req: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response>
  PATCH: (req: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response>
}

const ctx = () => ({ params: Promise.resolve({ id: RESTAURANT_ID }) })

function patchRequest(body: unknown) {
  return new Request('http://localhost/api/admin/restaurants/x/billing-profile', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

const getRequest = () => new Request('http://localhost/api/admin/restaurants/x/billing-profile')

/** The six text fields, exactly as the Settings form sends them. */
const TEXT_FIELDS = {
  registration_number: 'CC/2026/0001',
  vat_number: 'VAT-778899',
  bank_name: 'Bank Windhoek',
  bank_account_name: 'Riviera Trading CC',
  bank_account_number: '8001 2233 44',
  bank_branch_code: '481972',
}

function seedProfile(extra: Record<string, unknown> = {}) {
  db.rows('restaurant_billing_profiles').push({
    restaurant_id: RESTAURANT_ID,
    ...TEXT_FIELDS,
    ...extra,
  })
}

function storedRow() {
  const rows = db.rows('restaurant_billing_profiles')
  expect(rows).toHaveLength(1)
  return rows[0]
}

beforeEach(() => {
  db = new InMemoryDb(
    { restaurant_billing_profiles: [] },
    { restaurant_billing_profiles: { unique: [['restaurant_id']] } },
  )
  mode = 'column_present'
})

// ── D1: an omitted field keeps its stored value ──────────────────────────────

describe('D1 — a save of unrelated fields does not wipe what it did not mention', () => {
  test('the exact body the Settings form sends leaves vat_registered = true alone', async () => {
    seedProfile({ vat_registered: true })

    // Byte for byte what components/settings/settings-billing-tab.tsx sent before it grew a VAT
    // control: six text fields, one of them edited, and no mention of vat_registered at all.
    const res = await route.PATCH(
      patchRequest({ ...TEXT_FIELDS, bank_branch_code: '482872' }),
      ctx(),
    )

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.billingProfile.bank_branch_code).toBe('482872')
    // The whole defect, in one assertion.
    expect(body.billingProfile.vat_registered).toBe(true)
    expect(storedRow().vat_registered).toBe(true)
  })

  test('an explicit vat_registered = false is equally not wiped by an unrelated save', async () => {
    seedProfile({ vat_registered: false })

    await route.PATCH(patchRequest({ bank_name: 'First National Bank' }), ctx())

    // false is an ANSWER, not an absence. Collapsing it to null loses the merchant's statement
    // that they are not registered, which is a different thing from never having been asked.
    expect(storedRow().vat_registered).toBe(false)
  })

  test('a single-field patch leaves the other five text fields standing', async () => {
    seedProfile({ vat_registered: true })

    const res = await route.PATCH(patchRequest({ bank_name: 'First National Bank' }), ctx())
    expect(res.status).toBe(200)

    expect(storedRow()).toMatchObject({
      ...TEXT_FIELDS,
      bank_name: 'First National Bank',
      vat_registered: true,
    })
    expect((await res.json()).billingProfile).toMatchObject({
      ...TEXT_FIELDS,
      bank_name: 'First National Bank',
    })
  })

  test('an EXPLICIT null still clears — absence and null are not conflated in the other direction', async () => {
    seedProfile({ vat_registered: false })

    const res = await route.PATCH(patchRequest({ bank_branch_code: null }), ctx())
    expect(res.status).toBe(200)

    expect(storedRow().bank_branch_code).toBeNull()
    // ...and only that field.
    expect(storedRow().bank_name).toBe(TEXT_FIELDS.bank_name)
    expect(storedRow().vat_registered).toBe(false)
  })

  test('an explicit vat_registered = null un-answers it, when that is what was asked', async () => {
    seedProfile({ vat_registered: true })

    const res = await route.PATCH(patchRequest({ vat_registered: null }), ctx())
    expect(res.status).toBe(200)
    expect(storedRow().vat_registered).toBeNull()
  })

  test('the preserved answer survives a reload, not just the save response', async () => {
    seedProfile({ vat_registered: true })

    await route.PATCH(patchRequest({ ...TEXT_FIELDS, bank_name: 'Nedbank' }), ctx())

    const reload = await route.GET(getRequest(), ctx())
    const body = await reload.json()
    expect(body.billingProfile.vat_registered).toBe(true)
    expect(body.billingProfile.bank_name).toBe('Nedbank')
    expect(body.vatRegistrationSupported).toBe(true)
  })
})

// ── D2: validation judges the merged row, not the request ────────────────────

describe('D2 — a partial patch is validated against the profile it will produce', () => {
  test('PATCH {vat_registered: true} succeeds when the STORED profile has a VAT number', async () => {
    seedProfile({ vat_registered: false })

    const res = await route.PATCH(patchRequest({ vat_registered: true }), ctx())

    expect(res.status).toBe(200)
    expect((await res.json()).billingProfile.vat_registered).toBe(true)
    expect(storedRow().vat_registered).toBe(true)
    // The number the rule is about was never in the request, and is untouched.
    expect(storedRow().vat_number).toBe(TEXT_FIELDS.vat_number)
  })

  test('PATCH {vat_registered: true} is still refused when NO VAT number exists anywhere', async () => {
    // The rule is not weakened by the merge -- it is merely applied to the right row.
    seedProfile({ vat_number: null, vat_registered: null })

    const res = await route.PATCH(patchRequest({ vat_registered: true }), ctx())

    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/vat_number is required/i)
    expect(storedRow().vat_registered).toBeNull()
  })

  test('clearing the VAT number of a registered business is refused by the merged row', async () => {
    seedProfile({ vat_registered: true })

    const res = await route.PATCH(patchRequest({ vat_number: null }), ctx())

    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/vat_number is required/i)
    // Nothing was written: the row still has both halves of a consistent answer.
    expect(storedRow().vat_number).toBe(TEXT_FIELDS.vat_number)
    expect(storedRow().vat_registered).toBe(true)
  })

  test('the length and format rules also judge the merged row', async () => {
    seedProfile({ vat_registered: true })

    const tooLong = await route.PATCH(
      patchRequest({ registration_number: 'x'.repeat(101) }),
      ctx(),
    )
    expect(tooLong.status).toBe(400)
    expect((await tooLong.json()).error).toMatch(/must not exceed 100 characters/i)

    const lettered = await route.PATCH(patchRequest({ bank_account_number: 'ACC-12x' }), ctx())
    expect(lettered.status).toBe(400)
    expect((await lettered.json()).error).toMatch(/digits, spaces, and hyphens/i)

    // Neither refusal wrote anything.
    expect(storedRow()).toMatchObject({ ...TEXT_FIELDS, vat_registered: true })
  })

  test('a profile that does not exist yet is created from the patch alone', async () => {
    const res = await route.PATCH(patchRequest(TEXT_FIELDS), ctx())

    expect(res.status).toBe(200)
    expect(storedRow()).toMatchObject({ restaurant_id: RESTAURANT_ID, ...TEXT_FIELDS })
    // Never asked, so never answered.
    expect(storedRow().vat_registered).toBeNull()
  })
})

// ── the absent-column path is unchanged by any of this ───────────────────────

describe('a database without the vat_registered column', () => {
  test('an unrelated save succeeds and writes no vat_registered key', async () => {
    mode = 'column_absent'
    seedProfile()

    const res = await route.PATCH(patchRequest({ bank_name: 'Nedbank' }), ctx())

    expect(res.status).toBe(200)
    expect(storedRow().bank_name).toBe('Nedbank')
    expect(storedRow()).not.toHaveProperty('vat_registered')
    expect((await res.json()).vatRegistrationSupported).toBe(false)
  })

  test('an explicit answer is still refused rather than dropped', async () => {
    mode = 'column_absent'
    seedProfile()

    const res = await route.PATCH(patchRequest({ vat_registered: true }), ctx())

    expect(res.status).toBe(409)
    expect((await res.json()).code).toBe('VAT_REGISTRATION_UNAVAILABLE')
    // Atomic: the rest of the patch was not written either.
    expect(storedRow().bank_name).toBe(TEXT_FIELDS.bank_name)
  })

  test('an explicit vat_registered: null is a no-op and the rest still saves', async () => {
    mode = 'column_absent'
    seedProfile()

    const res = await route.PATCH(
      patchRequest({ bank_name: 'Nedbank', vat_registered: null }),
      ctx(),
    )

    expect(res.status).toBe(200)
    expect(storedRow().bank_name).toBe('Nedbank')
  })
})
