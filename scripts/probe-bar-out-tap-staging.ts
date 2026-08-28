/**
 * REAL-STAGING REPRO: "tapping Out on the bar board does nothing."
 *
 * Calls the REAL batch route (POST /api/terminal/station-lines/batch -- the route
 * postStationBump/lib/stations/bump.ts actually calls, NOT the single-line route) in-process
 * against a freshly created, PROBE-tagged, real staging order_line at bar_state='outstanding',
 * with a real terminal JWT signed for a probe terminal paired to 'bar'. Reports the exact HTTP
 * status and body, then re-queries the row from staging directly to see whether bar_state
 * actually moved.
 *
 * Usage:
 *   npx tsx scripts/probe-bar-out-tap-staging.ts --prove
 *   npx tsx scripts/probe-bar-out-tap-staging.ts --cleanup
 */
import { resolve } from 'path'
import { createClient } from '@supabase/supabase-js'
import { config } from 'dotenv'

config({ path: resolve(__dirname, '../.env.test'), override: true })

const STAGING_REF = 'mdqjpxwczrhkxkbqatqa'
const PRODUCTION_REF = 'ihlmmpmolnpchzgwyhgh'

const URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || ''
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || ''

if (URL.includes(PRODUCTION_REF)) throw new Error(`REFUSING: URL points at PRODUCTION (${PRODUCTION_REF}).`)
if (!URL.includes(STAGING_REF)) throw new Error(`REFUSING: URL is not the staging ref (${STAGING_REF}). Got: ${URL || '(empty)'}`)
if (!KEY) throw new Error('REFUSING: no service role key in .env.test')

process.env.NEXT_PUBLIC_SUPABASE_URL = URL
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || 'unused-service-role-key-carries-the-request'
process.env.TERMINAL_JWT_SECRET = process.env.TERMINAL_JWT_SECRET || `PROBE-local-secret-${Date.now()}-${Math.random().toString(36).slice(2)}`

const db = createClient(URL, KEY, { auth: { autoRefreshToken: false, persistSession: false } })

const RESTAURANT_ID = 'a1999166-ddfa-40d1-ad1f-2f01282a1652'
const PROBE_TAG = 'PROBE-bar-out-tap'

const cleanupOnly = process.argv.includes('--cleanup')

async function findProbeRows() {
  const { data: orders } = await db.from('orders').select('id').eq('session_id', PROBE_TAG)
  const orderIds = (orders ?? []).map((r: { id: string }) => r.id)
  const { data: terminals } = await db
    .from('restaurant_terminals')
    .select('id')
    .eq('restaurant_id', RESTAURANT_ID)
    .eq('device_serial', PROBE_TAG)
  const terminalIds = (terminals ?? []).map((r: { id: string }) => r.id)
  return { orderIds, terminalIds }
}

async function runCleanup() {
  const { orderIds, terminalIds } = await findProbeRows()
  console.log(`Found ${orderIds.length} probe order(s), ${terminalIds.length} probe terminal(s).`)
  if (orderIds.length > 0) {
    const { data: lines } = await db.from('order_lines').select('id').in('order_id', orderIds)
    const lineIds = (lines ?? []).map((r: { id: string }) => r.id)
    if (lineIds.length > 0) {
      await db.from('order_line_events').delete().in('order_line_id', lineIds)
      await db.from('order_lines').delete().in('id', lineIds)
      console.log(`Deleted ${lineIds.length} probe line(s) and their events.`)
    }
    await db.from('orders').delete().in('id', orderIds)
    console.log(`Deleted ${orderIds.length} probe order(s).`)
  }
  for (const id of terminalIds) {
    await db.from('restaurant_terminals').delete().eq('id', id)
  }
  if (terminalIds.length > 0) console.log(`Deleted ${terminalIds.length} probe terminal(s), by id.`)
}

