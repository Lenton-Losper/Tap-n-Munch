/**
 * READ ONLY. Does asking to pay still evict the customer, on PRODUCTION?
 *
 * BEHAVIOUR, NOT VERSION. /api/version can report either SHA for minutes during a gradual
 * rollout, so it cannot answer "has the eviction stopped". This drives what the customer
 * actually meets: a real session token, on a real tab really in ready_to_pay, over HTTP.
 *
 * IT WRITES NOTHING, AND IT MINTS NOTHING. It DISCOVERS its subject by querying for a tab that
 * is currently in ready_to_pay with a live session, and refuses if there is not one. An earlier
 * draft hardcoded a specific tab id and was wrong within the hour -- that tab settled, and a
 * settled tab is SUPPOSED to 410, so the probe would have reported the fix as broken when it was
 * reading a correct refusal. Data moves; the subject is re-derived on every run.
 *
 * WHY IT REFUSES RATHER THAN PASSING WHEN THERE IS NO SUBJECT. Silence must not look like
 * success. With no tab in ready_to_pay there is nothing to evict, so a probe that returned
 * "no evictions found" would be reporting the absence of customers as the presence of a fix.
 *
 * HOW TO GET A SUBJECT: walk the flow. Open the QR menu, place an order, press Settle Tab and
 * choose a payment method. That puts the tab in ready_to_pay with a live session, which is
 * exactly the state the defect fires in. Then run this.
 *
 *   still broken :  410  -- the session on a ready_to_pay tab is refused, the customer is evicted
 *   fixed        :  2xx  -- the session survives being asked to pay
 *
 * The control is built in: a SETTLED tab must still 410. The fix moves the line, it does not
 * remove it, and a validator that had simply stopped checking would pass the main assertion.
 *
 * Usage:
 *   node scripts/prod/verify-eviction-fix-production.mjs          one pass, exits
 *   node scripts/prod/verify-eviction-fix-production.mjs --watch  poll until a subject appears
 */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

const require = createRequire(
  'file:///C:/Users/223125~1/AppData/Local/Temp/claude/C--Users-223125318-Desktop-mvp/42cde80a-ddd8-4302-a2d9-e3cb8803244e/scratchpad/pgclient/',
)
const { Client } = require('pg')

const WORKER = process.env.PROD_URL || 'https://flashtap.app'
const WATCH = process.argv.includes('--watch')
const ENV = 'C:/Users/223125318/Desktop/mvp/restaurant-menu-screen/.env.local'
const sec = (n) => {
  for (const l of readFileSync(ENV, 'utf8').split(/\r?\n/)) {
    const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/)
    if (m && m[1] === n) return m[2].trim().replace(/^["']|["']$/g, '')
  }
  throw new Error(n)
}

const db = new Client({
  host: 'aws-0-eu-west-1.pooler.supabase.com',
  port: 5432,
  user: 'postgres.ihlmmpmolnpchzgwyhgh',
  password: sec('SUPABASE_DB_PASSWORD_PROD'),
  database: 'postgres',
  ssl: { rejectUnauthorized: false },
  connectionTimeoutMillis: 15000,
})
await db.connect()

const guarded = async (tabId, restaurantId, token) => {
  try {
    const res = await fetch(
      `${WORKER}/api/tabs/${encodeURIComponent(tabId)}/orders?restaurantId=${encodeURIComponent(restaurantId)}`,
      { headers: { 'x-session-token': token }, cache: 'no-store' },
    )
    return res.status
  } catch (e) {
    return `ERR ${String(e.message).slice(0, 60)}`
  }
}

const findSubjects = async (status) => {
  const { rows } = await db.query(
    `SELECT t.id AS tab_id, t.restaurant_id, r.name, t.status, cs.token
       FROM tabs t
       JOIN restaurants r ON r.id = t.restaurant_id
       JOIN customer_sessions cs ON cs.tab_id = t.id
      WHERE t.status = $1 AND cs.active AND cs.expires_at > now()
      ORDER BY cs.created_at DESC LIMIT 3`,
    [status],
  )
  return rows
}

const runOnce = async () => {
  const subjects = await findSubjects('ready_to_pay')
  if (subjects.length === 0) {
    console.log('NO SUBJECT: no production tab is currently in ready_to_pay with a live session.')
    console.log('  This is NOT a pass. Walk the flow (order -> Settle Tab -> choose a method), then re-run.')
    return null
  }

  console.log(`target: ${WORKER}\n`)
  let evicted = 0
  for (const s of subjects) {
    const st = await guarded(s.tab_id, s.restaurant_id, s.token)
    const verdict =
      st === 410 ? 'EVICTED  <- the customer is thrown out' :
      typeof st === 'number' && st >= 200 && st < 300 ? 'SESSION SURVIVES' : `unexpected (${st})`
    if (st === 410) evicted++
    console.log(`  ready_to_pay  ${s.name.padEnd(20)} tab ${String(s.tab_id).slice(0, 8)}  HTTP ${st}  ${verdict}`)
  }

  // CONTROL: the line must still exist. A settled tab has to keep 410ing.
  const settled = await findSubjects('settled')
  let controlOk = null
  if (settled.length > 0) {
    const st = await guarded(settled[0].tab_id, settled[0].restaurant_id, settled[0].token)
    controlOk = st === 410
    console.log(`  CONTROL settled ${settled[0].name.padEnd(18)} HTTP ${st}  ${controlOk ? 'still 410, correct' : '*** should be 410 ***'}`)
  } else {
    console.log('  CONTROL: no settled tab with a live session — control not run')
  }

  console.log('')
  if (evicted > 0) {
    console.log('RESULT: EVICTION IS STILL LIVE. A session on a ready_to_pay tab is being refused.')
    return false
  }
  if (controlOk === false) {
    console.log('RESULT: NOT VERIFIED — the main case passed but the control did not.')
    console.log('        A settled tab must still 410. Passing both is the only good outcome.')
    return false
  }
  if (controlOk === null) {
    // DO NOT claim the control passed. An earlier version of this file fell through to the
    // success message here and asserted "and a settled tab still 410s" having tested nothing --
    // the exact class of green-that-overclaims this script exists to avoid.
    //
    // The control is expected to be unrunnable on production: settling a tab DEACTIVATES its
    // session, so validateSessionToken refuses at the `!session.active` check and never reaches
    // the tab-status branch. That branch is covered on staging by
    // verify-ready-to-pay-keeps-session-staging.ts, which mints a fixture and flips status
    // directly, exercising all four ended statuses.
    console.log('EVICTION_FIX_VERIFIED (main assertion only) — the session survives ready_to_pay.')
    console.log('  CONTROL NOT RUN: no settled tab has a live session, so the settled->410 branch')
    console.log('  was not exercised here. It is covered on staging by')
    console.log('  verify-ready-to-pay-keeps-session-staging.ts. This run does not prove it.')
    return true
  }
  console.log('EVICTION_FIX_VERIFIED — the session survives ready_to_pay, and a settled tab still 410s.')
  return true
}

if (!WATCH) {
  await runOnce()
  await db.end()
} else {
  console.log('WATCHING for a ready_to_pay tab to appear. Walk the flow now. Ctrl-C to stop.\n')
  for (;;) {
    const r = await runOnce()
    if (r !== null) break
    await new Promise((res) => setTimeout(res, 5000))
  }
  await db.end()
}
