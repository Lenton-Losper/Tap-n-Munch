/**
 * THE CONTROL THAT PROTECTS FNB CHOWNOW.
 *
 * Every ChowNow staff member holds exactly ONE restaurant. This change rewrites the code that
 * decides which restaurant every page reads, at 13 converted resolver sites and ~24 routes that
 * call getRestaurantIdForUser. If any of them shifts for a single-restaurant account, staff see
 * another restaurant's orders during service.
 *
 * SO THIS DOES NOT ASSERT CORRECTNESS. It asserts EQUIVALENCE: the same account, against two
 * servers running two commits, must produce byte-identical answers everywhere.
 *
 *   BASELINE_URL  -> a server on 26acbda, exactly what production is serving now
 *   BRANCH_URL    -> a server on this branch
 *
 * A test that only checked the new server "returns the right restaurant" would pass while
 * silently changing what staff see. Equivalence is the only claim worth making here.
 *
 * Run:  set -a; . ./.env.test; set +a
 *       node node_modules/tsx/dist/cli.mjs scripts/probe-single-restaurant-equivalence.ts
 */
import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = process.env.SUPABASE_URL
const ANON_KEY = process.env.SUPABASE_ANON_KEY
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
const PASSWORD = process.env.STAGING_TEST_PASSWORD
const BRANCH_URL = process.env.BRANCH_URL || 'http://127.0.0.1:3210'
const BASELINE_URL = process.env.BASELINE_URL || 'http://127.0.0.1:3211'

if (!SUPABASE_URL || !ANON_KEY || !SERVICE_ROLE_KEY || !PASSWORD) {
  throw new Error('Missing staging env (source .env.test first)')
}
if (!SUPABASE_URL.includes('mdqjpxwczrhkxkbqatqa')) {
  throw new Error(`REFUSING: not staging -- ${SUPABASE_URL}`)
}

const db = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } })

const SINGLE_EMAIL = 'switcher-probe-single@flashtap-test.invalid'
const BASE_RESTAURANT = 'a1999166-ddfa-40d1-ad1f-2f01282a1652'
/** The route defaults to TODAY only. Without an explicit window every comparison is 0 vs 0,
 *  which passes while proving nothing -- the control restaurant's orders are 2026-08-16..19. */
const ORDER_WINDOW = '&startDate=2026-08-01&endDate=2026-12-31'

