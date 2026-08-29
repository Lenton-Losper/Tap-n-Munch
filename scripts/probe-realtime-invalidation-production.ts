/**
 * PRODUCTION INCIDENT INVESTIGATION -- "Out still takes far too long to propagate", reported
 * against physical devices after the staging E2E probe passed clean.
 *
 * WHAT THIS DOES AND DOES NOT PROVE
 *
 * Same shape as probe-realtime-invalidation-staging.ts (in-process route calls, real anon-key
 * Broadcast subscriber, real database), pointed at PRODUCTION instead. This proves whether
 * PRODUCTION's specific Supabase project -- its own RLS/publication/Realtime configuration, which
 * can differ from staging's even when the code is identical -- delivers the broadcast and the
 * follow-up read correctly, with real timestamps at every step the incident report asked for.
 *
 * IT DOES NOT PROVE THE DEPLOYED CLOUDFLARE WORKER BEHAVES THE SAME WAY, because "in-process"
 * means this script imports the route handler SOURCE and runs it as a local function call against
 * the real database -- it never sends an HTTP request to the actual flashtap.app Worker. That gap
 * is real and is exactly what the staging probe was already called out for. Closing it needs
 * either a real terminal JWT signed with production's actual TERMINAL_JWT_SECRET (a Cloudflare
 * Worker secret this script has no access to and must not try to guess or extract), or a genuine
 * physical/browser action on production while `wrangler tail flashtap-production` is running
 * alongside this probe -- see the incident report for that half.
 *
 * SAFETY: refuses to run against anything but the production ref. All writes are a single
 * PROBE-tagged terminal/tab/order/order_line, deleted in a finally block on every exit path
 * including error. Existing production data is never touched -- there is no query in this file
 * that reads or writes anything not carrying the probe tag or the ids this run itself created.
 *
 * Usage:
 *   npx tsx scripts/probe-realtime-invalidation-production.ts
 *   npx tsx scripts/probe-realtime-invalidation-production.ts --cleanup
 */
import { resolve } from 'path'
import { createClient } from '@supabase/supabase-js'
import { config } from 'dotenv'

config({ path: resolve(__dirname, '../.env.local'), override: true })

const STAGING_REF = 'mdqjpxwczrhkxkbqatqa'
const PRODUCTION_REF = 'ihlmmpmolnpchzgwyhgh'

const URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || ''
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || ''
const ANON_KEY = process.env.SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || ''

if (URL.includes(STAGING_REF)) throw new Error(`REFUSING: URL points at STAGING (${STAGING_REF}), not production. Use the staging probe instead.`)
if (!URL.includes(PRODUCTION_REF)) throw new Error(`REFUSING: URL is not the production ref (${PRODUCTION_REF}). Got: ${URL || '(empty)'}`)
if (!SERVICE_KEY) throw new Error('REFUSING: no service role key in .env.local')
if (!ANON_KEY) throw new Error('REFUSING: no anon key in .env.local')

process.env.NEXT_PUBLIC_SUPABASE_URL = URL
process.env.SUPABASE_URL = URL
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = ANON_KEY
process.env.SUPABASE_SERVICE_ROLE_KEY = SERVICE_KEY
process.env.TERMINAL_JWT_SECRET = process.env.TERMINAL_JWT_SECRET || `PROBE-local-secret-${Date.now()}-${Math.random().toString(36).slice(2)}`

const db = createClient(URL, SERVICE_KEY, { auth: { autoRefreshToken: false, persistSession: false } })

const RIVIERA_ID = '01bf27f1-a958-4322-bb3e-cc5240987808'
const PROBE_TAG = 'PROBE-realtime-invalidation-PRODUCTION'

const cleanupOnly = process.argv.includes('--cleanup')

function ts(): string {
  return new Date().toISOString()
}

function log(step: string) {
  console.log(`[${ts()}] ${step}`)
}

