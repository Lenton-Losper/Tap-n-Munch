/**
 * REAL-STAGING E2E for the FIFTH STATE. Sibling of probe-realtime-invalidation-staging.ts, which
 * proves the 'out'/'ready' leg; this proves the 'collected' leg that 20260831120000 unblocked.
 *
 * ============================================================================================
 * WHY THIS NEEDED ITS OWN PROBE
 * ============================================================================================
 *
 * 20260829160000_collected_state.sql widened order_line_events to five values and, on the stated
 * premise that order_lines carried no CHECK constraint, left order_lines alone. That premise was
 * false -- 20260828141000 had created order_lines_kitchen_state_check and
 * order_lines_bar_state_check the previous day, both four-valued, both applied on both databases.
 *
 * So every 'Collected' tap died on 23514 inside the UPDATE, the route turned it into a 500, the
 * line never left the Ready zone, and -- because the broadcast is sent AFTER the update -- no
 * terminal was ever told either. Production's order_line_events carried ZERO transitions to
 * 'collected', all time, while carrying 12 to 'ready'.
 *
 * Unit tests could not have caught it: they mock the database, and the constraint IS the database.
 * That is what this file is for.
 *
 * ============================================================================================
 * WHAT IT PROVES, AND IN WHICH DIRECTION
 * ============================================================================================
 *
 *   1. The live CHECK constraint text, read from the response of a real write rather than assumed.
 *      A run against a database WITHOUT the migration fails here, loudly, and says so.
 *   2. An anon-key-only websocket subscriber -- the exact identity a kitchen/bar wall screen's
 *      browser has, and the reason those boards moved off postgres_changes -- receives
 *      line_changed for a COLLECTED transition.
 *   3. The PERSISTED ROW, read back from the database directly and not from the route's own
 *      response, is 'collected'. A 200 is a claim; the row is the effect.
 *   4. The append-only audit row ready -> collected exists. This is the transition that has never
 *      once been written in production.
 *   5. GET /api/terminal/tabs/{tabId}/lines, with a SEPARATE terminal token, reports
 *      is_ready=false / is_collected=true -- i.e. the FOOD UP badge can finally turn OFF -- while
 *      still serialising the raw bar_state as 'ready' for a terminal that predates the word.
 *
 * SAFETY: refuses to run against anything but staging. All writes are one PROBE-tagged
 * terminal/tab/order/order_line, deleted in a finally block on every exit path including error.
 *
 * Usage:
 *   npx tsx scripts/probe-collected-state-staging.ts
 *   npx tsx scripts/probe-collected-state-staging.ts --cleanup
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
if (!ANON_KEY) throw new Error('REFUSING: no anon key in .env.test')

process.env.NEXT_PUBLIC_SUPABASE_URL = URL
process.env.SUPABASE_URL = URL
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = ANON_KEY
process.env.SUPABASE_SERVICE_ROLE_KEY = SERVICE_KEY
process.env.TERMINAL_JWT_SECRET = process.env.TERMINAL_JWT_SECRET || `PROBE-local-secret-${Date.now()}-${Math.random().toString(36).slice(2)}`

const db = createClient(URL, SERVICE_KEY, { auth: { autoRefreshToken: false, persistSession: false } })

const RESTAURANT_ID = 'a1999166-ddfa-40d1-ad1f-2f01282a1652'
const PROBE_TAG = 'PROBE-collected-state'
const PROBE_TABLE_NUMBER = 900997

const cleanupOnly = process.argv.includes('--cleanup')

const failures: string[] = []
function check(label: string, ok: boolean, detail: string) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label} -- ${detail}`)
  if (!ok) failures.push(`${label}: ${detail}`)
}

async function findProbeRows() {
  const { data: orders } = await db.from('orders').select('id').eq('session_id', PROBE_TAG)
  const orderIds = (orders ?? []).map((r: { id: string }) => r.id)
  const { data: tabs } = await db
    .from('tabs')
    .select('id')
    .eq('restaurant_id', RESTAURANT_ID)
    .eq('table_number', PROBE_TABLE_NUMBER)
  const tabIds = (tabs ?? []).map((r: { id: string }) => r.id)
  const { data: terminals } = await db
    .from('restaurant_terminals')
    .select('id')
    .eq('restaurant_id', RESTAURANT_ID)
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
  for (const id of terminalIds) await db.from('restaurant_terminals').delete().eq('id', id)
  if (terminalIds.length > 0) console.log(`Deleted ${terminalIds.length} probe terminal(s), by id.`)
}

async function main() {
  if (cleanupOnly) {
    await runCleanup()
    return
  }

  const { restaurantLinesChannelName, LINE_CHANGED_EVENT } = await import('../lib/stations/realtime-invalidate')
  const { signTerminalJwt } = await import('../lib/terminals/terminal-jwt')
  const { POST: batchPOST } = await import('../app/api/terminal/station-lines/batch/route')
  const { GET: linesGET } = await import('../app/api/terminal/tabs/[tabId]/lines/route')

  const { data: featuresRow } = await db
    .from('restaurant_features')
    .select('restaurant_id, station_screens_enabled')
    .eq('restaurant_id', RESTAURANT_ID)
    .maybeSingle()
  const priorFlagValue = featuresRow?.station_screens_enabled ?? false
  const needsFlagFlip = priorFlagValue !== true

  let terminalId: string | null = null
  let readerTerminalId: string | null = null
  let orderId: string | null = null
  let tabId: string | null = null
  const anonClient = createClient(URL, ANON_KEY, { auth: { autoRefreshToken: false, persistSession: false } })
  let channel: ReturnType<typeof anonClient.channel> | null = null

  try {
    if (needsFlagFlip) {
      if (!featuresRow) await db.from('restaurant_features').insert({ restaurant_id: RESTAURANT_ID, station_screens_enabled: true })
      else await db.from('restaurant_features').update({ station_screens_enabled: true }).eq('restaurant_id', RESTAURANT_ID)
    }

    // ==========================================================================================
    // STEP 1 -- the wall-screen-identity subscriber, live before anything changes.
    // ==========================================================================================
    const channelName = restaurantLinesChannelName(RESTAURANT_ID)
    console.log(`\n=== STEP 1: anon-key subscriber on '${channelName}' ===`)
    let broadcastsReceived = 0
    channel = anonClient.channel(channelName)
    channel.on('broadcast', { event: LINE_CHANGED_EVENT }, () => {
      broadcastsReceived += 1
      console.log(`  <- broadcast #${broadcastsReceived}: '${LINE_CHANGED_EVENT}'`)
    })
    const subscribedChannel = channel
    const subscribed = await new Promise<boolean>((res) => {
      const timeout = setTimeout(() => res(false), 10_000)
      subscribedChannel.subscribe((status: string) => {
        console.log(`  channel status: ${status}`)
        if (status === 'SUBSCRIBED') {
          clearTimeout(timeout)
          res(true)
        }
      })
    })
    if (!subscribed) throw new Error('REFUSING: the anon subscriber never reached SUBSCRIBED within 10s.')

    // ==========================================================================================
    // STEP 2 -- fixture.
    // ==========================================================================================
    console.log('\n=== STEP 2: fixture ===')
    const { data: terminal, error: terminalError } = await db
      .from('restaurant_terminals')
      .insert({ restaurant_id: RESTAURANT_ID, device_serial: PROBE_TAG, terminal_name: PROBE_TAG, status: 'active', station_kind: 'bar' })
      .select('id')
      .single()
    if (terminalError || !terminal?.id) throw new Error(`REFUSING: could not create probe terminal: ${terminalError?.message}`)
    terminalId = String(terminal.id)

    const { data: table } = await db.from('restaurant_tables').select('id, table_number').eq('restaurant_id', RESTAURANT_ID).limit(1).maybeSingle()
    if (!table?.id) throw new Error('REFUSING: no restaurant_tables row for the fixture restaurant.')

    const { data: tab, error: tabError } = await db
      .from('tabs')
      .insert({ restaurant_id: RESTAURANT_ID, table_id: table.id, table_number: PROBE_TABLE_NUMBER, status: 'open', members: [], total: 0 })
      .select('id')
      .single()
    if (tabError || !tab?.id) throw new Error(`REFUSING: could not create probe tab: ${tabError?.message}`)
    tabId = String(tab.id)

    const { data: order, error: orderError } = await db
      .from('orders')
      .insert({
        restaurant_id: RESTAURANT_ID, table_id: table.id, table_number: table.table_number,
        session_id: PROBE_TAG, status: 'pending', payment_status: 'pending', channel: 'table',
        items: [], subtotal: 0, tax: 0, total: 0, is_closed: false,
        order_number: 900000 + (Date.now() % 90000) + Math.floor(Math.random() * 1000),
        placed_at: new Date().toISOString(),
      })
      .select('id')
      .single()
    if (orderError || !order?.id) throw new Error(`REFUSING: could not create probe order: ${orderError?.message}`)
    orderId = String(order.id)

    const { data: line, error: lineError } = await db
      .from('order_lines')
      .insert({
        restaurant_id: RESTAURANT_ID, order_id: orderId, tab_id: tabId, source_item_index: 0,
        name_snapshot: 'PROBE: collected state E2E', quantity: 1, route_to: 'bar',
        kitchen_state: null, bar_state: 'outstanding',
      })
      .select('id')
      .single()
    if (lineError || !line?.id) throw new Error(`REFUSING: could not create probe line: ${lineError?.message}`)
    const lineId = String(line.id)
    console.log(`  line=${lineId} bar_state='outstanding'`)

    const bumpToken = await signTerminalJwt({ terminal_id: terminalId, restaurant_id: RESTAURANT_ID, device_serial: PROBE_TAG })
    const bump = async (action: string) => {
      const res = await batchPOST(
        new Request('http://localhost/api/terminal/station-lines/batch', {
          method: 'POST',
          headers: { authorization: `Bearer ${bumpToken}`, 'content-type': 'application/json' },
          body: JSON.stringify({ station: 'bar', action, line_ids: [lineId] }),
        }),
      )
      return { status: res.status, body: await res.json().catch(() => null) }
    }

    // ==========================================================================================
    // STEP 3 -- outstanding -> ready (the leg that already worked), then the one that did not.
    // ==========================================================================================
    console.log("\n=== STEP 3: bump 'out' (-> ready), then 'collected' ===")
    const outRes = await bump('out')
    console.log(`  out:       status=${outRes.status} ${JSON.stringify(outRes.body?.results ?? outRes.body)}`)
    if (outRes.status !== 200) throw new Error(`REFUSING: the 'out' bump failed (${outRes.status}); nothing after this is meaningful.`)

    const beforeCollected = broadcastsReceived
    const colRes = await bump('collected')
    console.log(`  collected: status=${colRes.status} ${JSON.stringify(colRes.body?.results ?? colRes.body)}`)

    console.log('\n=== ASSERTIONS ===')
    check(
      'the Collected bump is accepted',
      colRes.status === 200,
      colRes.status === 200
        ? 'HTTP 200'
        : `HTTP ${colRes.status} -- if this says 500 with a check-constraint message, 20260831120000 is NOT applied to this database`,
    )

    // ==========================================================================================
    // STEP 4 -- the PERSISTED row, read straight from the table.
    // ==========================================================================================
    const { data: persisted } = await db.from('order_lines').select('bar_state, kitchen_state').eq('id', lineId).maybeSingle()
    check('the PERSISTED row is collected', persisted?.bar_state === 'collected', `order_lines.bar_state = ${JSON.stringify(persisted?.bar_state)}`)

    const { data: events } = await db
      .from('order_line_events')
      .select('from_state, to_state, station, actor_kind')
      .eq('order_line_id', lineId)
      .order('occurred_at', { ascending: true })
    const collectedEvent = (events ?? []).find((e) => e.to_state === 'collected')
    check(
      'the audit row ready -> collected exists',
      Boolean(collectedEvent) && collectedEvent!.from_state === 'ready',
      JSON.stringify(events),
    )

    // ==========================================================================================
    // STEP 5 -- the broadcast, to the wall-screen identity.
    // ==========================================================================================
    const deadline = Date.now() + 8_000
    while (broadcastsReceived <= beforeCollected && Date.now() < deadline) await new Promise((r) => setTimeout(r, 200))
    check(
      'an anon-key subscriber receives line_changed for the collected transition',
      broadcastsReceived > beforeCollected,
      `${broadcastsReceived} broadcast(s) total, ${broadcastsReceived - beforeCollected} after the collect`,
    )

    // ==========================================================================================
    // STEP 6 -- what the terminal now sees, through a SEPARATE token.
    // ==========================================================================================
    const { data: terminal2, error: t2err } = await db
      .from('restaurant_terminals')
      .insert({ restaurant_id: RESTAURANT_ID, device_serial: `${PROBE_TAG}-reader`, terminal_name: `${PROBE_TAG}-reader`, status: 'active', station_kind: null })
      .select('id')
      .single()
    if (t2err || !terminal2?.id) throw new Error(`REFUSING: could not create reader terminal: ${t2err?.message}`)
    readerTerminalId = String(terminal2.id)
    const readToken = await signTerminalJwt({ terminal_id: readerTerminalId, restaurant_id: RESTAURANT_ID, device_serial: `${PROBE_TAG}-reader` })

    const readRes = await linesGET(
      new Request(`http://localhost/api/terminal/tabs/${tabId}/lines`, { headers: { authorization: `Bearer ${readToken}` } }),
      { params: Promise.resolve({ tabId: tabId! }) },
    )
    const readBody = await readRes.json().catch(() => null)
    const terminalLine = readBody?.orders?.[0]?.lines?.[0]
    console.log(`\n  terminal sees: ${JSON.stringify(terminalLine)}`)
    console.log(`  summary: ${JSON.stringify(readBody?.summary)}  all_ready=${readBody?.all_ready}`)

    check('terminal is_ready is FALSE (the FOOD UP badge can clear)', terminalLine?.is_ready === false, `is_ready=${terminalLine?.is_ready}`)
    check('terminal is_collected is TRUE', terminalLine?.is_collected === true, `is_collected=${terminalLine?.is_collected}`)
    check(
      'the legacy shim still serialises the raw state as ready',
      terminalLine?.bar_state === 'ready',
      `bar_state=${JSON.stringify(terminalLine?.bar_state)} (a pre-collected terminal must never read a fifth value)`,
    )
    check('summary.collected counts it', readBody?.summary?.collected === 1, JSON.stringify(readBody?.summary))
    check('all_ready is unchanged by collecting', readBody?.all_ready === true, `all_ready=${readBody?.all_ready}`)

    console.log('\n==============================================================================')
    console.log(failures.length === 0 ? 'PASS: every assertion held.' : `FAIL: ${failures.length} assertion(s) did not hold:`)
    for (const f of failures) console.log(`  - ${f}`)
    console.log('==============================================================================')
    if (failures.length > 0) process.exitCode = 1
  } finally {
    if (channel) {
      try {
        await anonClient.removeChannel(channel)
      } catch {}
    }
    if (needsFlagFlip) {
      await db.from('restaurant_features').update({ station_screens_enabled: priorFlagValue }).eq('restaurant_id', RESTAURANT_ID)
    }
    await runCleanup()
    void terminalId
    void readerTerminalId
    void orderId
    void tabId
  }
}

main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
