/**
 * feat/station-screens-v1 — events N and O: prove the realtime path, not just read the source.
 *
 * N — insert a line while subscribed, confirm the event arrives without a refresh.
 * O — kill the connection for ~2 minutes, insert a second line while dead, restore, and confirm
 *     the screen would catch up: not by hoping the channel replays what it missed (it will not
 *     — Realtime does not backfill a genuine outage, which is the whole reason #350's `refetch`
 *     flag on reconnect exists), but by feeding the REAL status sequence this outage produces
 *     into the ACTUAL app code (lib/dashboard/realtime-connection.ts's reportFeedChannelStatus)
 *     and asserting it flags `refetch: true` on the return to SUBSCRIBED. That is the exact
 *     mechanism app/kitchen/page.tsx and app/bar/page.tsx rely on to refetch the missed row.
 *
 * Modelled on the existing scripts/probe-realtime-empirical-staging.ts (subscribe, insert, wait
 * for the event) plus this repo's two-guard staging safety (scripts/diagnose-106-track-
 * inventory-desync.ts). Service-role key for both subscribing and inserting — bypasses RLS
 * deliberately, since what is under test is whether Realtime broadcasts at all, not RLS.
 *
 * TODO(schema-relay): order_lines' column names are the ASSUMED shape in
 * lib/stations/schema-assumptions.ts.
 *
 * Usage: npx tsx scripts/probe-station-realtime-staging.ts
 * (Takes ~2.5 minutes — the outage duration is deliberate, per the brief, not shortened.)
 */
import { resolve } from 'path'
import { createClient, type RealtimeChannel } from '@supabase/supabase-js'
import { config } from 'dotenv'
import {
  registerFeedChannel,
  reportFeedChannelStatus,
  resetFeedConnection,
} from '../lib/dashboard/realtime-connection'

config({ path: resolve(__dirname, '../.env.test'), override: true })

const STAGING_REF = 'mdqjpxwczrhkxkbqatqa'
const PRODUCTION_REF = 'ihlmmpmolnpchzgwyhgh'
const OUTAGE_MS = 2 * 60_000

const URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || ''
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || ''

if (URL.includes(PRODUCTION_REF)) {
  throw new Error(`REFUSING: URL points at PRODUCTION (${PRODUCTION_REF}).`)
}
if (!URL.includes(STAGING_REF)) {
  throw new Error(`REFUSING: URL is not the staging ref (${STAGING_REF}). Got: ${URL || '(empty — .env.test missing or not loaded)'}`)
}
if (!KEY) throw new Error('REFUSING: no service role key in .env.test')

const supabase = createClient(URL, KEY, { auth: { persistSession: false, autoRefreshToken: false } })

// 'staging test' on this project -- same fixture restaurant as scripts/seed-station-screens-
// staging.ts, verified (2026-08-28) to have restaurant_tables and active restaurant_terminals.
const RESTAURANT_ID = 'a1999166-ddfa-40d1-ad1f-2f01282a1652'
const PROBE_TAG = 'PROBE-station-realtime-v1'

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg)
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms))
}

