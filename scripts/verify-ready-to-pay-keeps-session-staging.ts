// @ts-nocheck
/**
 * STAGING ONLY. Does asking to pay still end the customer's session, against the DEPLOYED worker?
 *
 * The unit suite proves `validateSessionToken` in isolation. This proves the thing the customer
 * actually meets: a real session token, on a real tab, against a real session-guarded endpoint,
 * over HTTP. The defect was only ever visible there — every layer in between (the poll, the 410,
 * `fetchWithSession` calling `handleSessionExpired` from inside itself) is invisible to a unit test.
 *
 * THE SEQUENCE, and both directions are asserted because the fix MOVES the line rather than
 * removing it:
 *
 *   tab open          -> guarded endpoint 200   the control: the token works at all
 *   tab ready_to_pay  -> guarded endpoint 200   THE FIX. This was 410 and evicted the customer.
 *   tab settled       -> guarded endpoint 410   still evicts. A closed tab must still end it.
 *
 * WITHOUT THE FIRST LINE THE SECOND PROVES NOTHING: an endpoint that 200s for everything, or a
 * token that was never valid, would satisfy "ready_to_pay is 200" just as well. And without the
 * third, a validator that had simply stopped checking would pass too.
 *
 * IT MINTS ITS OWN restaurant, table, tab and session and deletes them in a `finally`. Staging
 * only, enforced on the project ref: this writes, and a write against production to answer a
 * read-only question would be the wrong trade in any direction.
 *
 * Marker: READY_TO_PAY_KEEPS_SESSION_OK
 */
import { config } from 'dotenv'
import { resolve } from 'node:path'
import { randomUUID } from 'node:crypto'

config({ path: resolve(process.cwd(), '.env.test'), override: true })

const STAGING_REF = 'mdqjpxwczrhkxkbqatqa'
const WORKER = process.env.STAGING_WORKER_URL || 'https://flashtap-staging.llosperofficial.workers.dev'
const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || ''
const key = process.env.SUPABASE_SERVICE_ROLE_KEY || ''

let failures = 0
const check = (label, ok, detail = '') => {
  if (!ok) failures++
  console.log(`  ${ok ? 'PASS  ' : '*** FAIL ***  '}${label}${detail ? '   ' + detail : ''}`)
}

async function main() {
  if (!url.includes(STAGING_REF) || !key) {
    throw new Error(`REFUSING: staging URL + service role required. Got: ${url}`)
  }
  const { createClient } = await import('@supabase/supabase-js')
  const db = createClient(url, key, { auth: { persistSession: false } })
  console.log(`worker:   ${WORKER}`)
  console.log(`supabase: ${url}\n`)

  const tag = `rtp-session-${Date.now()}`
  let restaurantId = null
  let tableId = null
  let tabId = null

  try {
    const { data: r, error: rErr } = await db.from('restaurants')
      .insert({ name: tag, finatic_merchant_no: 'STUB', finatic_store_no: 'STUB' })
      .select('id').single()
    if (rErr) throw new Error(`restaurant: ${rErr.message}`)
    restaurantId = r.id

    const tableNumber = 9600 + Math.floor(Math.random() * 300)
    const { data: tbl, error: tErr } = await db.from('restaurant_tables')
      .insert({
        restaurant_id: restaurantId, table_number: tableNumber,
        active: true, status: 'available', current_session_version: 1,
      })
      .select('id, current_session_version').single()
    if (tErr) throw new Error(`table: ${tErr.message}`)
    tableId = tbl.id

    const { data: tab, error: tabErr } = await db.from('tabs')
      .insert({
        restaurant_id: restaurantId, table_id: tableId, table_number: tableNumber,
        status: 'open', session_version: tbl.current_session_version, total: 0,
      })
      .select('id').single()
    if (tabErr) throw new Error(`tab: ${tabErr.message}`)
    tabId = tab.id

    // Mirrors issueSessionToken exactly — same columns, same expiry shape.
    const token = randomUUID()
    const { error: sErr } = await db.from('customer_sessions').insert({
      token, tab_id: tabId, table_id: tableId, restaurant_id: restaurantId,
      session_version: tbl.current_session_version, active: true,
      expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    })
    if (sErr) throw new Error(`session: ${sErr.message}`)

    const guarded = async () => {
      const res = await fetch(
        `${WORKER}/api/tabs/${encodeURIComponent(tabId)}/orders?restaurantId=${encodeURIComponent(restaurantId)}`,
        { headers: { 'x-session-token': token }, cache: 'no-store' },
      )
      return res.status
    }
    const setStatus = async (status) => {
      const { error } = await db.from('tabs').update({ status }).eq('id', tabId)
      if (error) throw new Error(`set status ${status}: ${error.message}`)
    }

    console.log('1. CONTROL — an OPEN tab: the token works at all')
    const openStatus = await guarded()
    check('open tab -> not 410', openStatus !== 410, `got ${openStatus}`)
    check('open tab -> 2xx', openStatus >= 200 && openStatus < 300, `got ${openStatus}`)

    console.log('\n2. THE FIX — READY_TO_PAY must keep the session')
    await setStatus('ready_to_pay')
    const rtpStatus = await guarded()
    check(
      'ready_to_pay -> NOT 410 (this was the eviction)',
      rtpStatus !== 410,
      `got ${rtpStatus}${rtpStatus === 410 ? '  <- the customer is still being thrown out' : ''}`,
    )
    check('ready_to_pay -> 2xx', rtpStatus >= 200 && rtpStatus < 300, `got ${rtpStatus}`)

    console.log('\n3. THE LINE MOVED, IT WAS NOT REMOVED — a SETTLED tab still evicts')
    await setStatus('settled')
    const settledStatus = await guarded()
    check('settled -> 410', settledStatus === 410, `got ${settledStatus}`)

    console.log('\n4. and the other ended statuses too')
    for (const s of ['closed', 'completed', 'cancelled']) {
      await setStatus(s)
      const st = await guarded()
      check(`${s} -> 410`, st === 410, `got ${st}`)
    }
  } finally {
    if (tabId) await db.from('customer_sessions').delete().eq('tab_id', tabId)
    if (tabId) await db.from('tabs').delete().eq('id', tabId)
    if (tableId) await db.from('restaurant_tables').delete().eq('id', tableId)
    if (restaurantId) await db.from('restaurants').delete().eq('id', restaurantId)
    console.log(`\n  torn down: ${tag}`)
  }

  console.log('')
  if (failures) {
    console.log(`*** ${failures} ASSERTION(S) FAILED ***`)
    process.exitCode = 1
  } else {
    console.log('READY_TO_PAY_KEEPS_SESSION_OK')
  }
}

main().catch((e) => { console.error('ABORTED:', e.message); process.exit(1) })
