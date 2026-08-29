/**
 * REAL-STAGING E2E: does the actual Supabase Realtime Broadcast infrastructure work the way
 * lib/stations/realtime-invalidate.ts / ft-settle-control's realtimeInvalidation.ts assume?
 *
 * Mocked httpSend()/channel tests prove the CODE calls the right functions with the right
 * arguments. They cannot prove Supabase's Realtime service actually delivers a broadcast sent via
 * the REST endpoint to a websocket subscriber holding nothing but the public anon key, on this
 * project, today. This script is that proof, or it is a real failure to fix before shipping.
 *
 * Sequence:
 *   1. Open a REAL websocket subscription with the ANON key only (no auth, no service role) --
 *      exactly what the terminal's src/lib/supabase.ts client is. Wait for SUBSCRIBED.
 *   2. Create a real, PROBE-tagged staging fixture: terminal, order, tab, one order_line at
 *      bar_state='outstanding', tab_id set so GET .../lines can find it.
 *   3. Call the REAL POST /api/terminal/station-lines/batch handler in-process, action 'out' --
 *      the exact route the bar board's Out button calls, which delegates to the state route that
 *      now sends the broadcast.
 *   4. Wait (bounded) for the anon subscriber to actually receive line_changed.
 *   5. Call the REAL GET /api/terminal/tabs/{tabId}/lines handler in-process, with a SEPARATE
 *      terminal token (proving this isn't reading back something cached from step 3's own
 *      request), and confirm is_ready is now true for that line.
 *
 * Usage:
 *   npx tsx scripts/probe-realtime-invalidation-staging.ts
 *   npx tsx scripts/probe-realtime-invalidation-staging.ts --cleanup
 */
import { resolve } from 'path'
import { createClient } from '@supabase/supabase-js'
import { config } from 'dotenv'

config({ path: resolve(__dirname, '../.env.test'), override: true })

const STAGING_REF = 'mdqjpxwczrhkxkbqatqa'
const PRODUCTION_REF = 'ihlmmpmolnpchzgwyhgh'

const URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || ''
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || ''
const ANON_KEY = process.env.SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || ''

if (URL.includes(PRODUCTION_REF)) throw new Error(`REFUSING: URL points at PRODUCTION (${PRODUCTION_REF}).`)
if (!URL.includes(STAGING_REF)) throw new Error(`REFUSING: URL is not the staging ref (${STAGING_REF}). Got: ${URL || '(empty)'}`)
if (!SERVICE_KEY) throw new Error('REFUSING: no service role key in .env.test')
if (!ANON_KEY) throw new Error('REFUSING: no anon key in .env.test -- this probe specifically needs the real one, not a placeholder')

process.env.NEXT_PUBLIC_SUPABASE_URL = URL
process.env.SUPABASE_URL = URL
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = ANON_KEY
process.env.SUPABASE_SERVICE_ROLE_KEY = SERVICE_KEY
process.env.TERMINAL_JWT_SECRET = process.env.TERMINAL_JWT_SECRET || `PROBE-local-secret-${Date.now()}-${Math.random().toString(36).slice(2)}`

const db = createClient(URL, SERVICE_KEY, { auth: { autoRefreshToken: false, persistSession: false } })

const RESTAURANT_ID = 'a1999166-ddfa-40d1-ad1f-2f01282a1652'
const PROBE_TAG = 'PROBE-realtime-invalidation'

const cleanupOnly = process.argv.includes('--cleanup')

async function findProbeRows() {
  const { data: orders } = await db.from('orders').select('id').eq('session_id', PROBE_TAG)
  const orderIds = (orders ?? []).map((r: { id: string }) => r.id)
  const { data: tabs } = await db.from('tabs').select('id').eq('restaurant_id', RESTAURANT_ID).eq('table_number', 900999)
  const tabIds = (tabs ?? []).map((r: { id: string }) => r.id)
  const { data: terminals } = await db
    .from('restaurant_terminals')
    .select('id')
    .eq('restaurant_id', RESTAURANT_ID)
    .eq('device_serial', PROBE_TAG)
  const terminalIds = (terminals ?? []).map((r: { id: string }) => r.id)
  return { orderIds, tabIds, terminalIds }
}

