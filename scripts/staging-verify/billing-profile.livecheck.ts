/**
 * STAGING VERIFICATION for Settings -> Billing.
 *
 * Runs the REAL route handlers (GET and PATCH) against the REAL staging database. Authentication
 * and permission are stubbed -- they are covered exhaustively by
 * __tests__/billing-profile-survives-absent-vat-column.test.ts -- so that what is exercised here is
 * the part unit tests cannot reach: the actual PostgREST round trip that was broken in production.
 *
 * WRITES TO STAGING ONLY. Refuses to run against production, and restores whatever profile it found.
 *
 * Run it ALONE and explicitly:
 *   node node_modules/jest/bin/jest.js --testMatch "**\/scripts/staging-verify/*.livecheck.ts" --runInBand
 */
import { readFileSync } from 'node:fs'
import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

const STAGING_REF = 'mdqjpxwczrhkxkbqatqa'
const PRODUCTION_REF = 'ihlmmpmolnpchzgwyhgh'

function env(name: string): string {
  for (const line of readFileSync('.env.test', 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/)
    if (m && m[1] === name) return m[2].trim().replace(/^["']|["']$/g, '')
  }
  throw new Error(`${name} missing from .env.test`)
}

const url = env('SUPABASE_URL')
if (url.includes(PRODUCTION_REF)) throw new Error('REFUSING: .env.test points at PRODUCTION')
if (!url.includes(STAGING_REF)) throw new Error(`REFUSING: unrecognised project in ${url}`)

 
const db = createClient(url, env('SUPABASE_SERVICE_ROLE_KEY'), {
  auth: { persistSession: false },
}) as any

let targetRestaurantId = ''

jest.mock('@/lib/supabase/server', () => ({ createServerSupabaseClient: () => db }))
jest.mock('@/lib/supabase/admin-restaurant-auth', () => ({
  getUserFromRequest: async () => ({ id: 'staging-verify-user' }),
  requireCallerRestaurantId: async () => targetRestaurantId,
}))
jest.mock('@/lib/permissions/authorize', () => ({ requirePermission: async () => null }))

 
const route = require('@/app/api/admin/restaurants/[id]/billing-profile/route') as {
  GET: (req: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response>
  PATCH: (req: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response>
}

void NextResponse

const ctx = () => ({ params: Promise.resolve({ id: targetRestaurantId }) })
const getReq = () => new Request('http://localhost/api/admin/restaurants/x/billing-profile')
const patchReq = (body: unknown) =>
  new Request('http://localhost/api/admin/restaurants/x/billing-profile', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })

const PROFILE = {
  registration_number: 'CC/2026/LIVECHECK',
  vat_number: 'VAT-LIVE-42',
  bank_name: 'Bank Windhoek',
  bank_account_name: 'Staging Venue CC',
  bank_account_number: '8100 4455 66',
  bank_branch_code: '481972',
}

jest.setTimeout(120_000)

let original: Record<string, unknown> | null = null

beforeAll(async () => {
  const { data: rows } = await db.from('restaurants').select('id, name').limit(50)
  const riviera = (rows ?? []).filter((r: { name: string }) => r.name === 'Riviera')
  if (riviera.length !== 0) throw new Error('ABORT: looks like production')
  targetRestaurantId = String(rows?.[0]?.id ?? '')
  if (!targetRestaurantId) throw new Error('no restaurants on staging')

  const { data } = await db
    .from('restaurant_billing_profiles')
    .select('*')
    .eq('restaurant_id', targetRestaurantId)
    .maybeSingle()
  original = data ?? null
  await db.from('restaurant_billing_profiles').delete().eq('restaurant_id', targetRestaurantId)
})

afterAll(async () => {
  await db.from('restaurant_billing_profiles').delete().eq('restaurant_id', targetRestaurantId)
  if (original) {
    await db.from('restaurant_billing_profiles').upsert(original, { onConflict: 'restaurant_id' })
  }
})

test('GET returns an empty profile rather than a 500 when none exists', async () => {
  const res = await route.GET(getReq(), ctx())
  const body = await res.json()
  expect(res.status).toBe(200)
  expect(body.billingProfile.registration_number).toBeNull()
  expect(body.billingProfile.vat_registered).toBeNull()
  // Staging HAS the column, so support is reported true here. Production reports false.
  expect(body.vatRegistrationSupported).toBe(true)
})

test('PATCH saves the merchant business details', async () => {
  const res = await route.PATCH(patchReq(PROFILE), ctx())
  const body = await res.json()
  expect(res.status).toBe(200)
  expect(body.success).toBe(true)
  expect(body.billingProfile).toMatchObject(PROFILE)

  const { data } = await db
    .from('restaurant_billing_profiles')
    .select('*')
    .eq('restaurant_id', targetRestaurantId)
    .single()
  expect(data).toMatchObject({ ...PROFILE, restaurant_id: targetRestaurantId })
})

test('GET reads back exactly what PATCH wrote', async () => {
  const res = await route.GET(getReq(), ctx())
  const body = await res.json()
  expect(res.status).toBe(200)
  expect(body.billingProfile).toMatchObject(PROFILE)
})

test('PATCH updates in place rather than inserting a second row', async () => {
  await route.PATCH(patchReq({ ...PROFILE, bank_name: 'First National Bank' }), ctx())
  const { data, count } = await db
    .from('restaurant_billing_profiles')
    .select('*', { count: 'exact' })
    .eq('restaurant_id', targetRestaurantId)
  expect(count).toBe(1)
  expect(data[0].bank_name).toBe('First National Bank')
})

test('VAT registration IS accepted on staging, where the column exists', async () => {
  const res = await route.PATCH(patchReq({ ...PROFILE, vat_registered: true }), ctx())
  expect(res.status).toBe(200)
  const body = await res.json()
  expect(body.billingProfile.vat_registered).toBe(true)
  expect(body.vatRegistrationSupported).toBe(true)

  const { data } = await db
    .from('restaurant_billing_profiles')
    .select('vat_registered')
    .eq('restaurant_id', targetRestaurantId)
    .single()
  expect(data.vat_registered).toBe(true)
})

test('claiming VAT registration without a number is refused by the real database rule too', async () => {
  const res = await route.PATCH(patchReq({ ...PROFILE, vat_number: null, vat_registered: true }), ctx())
  expect(res.status).toBe(400)
  expect((await res.json()).error).toMatch(/vat_number is required/i)
})

test('an invalid bank account number is refused before any write', async () => {
  const before = await db
    .from('restaurant_billing_profiles')
    .select('bank_account_number')
    .eq('restaurant_id', targetRestaurantId)
    .single()
  const res = await route.PATCH(patchReq({ ...PROFILE, bank_account_number: 'ABC-123' }), ctx())
  expect(res.status).toBe(400)
  const after = await db
    .from('restaurant_billing_profiles')
    .select('bank_account_number')
    .eq('restaurant_id', targetRestaurantId)
    .single()
  expect(after.data.bank_account_number).toBe(before.data.bank_account_number)
})