async function main() {
  if (cleanupOnly) {
    await runCleanup()
    return
  }

  const { error: guardError } = await db.from('order_lines').select('id').limit(1)
  if (guardError) throw new Error(`REFUSING: order_lines not queryable (${guardError.message})`)

  const { data: featuresRow } = await db
    .from('restaurant_features')
    .select('restaurant_id, station_screens_enabled')
    .eq('restaurant_id', RESTAURANT_ID)
    .maybeSingle()
  const priorFlagValue = featuresRow?.station_screens_enabled ?? false
  const needsFlagFlip = priorFlagValue !== true
  console.log(`station_screens_enabled currently ${priorFlagValue}${needsFlagFlip ? ' -- flipping to true for this proof.' : ''}`)

  let terminalId: string | null = null
  let orderId: string | null = null

  try {
    if (needsFlagFlip) {
      if (!featuresRow) {
        await db.from('restaurant_features').insert({ restaurant_id: RESTAURANT_ID, station_screens_enabled: true })
      } else {
        await db.from('restaurant_features').update({ station_screens_enabled: true }).eq('restaurant_id', RESTAURANT_ID)
      }
    }

    // Probe terminal PAIRED TO BAR -- the exact pairing gate the batch route checks.
    const { data: terminal, error: terminalError } = await db
      .from('restaurant_terminals')
      .insert({
        restaurant_id: RESTAURANT_ID,
        device_serial: PROBE_TAG,
        terminal_name: PROBE_TAG,
        status: 'active',
        station_kind: 'bar',
      })
      .select('id')
      .single()
    if (terminalError || !terminal?.id) throw new Error(`REFUSING: could not create probe terminal: ${terminalError?.message}`)
    terminalId = String(terminal.id)
    console.log(`Created probe terminal ${terminalId} (station_kind='bar').`)

    const { data: table } = await db
      .from('restaurant_tables')
      .select('id, table_number')
      .eq('restaurant_id', RESTAURANT_ID)
      .limit(1)
      .maybeSingle()
    if (!table?.id) throw new Error('REFUSING: no restaurant_tables row for the fixture restaurant.')

    const probeOrderNumber = 900000 + (Date.now() % 90000) + Math.floor(Math.random() * 1000)
    const { data: order, error: orderError } = await db
      .from('orders')
      .insert({
        restaurant_id: RESTAURANT_ID,
        table_id: table.id,
        table_number: table.table_number,
        session_id: PROBE_TAG,
        status: 'pending',
        payment_status: 'pending',
        channel: 'table',
        items: [],
        subtotal: 0,
        tax: 0,
        total: 0,
        is_closed: false,
        order_number: probeOrderNumber,
      })
      .select('id')
      .single()
    if (orderError || !order?.id) throw new Error(`REFUSING: could not create probe order: ${orderError?.message}`)
    orderId = String(order.id)

    const { data: line, error: lineError } = await db
      .from('order_lines')
      .insert({
        restaurant_id: RESTAURANT_ID,
        order_id: orderId,
        source_item_index: 0,
        name_snapshot: 'PROBE: bar Out tap real-state repro',
        quantity: 1,
        route_to: 'bar',
        kitchen_state: null,
        bar_state: 'outstanding',
      })
      .select('id, kitchen_state, bar_state, route_to')
      .single()
    if (lineError || !line?.id) throw new Error(`REFUSING: could not create probe line: ${lineError?.message}`)
    const lineId = String(line.id)
    console.log(`Created probe order ${orderId} / line ${lineId}, bar_state='outstanding', route_to='bar'.`)

    const { signTerminalJwt } = await import('../lib/terminals/terminal-jwt')
    const token = await signTerminalJwt({
      terminal_id: terminalId,
      restaurant_id: RESTAURANT_ID,
      device_serial: PROBE_TAG,
    })

    // THE REAL ROUTE postStationBump ACTUALLY CALLS -- not the single-line route.
    const { POST: batchPOST } = await import('../app/api/terminal/station-lines/batch/route')

    const req = new Request('http://localhost/api/terminal/station-lines/batch', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ station: 'bar', action: 'out', line_ids: [lineId] }),
    })

    console.log("\n=== calling the REAL POST /api/terminal/station-lines/batch handler, station:'bar', action:'out' ===\n")
    const res = await batchPOST(req)
    const status = res.status
    const body = await res.json().catch(() => null)
    console.log(`Response status: ${status}`)
    console.log(`Response body: ${JSON.stringify(body, null, 2)}`)

    const { data: after, error: afterError } = await db
      .from('order_lines')
      .select('id, kitchen_state, bar_state')
      .eq('id', lineId)
      .maybeSingle()
    if (afterError) throw afterError
    console.log(`\nRow AFTER the call, read fresh from staging: ${JSON.stringify(after)}`)

    if (after?.bar_state === 'ready') {
      console.log('\n=== RESULT: the write worked. bar_state moved outstanding -> ready. ===')
    } else {
      console.log(`\n=== RESULT: the write did NOT move bar_state (still '${after?.bar_state}'). ===`)
    }
  } finally {
    if (needsFlagFlip) {
      await db.from('restaurant_features').update({ station_screens_enabled: priorFlagValue }).eq('restaurant_id', RESTAURANT_ID)
      console.log(`\nRestored station_screens_enabled to ${priorFlagValue}.`)
    }
    await runCleanup()
  }
}

main().catch((err) => {
  console.error('PROBE FAILED:', err)
  process.exitCode = 1
})