async function findOrCreateOrder(): Promise<string> {
  const { data: existing, error: existingError } = await supabase
    .from('orders')
    .select('id')
    .eq('restaurant_id', RESTAURANT_ID)
    .eq('is_closed', false)
    .order('placed_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (existingError) throw existingError
  if (existing?.id) return String(existing.id)

  const { data: table, error: tableError } = await supabase
    .from('restaurant_tables')
    .select('id, table_number')
    .eq('restaurant_id', RESTAURANT_ID)
    .limit(1)
    .maybeSingle()
  if (tableError) throw tableError
  assert(table?.id, 'REFUSING: no restaurant_tables row found for the fixture restaurant.')

  const probeOrderNumber = 900000 + (Date.now() % 90000)
  const { data: created, error: createError } = await supabase
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
  assert(!createError && created?.id, `could not create a probe order: ${createError?.message}`)
  console.log(`No open order existed -- created probe order ${created.id} (order_number ${probeOrderNumber}).`)
  return String(created.id)
}

let probeLineIndex = 0

async function insertProbeLine(orderId: string, label: string): Promise<string> {
  // Real column names, confirmed 2026-08-28 against live staging rows (see
  // lib/stations/schema-assumptions.ts's docblock): name_snapshot not item_name, no
  // waiter_name/table_number/station columns on order_lines, kitchen_state is 'outstanding' not
  // 'to_make'.
  const { data, error } = await supabase
    .from('order_lines')
    .insert({
      restaurant_id: RESTAURANT_ID,
      order_id: orderId,
      source_item_index: probeLineIndex++,
      name_snapshot: `PROBE: realtime ${label}`,
      quantity: 1,
      route_to: 'kitchen',
      kitchen_state: 'outstanding',
      bar_state: null,
    })
    .select('id')
    .single()
  assert(!error && data?.id, `order_lines insert failed: ${error?.message}`)
  return data.id
}

async function cleanup(ids: string[]) {
  if (ids.length > 0) {
    await supabase.from('order_line_events').delete().in('order_line_id', ids)
    await supabase.from('order_lines').delete().in('id', ids)
    console.log(`Cleaned up ${ids.length} probe line(s).`)
  }

  // Remove a probe order this script may have created (findOrCreateOrder tags it session_id =
  // PROBE_TAG). Never touches a real order it found instead.
  const { data: probeOrders } = await supabase.from('orders').select('id').eq('session_id', PROBE_TAG)
  const orderIds = (probeOrders ?? []).map((r: { id: string }) => r.id)
  if (orderIds.length > 0) {
    await supabase.from('orders').delete().in('id', orderIds)
    console.log(`Cleaned up ${orderIds.length} probe order(s).`)
  }
}

async function subscribeAndWait(channelName: string, onStatus: (status: string) => void): Promise<RealtimeChannel> {
  const channel = supabase.channel(channelName).on(
    'postgres_changes',
    { event: 'INSERT', schema: 'public', table: 'order_lines', filter: `restaurant_id=eq.${RESTAURANT_ID}` },
    () => {},
  )

  await new Promise<void>((res, rej) => {
    const t = setTimeout(() => rej(new Error(`subscribe timeout on ${channelName}`)), 15000)
    channel.subscribe((status) => {
      onStatus(status)
      if (status === 'SUBSCRIBED') {
        clearTimeout(t)
        res()
      }
      if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
        clearTimeout(t)
        rej(new Error(`subscribe ${status} on ${channelName}`))
      }
    })
  })

  return channel
}

async function eventN(orderId: string, createdIds: string[]) {
  console.log('\n=== EVENT N — insert while subscribed, confirm it arrives without a refresh ===')

  let gotEvent = false
  const channel = supabase
    .channel(`probe-n-${Date.now()}`)
    .on(
      'postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'order_lines', filter: `restaurant_id=eq.${RESTAURANT_ID}` },
      (payload) => {
        if ((payload.new as { order_id?: string })?.order_id === orderId) gotEvent = true
      },
    )

  await new Promise<void>((res, rej) => {
    const t = setTimeout(() => rej(new Error('N: subscribe timeout')), 15000)
    channel.subscribe((status) => {
      if (status === 'SUBSCRIBED') {
        clearTimeout(t)
        res()
      }
    })
  })

  // A fresh Node process's Realtime connection needs a moment to warm up after SUBSCRIBED
  // before it reliably delivers a filtered postgres_changes event -- measured directly this
  // session: a 10s wait after insert missed the event outright; a 1s settle before inserting
  // plus a 25s wait after did not. Not a filter bug -- a cold-connection timing one.
  await sleep(1000)

  const id = await insertProbeLine(orderId, 'N (while open)')
  createdIds.push(id)

  const deadline = Date.now() + 25000
  while (!gotEvent && Date.now() < deadline) await sleep(200)

  await supabase.removeChannel(channel)

  console.log(`N: INSERT delivered over the open channel — ${gotEvent}`)
  assert(gotEvent, 'EVENT N FAILED: order_lines INSERT was not delivered over Realtime while subscribed')
  console.log('EVENT N: PASSED')
}

