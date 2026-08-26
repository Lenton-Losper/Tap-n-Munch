// @ts-nocheck
/**
 * READ ONLY. DOES THE EXCLUSION ACTUALLY EXCLUDE, AND DOES IT EXCLUDE ONLY WHAT IT SHOULD?
 *
 * `lib/orders/stress-fixtures.ts` states one rule in three forms — a JS predicate, a PostgREST
 * `.or()`, and a SQL fragment. Three implementations of one rule is three chances to drift, and the
 * PostgREST one carries a genuine trap: a two-clause negation silently drops any row whose
 * restaurant_id AND firebase_restaurant_id are both NULL, because `NULL NOT LIKE '...'` is NULL
 * rather than TRUE. Production has exactly one such row and it is not a fixture.
 *
 * FOUR ASSERTIONS, AND TWO OF THEM ARE POSITIVE CONTROLS. "The exclusion removed some rows" is the
 * reassuring answer and would be satisfied by a filter that removed the wrong ones, or by one that
 * removed everything:
 *
 *   1. COUNT. The server-side filter returns exactly (all - fixtures).
 *   2. AGREEMENT. The server-side filter and the JS predicate select the SAME id set — not the same
 *      COUNT, the same ids. Two implementations agreeing on a number is much weaker than two
 *      implementations agreeing on a set.
 *   3. POSITIVE CONTROL A. The non-fixture orphan — restaurant_id NULL, firebase_restaurant_id NULL
 *      — is still THERE after the exclusion, asserted by its id. This is the row a two-clause
 *      filter loses, and the assertion is what makes the third clause load-bearing rather than
 *      decorative.
 *   4. POSITIVE CONTROL B. Every real venue's orders survive in full. An exclusion that quietly
 *      dropped a live restaurant would satisfy assertions 1-3 if the fixture count happened to
 *      match, so the per-venue counts are compared before and after.
 */
import { config } from 'dotenv'
config({ path: 'C:/Users/223125318/Desktop/mvp/restaurant-menu-screen/.env.local', override: true })

import {
  isStressFixtureOrder,
  withoutStressFixtures,
  STRESS_FIXTURE_EXCLUSION_OR,
  STRESS_FIXTURE_EXCLUSION_SQL,
  excludeStressFixtures,
} from '../../lib/orders/stress-fixtures'

const PROD_REF = 'ihlmmpmolnpchzgwyhgh'
const pad = (s, n) => String(s === null || s === undefined ? '-' : s).slice(0, n).padEnd(n)
const H = (x) => { console.log('\n' + '='.repeat(96)); console.log(x); console.log('='.repeat(96)) }

let failures = 0
const assert = (label, ok, detail = '') => {
  console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + pad(label, 62) + detail)
  if (!ok) failures += 1
}

