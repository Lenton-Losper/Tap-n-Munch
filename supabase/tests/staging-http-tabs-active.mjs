/**
 * PHASE 2 — STAGING HTTP LEG: GET /api/tabs/active.
 *
 * This is the customer-facing route F7 changed. It could never run before, because the staging
 * WORKER was 93 commits stale behind a dead Cloudflare token. It hits the DEPLOYED worker over
 * real HTTP; only the fixture is made directly in the staging database.
 *
 * WHAT IT PROVES, and why each has a wrong answer that means stop:
 *   1. The returned `total` is DERIVED from the orders, so a deliberately WRONG `tabs.total`
 *      cannot control it. The stale value is chosen so that returning it is unmistakable.
 *   2. The response carries EXACTLY the five contracted keys — `members` (the array of people on
 *      the tab) must be reduced to `member_count`, never echoed.
 *   3. No order id appears anywhere in the body.
 *
 * A POSITIVE CONTROL runs first. "No order id leaked" and "exactly five keys" both pass
 * vacuously against `{ tab: null }` or a 404, so the suite refuses to grade itself until it has
 * seen the route return a real tab.
 *
 *   node supabase/tests/staging-http-tabs-active.mjs
 */
import { randomUUID } from 'node:crypto'
import { connectStaging } from './staging-db.mjs'

const BASE = process.env.STAGING_BASE ?? 'https://flashtap-staging.llosperofficial.workers.dev'
const VENUE = 'a1999166-ddfa-40d1-ad1f-2f01282a1652'
const MARKER = 'HTTPSMOKE-' + new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14)

/** The stored total is set to this. It is not the sum of anything, on purpose. */
const STALE_STORED_TOTAL = 99999
const ORDER_AMOUNTS = [220, 500] // the Riviera figures; derived total must be 720
const EXPECTED_TOTAL = ORDER_AMOUNTS.reduce((a, b) => a + b, 0)
const EXPECTED_KEYS = ['id', 'status', 'total', 'pin_required', 'member_count']

let pass = 0, fail = 0
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  PASS  ${name}`) }
  else { fail++; console.log(`  FAIL  ${name}${detail ? ' -- ' + detail : ''}`) }
}

const client = await connectStaging()
const madeTables = [], madeTabs = [], madeOrders = []

try {
  // ---- fixture ---------------------------------------------------------------------------
  const tableId = randomUUID()
  const tableNumber = 9000 + Math.floor(Math.random() * 900)
  await client.query(
    `insert into public.restaurant_tables (id, restaurant_id, table_number, status, active)
     values ($1,$2,$3,'occupied',true)`, [tableId, VENUE, tableNumber])
  madeTables.push(tableId)

  const tabId = randomUUID()
  await client.query(
    `insert into public.tabs (id, restaurant_id, table_id, table_number, status, members, total, pin_required)
     values ($1,$2,$3,$4,'open',$5::jsonb,$6,true)`,
    [tabId, VENUE, tableId, tableNumber,
     JSON.stringify([{ name: 'Alice' }, { name: 'Bob' }]), STALE_STORED_TOTAL])
  madeTabs.push(tabId)

  for (const amount of ORDER_AMOUNTS) {
    const id = randomUUID()
    await client.query(
      `insert into public.orders
         (id, restaurant_id, tab_id, table_id, status, payment_status, subtotal, tax, total,
          items, channel, idempotency_key, placed_at)
       values ($1,$2,$3,$4,'pending','pending',$5,0,$5,'[]'::jsonb,'table',$6, now())`,
      [id, VENUE, tabId, tableId, amount, `${MARKER}-${id}`])
    madeOrders.push(id)
  }

  console.log(`fixture: tab ${tabId} table ${tableNumber}`)
  console.log(`  stored tabs.total = ${STALE_STORED_TOTAL} (deliberately wrong)`)
  console.log(`  orders            = ${ORDER_AMOUNTS.join(' + ')} = ${EXPECTED_TOTAL}\n`)

  // ---- the request -----------------------------------------------------------------------
  const url = `${BASE}/api/tabs/active?restaurantId=${VENUE}&tableNumber=${tableNumber}`
  const res = await fetch(url, { headers: { accept: 'application/json' } })
  const body = await res.json().catch(() => null)
  console.log(`GET ${url}\n  -> ${res.status} ${JSON.stringify(body)}\n`)

  // ---- POSITIVE CONTROL: the route must have found the tab ---------------------------------
  const tab = body?.tab
  ok('CONTROL the route returned a real tab (not null / not an error)',
     res.status === 200 && tab && typeof tab === 'object',
     `status=${res.status} tab=${JSON.stringify(tab)}`)
  if (!tab) {
    console.log('\nREFUSING TO GRADE: without a tab, the leak and key assertions pass vacuously.')
    fail++
  } else {
    // 1. the figure is derived
    ok('the derived total is returned', Number(tab.total) === EXPECTED_TOTAL,
       `got ${tab.total}, expected ${EXPECTED_TOTAL}`)
    ok('the STALE stored tabs.total does NOT control the response',
       Number(tab.total) !== STALE_STORED_TOTAL, `got ${tab.total}`)

    // 2. exactly the five contracted keys
    const keys = Object.keys(tab).sort()
    ok('the response carries exactly the five contracted keys',
       JSON.stringify(keys) === JSON.stringify([...EXPECTED_KEYS].sort()),
       `got ${JSON.stringify(keys)}`)
    ok('the members ARRAY is not echoed, only its count',
       !('members' in tab) && tab.member_count === 2, `member_count=${tab.member_count}`)

    // 3. no order id anywhere in the body
    const raw = JSON.stringify(body)
    const leaked = madeOrders.filter((id) => raw.includes(id))
    ok('no order id appears anywhere in the response', leaked.length === 0,
       `leaked ${leaked.join(', ')}`)
  }
} finally {
  console.log('\nTEARDOWN')
  for (const [table, ids] of [['orders', madeOrders], ['tabs', madeTabs], ['restaurant_tables', madeTables]]) {
    if (ids.length) {
      const r = await client.query(`delete from public.${table} where id = any($1::uuid[])`, [ids])
      console.log(`  ${table}: ${r.rowCount}`)
    }
  }
  await client.end()
}

console.log(`\nSTAGING HTTP (tabs/active): ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