let failures = 0
function check(label: string, pass: boolean, detail = '') {
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}${detail ? ` -- ${detail}` : ''}`)
  if (!pass) failures++
}

async function tokenFor(email: string): Promise<string> {
  const auth = createClient(SUPABASE_URL!, ANON_KEY!, { auth: { persistSession: false } })
  const { data, error } = await auth.auth.signInWithPassword({ email, password: PASSWORD! })
  if (error) throw new Error(`sign-in failed for ${email}: ${error.message}`)
  return data.session!.access_token
}

async function hit(base: string, path: string, token: string) {
  const res = await fetch(`${base}${path}`, { headers: { Authorization: `Bearer ${token}` } })
  const text = await res.text()
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    body = text
  }
  return { status: res.status, body }
}

/** Order-insensitive, key-sorted serialisation so a reordered array is not a false difference. */
function canonical(value: unknown): string {
  const norm = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(norm)
    if (v && typeof v === 'object') {
      return Object.fromEntries(
        Object.entries(v as Record<string, unknown>)
          .filter(([k]) => !['timestamp', 'generatedAt', 'requestId'].includes(k))
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([k, val]) => [k, norm(val)]),
      )
    }
    return v
  }
  return JSON.stringify(norm(value))
}

/**
 * Every GET route reachable with a bearer token that resolves the caller's restaurant.
 * Mutating routes are deliberately excluded -- firing POST/DELETE at staging to compare
 * responses would change the data the comparison is reading.
 */
const ROUTES = [
  '/api/auth/role',
  '/api/auth/contexts',
  '/api/admin/setup-status',
  '/api/admin/features',
  '/api/admin/invites',
  '/api/admin/staff',
  '/api/admin/terminals',
  '/api/admin/terminals/list',
  '/api/admin/restaurant-roles',
  `/api/orders/history?restaurantId=${BASE_RESTAURANT}${ORDER_WINDOW}`,
  `/api/orders/history?restaurantId=${BASE_RESTAURANT}${ORDER_WINDOW}&status=all`,
]

async function waitFor(base: string) {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`${base}/signin`)
      if (res.ok) return
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 2000))
  }
  throw new Error(`server never came up: ${base}`)
}

async function main() {
  console.log(`BASELINE (26acbda, = production): ${BASELINE_URL}`)
  console.log(`BRANCH   (this change):           ${BRANCH_URL}\n`)
  await Promise.all([waitFor(BASELINE_URL), waitFor(BRANCH_URL)])

  // The subject must genuinely hold exactly one restaurant, or the control proves nothing.
  const { data: user } = await db.from('users').select('id').eq('email', SINGLE_EMAIL).maybeSingle()
  if (!user) throw new Error(`control subject ${SINGLE_EMAIL} not found`)
  const { data: memberships } = await db
    .from('restaurant_users')
    .select('restaurant_id')
    .eq('user_id', user.id)
    .is('deleted_at', null)
  check(
    'control subject holds EXACTLY ONE restaurant (else this proves nothing)',
    (memberships ?? []).length === 1,
    `${(memberships ?? []).length} membership(s)`,
  )
  if ((memberships ?? []).length !== 1) {
    console.log('\nABORTING: the control subject is not single-restaurant.')
    process.exit(1)
  }

  const token = await tokenFor(SINGLE_EMAIL)

  console.log('\n--- byte-identical responses across every resolving route ---')
  for (const route of ROUTES) {
    const [before, after] = await Promise.all([
      hit(BASELINE_URL, route, token),
      hit(BRANCH_URL, route, token),
    ])
    const sameStatus = before.status === after.status
    const sameBody = canonical(before.body) === canonical(after.body)
    check(
      `${route}`,
      sameStatus && sameBody,
      sameStatus
        ? sameBody
          ? `HTTP ${after.status}`
          : `SAME status ${after.status} but BODY DIFFERS`
        : `status ${before.status} -> ${after.status}`,
    )
    if (!sameBody || !sameStatus) {
      console.log(`      baseline: ${canonical(before.body).slice(0, 220)}`)
      console.log(`      branch:   ${canonical(after.body).slice(0, 220)}`)
    }
  }

  // Said out loud, because "all green" over a list that quietly omits routes is the same
  // false comfort as a passing test whose inputs never arrive. These four have no GET at all:
  // a matching 405 on both servers exercises no resolver and must not be counted as agreement.
  console.log('\n  NOT EXERCISED -- mutating-only, no GET (a matching 405 proves nothing):')
  console.log('    admin/restaurant/profile [PATCH]        admin/restaurant/finatic [PATCH]')
  console.log('    admin/menu/categories [POST/PATCH/DEL]  admin/menu/subcategories [POST/PATCH/DEL]')
  console.log('    -> covered only by tsc + the resolver scan, not by this equivalence run.')

  console.log('\n--- the resolved restaurant is the SAME one ---')
  const roleBefore = await hit(BASELINE_URL, '/api/auth/role', token)
  const roleAfter = await hit(BRANCH_URL, '/api/auth/role', token)
  const idBefore = (roleBefore.body as { restaurant_id?: string })?.restaurant_id
  const idAfter = (roleAfter.body as { restaurant_id?: string })?.restaurant_id
  check('same restaurant resolved', idBefore === idAfter, `${idBefore} == ${idAfter}`)
  check('and it is the one the account belongs to', idAfter === BASE_RESTAURANT, String(idAfter))

  console.log('\n--- the same orders, by id ---')
  const path = `/api/orders/history?restaurantId=${BASE_RESTAURANT}${ORDER_WINDOW}`
  const ordersBefore = await hit(BASELINE_URL, path, token)
  const ordersAfter = await hit(BRANCH_URL, path, token)
  const ids = (payload: unknown): string[] => {
    const body = payload as { orders?: { id?: string }[] } | { id?: string }[]
    const list = Array.isArray(body) ? body : (body?.orders ?? [])
    return list.map((o) => String(o?.id ?? '')).filter(Boolean).sort()
  }
  const before = ids(ordersBefore.body)
  const after = ids(ordersAfter.body)
  check(
    'the order comparison is NOT vacuous -- real orders came back',
    after.length > 0,
    `${after.length} orders in the window`,
  )
  check(
    'order history returns the SAME order ids',
    JSON.stringify(before) === JSON.stringify(after),
    `${before.length} vs ${after.length} orders`,
  )
  check(
    'order history did not refuse on either side',
    ordersBefore.status === ordersAfter.status && ordersAfter.status < 400,
    `HTTP ${ordersBefore.status} -> ${ordersAfter.status}`,
  )

  console.log('\n--- no switcher for this account ---')
  const contexts = await hit(BRANCH_URL, '/api/auth/contexts', token)
  const restaurantContexts = (
    (contexts.body as { contexts?: { type?: string }[] })?.contexts ?? []
  ).filter((c) => c.type === 'restaurant')
  const { buildRestaurantSwitcher } = await import('../lib/auth/restaurant-switcher-options')
  const model = buildRestaurantSwitcher({
    contexts: restaurantContexts,
    currentRestaurantId: BASE_RESTAURANT,
  })
  check('exactly one restaurant context', restaurantContexts.length === 1)
  check('switcher does NOT render', model.visible === false)

  console.log(
    `\n${failures === 0 ? 'EQUIVALENCE CONTROL GREEN -- single-restaurant behaviour is unchanged' : `${failures} CHECK(S) FAILED -- DO NOT SHIP`}`,
  )
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((error) => {
  console.error('PROBE ERROR:', error)
  process.exit(1)
})