async function main() {
  const { createClient } = await import('@supabase/supabase-js')
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || ''
  if (!url.includes(PROD_REF)) throw new Error('REFUSING: not production, got ' + url)
  const db = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY || '', { auth: { persistSession: false } })
  console.log('READ ONLY -- SELECTs only. connected to ' + url)
  console.log('\n  .or()  ' + STRESS_FIXTURE_EXCLUSION_OR)
  console.log('  SQL    ' + STRESS_FIXTURE_EXCLUSION_SQL)

  const COLS = 'id,restaurant_id,firebase_restaurant_id,order_number,placed_at'

  const all = []
  for (let f = 0; ; f += 1000) {
    const { data, error } = await db.from('orders').select(COLS).order('id').range(f, f + 999)
    if (error) throw new Error('unfiltered read: ' + error.message)
    all.push(...(data ?? [])); if (!data || data.length < 1000) break
  }

  const kept = []
  for (let f = 0; ; f += 1000) {
    const { data, error } = await excludeStressFixtures(
      db.from('orders').select(COLS).order('id'),
    ).range(f, f + 999)
    if (error) throw new Error('filtered read: ' + error.message)
    kept.push(...(data ?? [])); if (!data || data.length < 1000) break
  }

  const fixtures = all.filter(isStressFixtureOrder)
  const keptInJs = withoutStressFixtures(all)

  H('1. COUNT')
  console.log('  all rows                 ' + all.length)
  console.log('  JS says fixtures         ' + fixtures.length)
  console.log('  JS keeps                 ' + keptInJs.length)
  console.log('  PostgREST keeps          ' + kept.length)
  assert('server-side count == all - fixtures', kept.length === all.length - fixtures.length,
    kept.length + ' vs ' + (all.length - fixtures.length))
  assert('the exclusion removes SOMETHING', fixtures.length > 0, fixtures.length + ' removed')
  assert('the exclusion does not remove everything', kept.length > 0, kept.length + ' kept')

  H('2. AGREEMENT — the same ID SET, not merely the same count')
  const serverIds = new Set(kept.map((o) => String(o.id)))
  const jsIds = new Set(keptInJs.map((o) => String(o.id)))
  const onlyServer = [...serverIds].filter((i) => !jsIds.has(i))
  const onlyJs = [...jsIds].filter((i) => !serverIds.has(i))
  assert('no row kept by PostgREST that JS drops', onlyServer.length === 0,
    onlyServer.length ? onlyServer.slice(0, 5).join(', ') : '')
  assert('no row kept by JS that PostgREST drops', onlyJs.length === 0,
    onlyJs.length ? onlyJs.slice(0, 5).join(', ') : '')
  for (const id of [...onlyServer, ...onlyJs].slice(0, 6)) {
    const row = all.find((o) => String(o.id) === id)
    console.log('        DISAGREEMENT ' + id + '  restaurant_id=' + pad(row?.restaurant_id, 38) +
      ' firebase_restaurant_id=' + pad(row?.firebase_restaurant_id, 24))
  }

  H('3. POSITIVE CONTROL A — the non-fixture orphan survives')
  const nullBoth = all.filter(
    (o) => !o.restaurant_id && (o.firebase_restaurant_id === null || o.firebase_restaurant_id === undefined),
  )
  const nullRidNotFixture = all.filter((o) => !o.restaurant_id && !isStressFixtureOrder(o))
  console.log('  rows with restaurant_id NULL                        ' + all.filter((o) => !o.restaurant_id).length)
  console.log('  of those, NOT fixtures (must survive)               ' + nullRidNotFixture.length)
  console.log('  of those, firebase_restaurant_id ALSO NULL          ' + nullBoth.length +
    '   <- the three-valued-logic case')
  for (const o of nullRidNotFixture) {
    const survived = serverIds.has(String(o.id))
    assert('orphan #' + o.order_number + ' (' + String(o.id).slice(0, 8) + ') survives', survived,
      'firebase_restaurant_id=' + pad(o.firebase_restaurant_id, 22) +
      ' placed ' + String(o.placed_at).slice(0, 10))
  }
  if (nullRidNotFixture.length === 0) {
    assert('a non-fixture orphan exists to control with', false,
      'THE CONTROL IS BLIND — nothing here proves the third clause does anything')
  }

  H('4. POSITIVE CONTROL B — every real venue keeps every order')
  const before = new Map()
  const after = new Map()
  for (const o of all) {
    const k = String(o.restaurant_id ?? 'NULL')
    before.set(k, (before.get(k) ?? 0) + 1)
  }
  for (const o of kept) {
    const k = String(o.restaurant_id ?? 'NULL')
    after.set(k, (after.get(k) ?? 0) + 1)
  }
  const { data: venues } = await db.from('restaurants').select('id,name')
  const vname = new Map((venues ?? []).map((v) => [v.id, v.name]))
  for (const [k, n] of [...before].sort((a, b) => b[1] - a[1])) {
    const m = after.get(k) ?? 0
    const label = k === 'NULL' ? '(no restaurant)' : vname.get(k) ?? k
    if (k === 'NULL') {
      console.log('  ' + pad(label, 26) + String(n).padStart(6) + ' -> ' + String(m).padStart(6) +
        '   (the fixtures live here; ' + (n - m) + ' removed)')
    } else {
      assert(pad(label, 24) + ' keeps all ' + n, m === n, m + ' of ' + n)
    }
  }

  H(failures === 0 ? 'ALL ASSERTIONS PASSED' : failures + ' ASSERTION(S) FAILED')
  if (failures > 0) process.exitCode = 1
  console.log(failures === 0 ? '\nEXCLUSION_VERIFIED_OK' : '\nEXCLUSION_VERIFY_FAILED')
}

main().catch((e) => { console.error('ABORTED:', e.message); process.exitCode = 1 })