async function eventO(orderId: string, createdIds: string[]) {
  console.log(`\n=== EVENT O — kill the connection for ${OUTAGE_MS / 60000} min, insert, restore, confirm catch-up ===`)

  resetFeedConnection()
  const channelKey = `probe-o:${RESTAURANT_ID}`
  const statuses: string[] = []

  const unregister = registerFeedChannel(channelKey)
  await subscribeAndWait(`probe-o-${Date.now()}`, (status) => {
    statuses.push(status)
    reportFeedChannelStatus(channelKey, status)
  })
  console.log(`O: subscribed. Realtime socket state before kill: ${supabase.realtime.isConnected() ? 'connected' : 'not connected'}`)

  // Kill the TRANSPORT, not just this one channel — supabase.realtime.disconnect() closes the
  // underlying WebSocket, which is what a real dropped wifi/router blip does. Unsubscribing a
  // single channel would not exercise the same failure the brief is asking about.
  supabase.realtime.disconnect()
  console.log(`O: connection killed. Waiting ${OUTAGE_MS / 60000} minutes...`)
  await sleep(OUTAGE_MS)

  const duringOutageId = await insertProbeLine(orderId, 'O (during outage)')
  createdIds.push(duringOutageId)
  console.log('O: inserted a line WHILE the connection is dead (via a plain REST call, not the socket).')

  console.log('O: restoring the connection...')
  supabase.realtime.connect()

  const deadline = Date.now() + 30000
  while (!statuses.includes('SUBSCRIBED2') && Date.now() < deadline) {
    // Realtime auto-resubscribes existing channels on reconnect; reportFeedChannelStatus was
    // already fed every status via the callback above, so just wait for the socket to settle.
    if (supabase.realtime.isConnected()) break
    await sleep(500)
  }
  await sleep(3000) // let the resubscribe status land and get recorded

  console.log(`O: status sequence observed: ${statuses.join(' -> ')}`)

  const { data: bothRows, error: readError } = await supabase
    .from('order_lines')
    .select('id, name_snapshot')
    .in('id', createdIds)
  if (readError) throw readError
  console.log(`O: rows present after reconnect: ${(bothRows ?? []).length} of ${createdIds.length} created so far`)
  assert(
    (bothRows ?? []).length === createdIds.length,
    'EVENT O FAILED: a probe row created during the outage is missing from a plain read after reconnect — data was lost, not just the live event',
  )

  // The actual claim under test: does THIS repo's OWN resilience code, fed the REAL status
  // sequence this outage just produced, flag refetch: true on the return to SUBSCRIBED? This is
  // the mechanism app/kitchen/page.tsx and app/bar/page.tsx call to catch up.
  const droppedThenRecovered =
    statuses.some((s) => s === 'CHANNEL_ERROR' || s === 'TIMED_OUT' || s === 'CLOSED') &&
    statuses[statuses.length - 1] === 'SUBSCRIBED'
  console.log(`O: status sequence shows a real drop-then-recover: ${droppedThenRecovered}`)

  let lastEffect: ReturnType<typeof reportFeedChannelStatus> = { state: 'offline', refetch: false }
  for (const s of statuses) {
    lastEffect = reportFeedChannelStatus(channelKey, s)
  }
  console.log(`O: reportFeedChannelStatus's final effect for this exact status sequence: ${JSON.stringify(lastEffect)}`)

  unregister()

  assert(droppedThenRecovered, 'EVENT O FAILED: the observed status sequence never actually dropped and recovered — the outage did not exercise what it was meant to')
  assert(lastEffect.refetch, 'EVENT O FAILED: reportFeedChannelStatus did not flag refetch:true on this real recover sequence — the screen would NOT have caught up')
  console.log('EVENT O: PASSED')
}

async function main() {
  const orderId = await findOrCreateOrder()
  const createdIds: string[] = []

  try {
    await eventN(orderId, createdIds)
    await eventO(orderId, createdIds)
    console.log('\nPROBE_STATION_REALTIME_OK')
  } finally {
    await cleanup(createdIds)
  }
}

main().catch((err) => {
  console.error('\nPROBE FAILED:', err instanceof Error ? err.message : err)
  process.exitCode = 1
})