async function runCleanup() {
  const { orderIds, tabIds, terminalIds } = await findProbeRows()
  console.log(`Found ${orderIds.length} probe order(s), ${tabIds.length} probe tab(s), ${terminalIds.length} probe terminal(s).`)
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
  if (tabIds.length > 0) {
    await db.from('tabs').delete().in('id', tabIds)
    console.log(`Deleted ${tabIds.length} probe tab(s).`)
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

  const { restaurantLinesChannelName, LINE_CHANGED_EVENT } = await import('../lib/stations/realtime-invalidate')

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
  let tabId: string | null = null
  // Declared here (not const inside the try) so the outer finally can always reach the SAME
  // channel instance it subscribed, not a fresh one -- the same reason the probe/cleanup pattern
  // this file was built from keeps its ids at this scope.
  const anonClient = createClient(URL, ANON_KEY, { auth: { autoRefreshToken: false, persistSession: false } })
  let channel: ReturnType<typeof anonClient.channel> | null = null

  try {
    if (needsFlagFlip) {
      if (!featuresRow) {
        await db.from('restaurant_features').insert({ restaurant_id: RESTAURANT_ID, station_screens_enabled: true })
      } else {
        await db.from('restaurant_features').update({ station_screens_enabled: true }).eq('restaurant_id', RESTAURANT_ID)
      }
    }

    // ============================================================================================
    // STEP 1 -- the terminal-style anonymous subscriber, wired up BEFORE anything happens.
    // ============================================================================================
    const channelName = restaurantLinesChannelName(RESTAURANT_ID)
    console.log(`\n=== STEP 1: subscribing (anon key only) to '${channelName}' ===`)

    let broadcastReceived = false
    channel = anonClient.channel(channelName)
    channel.on('broadcast', { event: LINE_CHANGED_EVENT }, () => {
      broadcastReceived = true
      console.log(`  <- broadcast received: '${LINE_CHANGED_EVENT}'`)
    })

    const subscribedChannel = channel
    const subscribed = await new Promise<boolean>((resolvePromise) => {
      const timeout = setTimeout(() => resolvePromise(false), 10_000)
      subscribedChannel.subscribe((status: string) => {
        console.log(`  channel status: ${status}`)
        if (status === 'SUBSCRIBED') {
          clearTimeout(timeout)
          resolvePromise(true)
        }
      })
    })

    if (!subscribed) {
      throw new Error('REFUSING to proceed: the anon-key subscriber never reached SUBSCRIBED within 10s.')
    }
    console.log('  subscriber is live.')

    // ============================================================================================
    // STEP 2 -- the fixture: terminal, tab, order, one bar-owned line at 'outstanding'.
    // ============================================================================================
    console.log('\n=== STEP 2: creating the probe fixture ===')

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

    const { data: table } = await db
      .from('restaurant_tables')
      .select('id, table_number')
      .eq('restaurant_id', RESTAURANT_ID)
      .limit(1)
      .maybeSingle()
    if (!table?.id) throw new Error('REFUSING: no restaurant_tables row for the fixture restaurant.')

    const { data: tab, error: tabError } = await db
      .from('tabs')
      .insert({
        restaurant_id: RESTAURANT_ID,
        table_id: table.id,
        table_number: 900999,
        status: 'open',
        members: [],
        total: 0,
      })
      .select('id')
      .single()
    if (tabError || !tab?.id) throw new Error(`REFUSING: could not create probe tab: ${tabError?.message}`)
    tabId = String(tab.id)

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
        placed_at: new Date().toISOString(),
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
        tab_id: tabId,
        source_item_index: 0,
        name_snapshot: 'PROBE: realtime invalidation E2E',
        quantity: 1,
        route_to: 'bar',
        kitchen_state: null,
        bar_state: 'outstanding',
      })
      .select('id')
      .single()
    if (lineError || !line?.id) throw new Error(`REFUSING: could not create probe line: ${lineError?.message}`)
    const lineId = String(line.id)
    console.log(`  terminal=${terminalId} tab=${tabId} order=${orderId} line=${lineId}, bar_state='outstanding'.`)

    // ============================================================================================
    // STEP 3 -- the REAL mutation, through the REAL route, exactly as the bar board's Out button.
    // ============================================================================================
    console.log("\n=== STEP 3: POST /api/terminal/station-lines/batch, station='bar', action='out' ===")
    const { signTerminalJwt } = await import('../lib/terminals/terminal-jwt')
    const bumpToken = await signTerminalJwt({ terminal_id: terminalId, restaurant_id: RESTAURANT_ID, device_serial: PROBE_TAG })

    const { POST: batchPOST } = await import('../app/api/terminal/station-lines/batch/route')
    const bumpReq = new Request('http://localhost/api/terminal/station-lines/batch', {
      method: 'POST',
      headers: { authorization: `Bearer ${bumpToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ station: 'bar', action: 'out', line_ids: [lineId] }),
    })
    const bumpRes = await batchPOST(bumpReq)
    const bumpBody = await bumpRes.json().catch(() => null)
    console.log(`  response status: ${bumpRes.status}`)
    console.log(`  response body: ${JSON.stringify(bumpBody)}`)
    if (bumpRes.status !== 200) {
      throw new Error(`REFUSING to evaluate realtime: the bump itself failed (status ${bumpRes.status}).`)
    }

    // ============================================================================================
    // STEP 4 -- did the anon subscriber actually get the broadcast?
    // ============================================================================================
    console.log('\n=== STEP 4: waiting up to 8s for the broadcast to arrive ===')
    const deadline = Date.now() + 8_000
    while (!broadcastReceived && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 200))
    }
    console.log(broadcastReceived ? '  RECEIVED.' : '  NOT RECEIVED within 8s.')

    // ============================================================================================
    // STEP 5 -- a SEPARATE terminal token, real GET, proving the authoritative state is correct
    // immediately -- independent of whether step 4 succeeded, since the database is the source of
    // truth regardless of the notification layer.
    // ============================================================================================
    console.log('\n=== STEP 5: GET /api/terminal/tabs/{tabId}/lines with a fresh terminal token ===')
    const { data: terminal2, error: terminal2Error } = await db
      .from('restaurant_terminals')
      .insert({
        restaurant_id: RESTAURANT_ID,
        device_serial: `${PROBE_TAG}-reader`,
        terminal_name: `${PROBE_TAG}-reader`,
        status: 'active',
        station_kind: null,
      })
      .select('id')
      .single()
    if (terminal2Error || !terminal2?.id) throw new Error(`REFUSING: could not create probe reader terminal: ${terminal2Error?.message}`)
    const readerTerminalId = String(terminal2.id)

    const readToken = await signTerminalJwt({
      terminal_id: readerTerminalId,
      restaurant_id: RESTAURANT_ID,
      device_serial: `${PROBE_TAG}-reader`,
    })
    const { GET: linesGET } = await import('../app/api/terminal/tabs/[tabId]/lines/route')
    const linesReq = new Request(`http://localhost/api/terminal/tabs/${tabId}/lines`, {
      headers: { authorization: `Bearer ${readToken}` },
    })
    const linesRes = await linesGET(linesReq, { params: Promise.resolve({ tabId }) })
    const linesBody = (await linesRes.json().catch(() => null)) as {
      orders?: Array<{ lines: Array<{ id: string; is_ready: boolean; bar_state: string | null }> }>
    } | null

    const foundLine = linesBody?.orders?.flatMap((o) => o.lines).find((l) => l.id === lineId)
    console.log(`  response status: ${linesRes.status}`)
    console.log(`  line in response: ${JSON.stringify(foundLine)}`)

    await db.from('restaurant_terminals').delete().eq('id', readerTerminalId)

    const isReadyNow = foundLine?.is_ready === true

    console.log('\n' + '='.repeat(78))
    console.log('RESULT')
    console.log('='.repeat(78))
    console.log(`Broadcast received by anon-key subscriber: ${broadcastReceived ? 'YES' : 'NO'}`)
    console.log(`GET .../lines reports is_ready=true immediately after: ${isReadyNow ? 'YES' : 'NO'}`)
    if (broadcastReceived && isReadyNow) {
      console.log('PASS: the real infrastructure delivers the invalidation, and the authoritative')
      console.log('fetch it triggers reports the correct new state.')
    } else {
      console.log('FAIL: see above.')
      process.exitCode = 1
    }
  } finally {
    if (channel) {
      try {
        anonClient.removeChannel(channel)
      } catch {
        // best-effort
      }
    }
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