async function findProbeRows() {
  const { data: orders } = await db.from('orders').select('id').eq('session_id', PROBE_TAG)
  const orderIds = (orders ?? []).map((r: { id: string }) => r.id)
  const { data: tabs } = await db.from('tabs').select('id').eq('restaurant_id', RIVIERA_ID).eq('table_number', 900998)
  const tabIds = (tabs ?? []).map((r: { id: string }) => r.id)
  const { data: terminals } = await db
    .from('restaurant_terminals')
    .select('id')
    .eq('restaurant_id', RIVIERA_ID)
    .like('device_serial', `${PROBE_TAG}%`)
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
    .eq('restaurant_id', RIVIERA_ID)
    .maybeSingle()
  const priorFlagValue = featuresRow?.station_screens_enabled ?? false
  console.log(`station_screens_enabled currently ${priorFlagValue} (Riviera is live -- NOT flipping this on production; refusing to run if it is not already on).`)
  if (!priorFlagValue) {
    throw new Error('REFUSING: station_screens_enabled is not already true for Riviera on production. Will not flip a live feature flag for this probe.')
  }

  let terminalId: string | null = null
  let orderId: string | null = null
  let tabId: string | null = null
  const anonClient = createClient(URL, ANON_KEY, { auth: { autoRefreshToken: false, persistSession: false } })
  let channel: ReturnType<typeof anonClient.channel> | null = null

  try {
    // ============================================================================================
    // STEP 1 -- the terminal-style anonymous subscriber, wired up BEFORE anything happens.
    // ============================================================================================
    const channelName = restaurantLinesChannelName(RIVIERA_ID)
    log(`STEP 1: subscribing (anon key only) to '${channelName}'`)

    let broadcastReceivedAt: string | null = null
    channel = anonClient.channel(channelName)
    channel.on('broadcast', { event: LINE_CHANGED_EVENT }, () => {
      broadcastReceivedAt = ts()
      log(`  <- broadcast RECEIVED: '${LINE_CHANGED_EVENT}'`)
    })

    const subscribedAt = await new Promise<string | null>((resolvePromise) => {
      const timeout = setTimeout(() => resolvePromise(null), 10_000)
      channel!.subscribe((status: string) => {
        log(`  channel status: ${status}`)
        if (status === 'SUBSCRIBED') {
          clearTimeout(timeout)
          resolvePromise(ts())
        }
      })
    })

    if (!subscribedAt) {
      throw new Error('REFUSING to proceed: the anon-key subscriber never reached SUBSCRIBED within 10s.')
    }
    log(`  subscriber is live at ${subscribedAt}.`)

    // ============================================================================================
    // STEP 2 -- fixture: terminal, tab, order, one bar-owned line at 'outstanding'.
    // ============================================================================================
    log('STEP 2: creating the probe fixture (Riviera, table_number=900998 -- will not collide with a real table)')

    const { data: terminal, error: terminalError } = await db
      .from('restaurant_terminals')
      .insert({
        restaurant_id: RIVIERA_ID,
        device_serial: `${PROBE_TAG}-${Date.now()}`,
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
      .eq('restaurant_id', RIVIERA_ID)
      .limit(1)
      .maybeSingle()
    if (!table?.id) throw new Error('REFUSING: no restaurant_tables row for Riviera.')

    const { data: tab, error: tabError } = await db
      .from('tabs')
      .insert({
        restaurant_id: RIVIERA_ID,
        table_id: table.id,
        table_number: 900998,
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
        restaurant_id: RIVIERA_ID,
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
        restaurant_id: RIVIERA_ID,
        order_id: orderId,
        tab_id: tabId,
        source_item_index: 0,
        name_snapshot: 'PROBE: realtime invalidation E2E (PRODUCTION incident investigation)',
        quantity: 1,
        route_to: 'bar',
        kitchen_state: null,
        bar_state: 'outstanding',
      })
      .select('id')
      .single()
    if (lineError || !line?.id) throw new Error(`REFUSING: could not create probe line: ${lineError?.message}`)
    const lineId = String(line.id)
    log(`  terminal=${terminalId} tab=${tabId} order=${orderId} line=${lineId}, bar_state='outstanding'.`)

    // ============================================================================================
    // STEP 3 -- the REAL mutation, through the REAL route (in-process), timing each phase.
    // ============================================================================================
    log("STEP 3: POST /api/terminal/station-lines/batch, station='bar', action='out' (in-process)")
    const { signTerminalJwt } = await import('../lib/terminals/terminal-jwt')
    const bumpToken = await signTerminalJwt({ terminal_id: terminalId, restaurant_id: RIVIERA_ID, device_serial: PROBE_TAG })

    const { POST: batchPOST } = await import('../app/api/terminal/station-lines/batch/route')
    const bumpReq = new Request('http://localhost/api/terminal/station-lines/batch', {
      method: 'POST',
      headers: { authorization: `Bearer ${bumpToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ station: 'bar', action: 'out', line_ids: [lineId] }),
    })

    const t_postBegins = ts()
    log(`  -> station POST begins: ${t_postBegins}`)
    const bumpRes = await batchPOST(bumpReq)
    const t_postCompletes = ts()
    const bumpBody = await bumpRes.json().catch(() => null)
    log(`  <- station POST completes: ${t_postCompletes} (status ${bumpRes.status})`)
    log(`  response body: ${JSON.stringify(bumpBody)}`)
    if (bumpRes.status !== 200) {
      throw new Error(`REFUSING to evaluate realtime: the bump itself failed (status ${bumpRes.status}).`)
    }

    const { data: rowAfter } = await db.from('order_lines').select('bar_state').eq('id', lineId).maybeSingle()
    const t_dbConfirmed = ts()
    log(`  DB bar_state read back at ${t_dbConfirmed}: '${rowAfter?.bar_state}'`)

    // ============================================================================================
    // STEP 4 -- did the anon subscriber actually get the broadcast, and how long did it take?
    // ============================================================================================
    log('STEP 4: waiting up to 10s for the broadcast to arrive')
    const deadline = Date.now() + 10_000
    while (!broadcastReceivedAt && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100))
    }
    if (broadcastReceivedAt) {
      const latencyMs = new Date(broadcastReceivedAt).getTime() - new Date(t_postCompletes).getTime()
      log(`  RECEIVED at ${broadcastReceivedAt} (${latencyMs}ms after station POST completed).`)
    } else {
      log('  NOT RECEIVED within 10s.')
    }

    // ============================================================================================
    // STEP 5 -- fresh terminal token, real GET, authoritative state.
    // ============================================================================================
    log('STEP 5: GET /api/terminal/tabs/{tabId}/lines with a fresh terminal token (in-process)')
    const { data: terminal2, error: terminal2Error } = await db
      .from('restaurant_terminals')
      .insert({
        restaurant_id: RIVIERA_ID,
        device_serial: `${PROBE_TAG}-reader-${Date.now()}`,
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
      restaurant_id: RIVIERA_ID,
      device_serial: `${PROBE_TAG}-reader`,
    })
    const { GET: linesGET } = await import('../app/api/terminal/tabs/[tabId]/lines/route')
    const t_getBegins = ts()
    log(`  -> GET begins: ${t_getBegins}`)
    const linesReq = new Request(`http://localhost/api/terminal/tabs/${tabId}/lines`, {
      headers: { authorization: `Bearer ${readToken}` },
    })
    const linesRes = await linesGET(linesReq, { params: Promise.resolve({ tabId }) })
    const t_getReturns = ts()
    const linesBody = (await linesRes.json().catch(() => null)) as {
      orders?: Array<{ lines: Array<{ id: string; is_ready: boolean; bar_state: string | null }> }>
    } | null
    log(`  <- GET returns: ${t_getReturns} (status ${linesRes.status})`)

    const foundLine = linesBody?.orders?.flatMap((o) => o.lines).find((l) => l.id === lineId)
    log(`  line in response: ${JSON.stringify(foundLine)}`)

    await db.from('restaurant_terminals').delete().eq('id', readerTerminalId)

    const isReadyNow = foundLine?.is_ready === true

    console.log('\n' + '='.repeat(78))
    console.log('TIMELINE SUMMARY (production database + production Realtime, in-process route calls)')
    console.log('='.repeat(78))
    console.log(`subscriber SUBSCRIBED:        ${subscribedAt}`)
    console.log(`station POST begins:          ${t_postBegins}`)
    console.log(`station POST completes:       ${t_postCompletes}`)
    console.log(`DB bar_state confirmed:       ${t_dbConfirmed} ('${rowAfter?.bar_state}')`)
    console.log(`broadcast received:           ${broadcastReceivedAt ?? 'NEVER'}`)
    console.log(`GET /.../lines begins:        ${t_getBegins}`)
    console.log(`GET /.../lines returns:       ${t_getReturns}`)
    console.log(`is_ready in response:         ${isReadyNow}`)
    console.log('='.repeat(78))
    if (broadcastReceivedAt && isReadyNow) {
      console.log('PASS on the infrastructure layer this script can reach: production DB write,')
      console.log('production Broadcast delivery, and the follow-up authoritative read all work.')
      console.log('This does NOT test the actual deployed Cloudflare Worker over HTTP -- see the')
      console.log('file header for why, and the incident report for what closes that gap.')
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
    await runCleanup()
  }
}

main().catch((err) => {
  console.error('PROBE FAILED:', err)
  process.exitCode = 1
})
