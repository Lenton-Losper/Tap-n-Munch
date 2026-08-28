/**
 * feat/station-screens-v1 — seed order_lines on STAGING with lines in every state a kitchen or
 * bar screen can actually show, so __tests__/station-screens-live-staging.test.tsx can render
 * the real KitchenScreen/BarScreen components against real rows.
 *
 * REBUILT 2026-08-28 for the real four-state model (lib/orders/order-lines.ts,
 * 20260828141000_cooked_state.sql). The old version of this script wrote the RETIRED 'done'
 * value and assumed 'unrouted' route_to was rejected by the live CHECK constraint — re-verified
 * live against staging 2026-08-28 (a throwaway insert-and-clean-up probe, not a guess): both
 * 'cooked'/'ready'/'voided' state values and route_to='unrouted' are accepted today. That old
 * finding was accurate for what staging looked like at the time; it is not accurate now that
 * 20260828141000_cooked_state.sql and the station tables have landed.
 *
 * AGE ESCALATION IS NOW ORDER AGE, NOT PER-LINE EVENT AGE. GET /api/station/lines returns no
 * per-line transition timestamp — only `placed_at` per ORDER (see lib/stations/types.ts's
 * docblock on why). So the red/white escalation proof below backdates two SEPARATE ORDERS'
 * placed_at, each carrying one cooked line, rather than backdating one order_line_events row the
 * way the old script did.
 *
 * STAGING ONLY, same two-guard shape scripts/diagnose-106-track-inventory-desync.ts uses.
 * Creates its OWN orders (tagged orders.session_id = PROBE_TAG) rather than reusing whatever
 * order happens to be open at the fixture restaurant.
 *
 * Usage:
 *   npx tsx scripts/seed-station-screens-staging.ts
 *   npx tsx scripts/seed-station-screens-staging.ts --cleanup
 */
import { resolve } from 'path'
import { writeFileSync } from 'fs'
import { createClient } from '@supabase/supabase-js'
import { config } from 'dotenv'
import { isLineReady, stationsOwnedBy, type LineRouteTo, type LineState } from '../lib/orders/order-lines'

/**
 * Written after a successful seed so __tests__/station-screens-live-staging.test.tsx can
 * render against these exact rows WITHOUT making a live network call from inside a jsdom test
 * environment — jsdom's global scope lacks fetch/TextDecoder/clearImmediate, and polyfilling
 * undici's full dependency chain to do real TLS there turned into exactly the kind of rabbit
 * hole this note exists to warn the next person off. Fetching real data and rendering it are
 * two different environments' jobs; this is the seam between them.
 */
export const SEED_SNAPSHOT_PATH =
  'C:\\Users\\223125~1\\AppData\\Local\\Temp\\claude\\C--Users-223125318-Desktop-mvp2-Tap-n-Munch\\08b91293-0bfd-4cc3-8f93-89b035332ccc\\scratchpad\\station-screens-seed-snapshot.json'

config({ path: resolve(__dirname, '../.env.test'), override: true })

const STAGING_REF = 'mdqjpxwczrhkxkbqatqa'
const PRODUCTION_REF = 'ihlmmpmolnpchzgwyhgh'

const URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || ''
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || ''

if (URL.includes(PRODUCTION_REF)) {
  throw new Error(`REFUSING: URL points at PRODUCTION (${PRODUCTION_REF}).`)
}
if (!URL.includes(STAGING_REF)) {
  throw new Error(`REFUSING: URL is not the staging ref (${STAGING_REF}). Got: ${URL || '(empty — .env.test missing or not loaded)'}`)
}
if (!KEY) throw new Error('REFUSING: no service role key in .env.test')

const db = createClient(URL, KEY, { auth: { autoRefreshToken: false, persistSession: false } })

// 'staging test' on this project. Verified 2026-08-28 to have restaurant_tables and active
// restaurant_terminals rows.
const RESTAURANT_ID = 'a1999166-ddfa-40d1-ad1f-2f01282a1652'
const PROBE_TAG = 'PROBE-station-screens-v1'

const cleanup = process.argv.includes('--cleanup')
const now = Date.now()
const minutesAgo = (n: number) => new Date(now - n * 60_000).toISOString()

async function guardTableExists() {
  const { error } = await db.from('order_lines').select('id').limit(1)
  if (error) {
    throw new Error(
      `REFUSING: order_lines is not queryable yet (${error.message}). Migrations may still be applying — re-run once they land.`,
    )
  }
}

type ProbeOrderSpec = {
  label: string
  placedMinutesAgo: number
  lines: Array<{
    name_snapshot: string
    route_to: LineRouteTo
    kitchen_state: LineState | null
    bar_state: LineState | null
    line_note?: string | null
  }>
}

const PROBE_ORDERS: ProbeOrderSpec[] = [
  {
    label: 'outstanding order',
    placedMinutesAgo: 3,
    lines: [
      { name_snapshot: 'PROBE: outstanding item', route_to: 'kitchen', kitchen_state: 'outstanding', bar_state: null },
    ],
  },
  {
    // AGE ESCALATION PROOF, red band: this ORDER was placed 6 minutes ago. Must render red and
    // sort ABOVE the 1-minute order below (oldest first).
    label: 'cooked 6 min ago order (expect RED, sorts first)',
    placedMinutesAgo: 6,
    lines: [
      {
        name_snapshot: 'PROBE: cooked, order placed 6 min ago (expect RED, sorts first)',
        route_to: 'kitchen',
        kitchen_state: 'cooked',
        bar_state: null,
      },
    ],
  },
  {
    // AGE ESCALATION PROOF, white band: this ORDER was placed 1 minute ago. Must render white
    // and sort AFTER the 6-minute order above.
    label: 'cooked 1 min ago order (expect WHITE, sorts second)',
    placedMinutesAgo: 1,
    lines: [
      {
        name_snapshot: 'PROBE: cooked, order placed 1 min ago (expect WHITE, sorts second)',
        route_to: 'kitchen',
        kitchen_state: 'cooked',
        bar_state: null,
      },
    ],
  },
  {
    // 'both', HALF-BUMPED: kitchen is cooked, bar is still outstanding — proves the two states
    // move independently. Must appear in kitchen's cooked zone and must NOT be missing from
    // bar's IN queue.
    label: 'both, half-bumped (kitchen cooked, bar still outstanding)',
    placedMinutesAgo: 2,
    lines: [
      {
        name_snapshot: 'PROBE: both, half-bumped (kitchen cooked, bar still outstanding)',
        route_to: 'both',
        kitchen_state: 'cooked',
        bar_state: 'outstanding',
      },
    ],
  },
  {
    // 'unrouted' — re-verified live 2026-08-28 (see the file docblock) that the current staging
    // CHECK constraint accepts this, unlike what the previous version of this script found.
    label: 'unrouted item',
    placedMinutesAgo: 2,
    lines: [
      { name_snapshot: 'PROBE: unrouted item', route_to: 'unrouted', kitchen_state: 'outstanding', bar_state: 'outstanding' },
    ],
  },
]

async function createProbeOrder(spec: ProbeOrderSpec): Promise<{ orderId: string; tableNumber: number }> {
  const { data: table, error: tableError } = await db
    .from('restaurant_tables')
    .select('id, table_number')
    .eq('restaurant_id', RESTAURANT_ID)
    .limit(1)
    .maybeSingle()
  if (tableError) throw tableError
  if (!table?.id) {
    throw new Error('REFUSING: no restaurant_tables row found for the fixture restaurant.')
  }

  const probeOrderNumber = 900000 + (Date.now() % 90000) + Math.floor(Math.random() * 1000)
  const { data: created, error: createError } = await db
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
      placed_at: minutesAgo(spec.placedMinutesAgo),
    })
    .select('id, table_number')
    .single()

  if (createError || !created?.id) {
    throw new Error(`REFUSING: could not create a probe order (${spec.label}): ${createError?.message}`)
  }
  console.log(`Created probe order ${created.id} (${spec.label}, order_number ${probeOrderNumber}, table ${created.table_number}).`)
  return { orderId: String(created.id), tableNumber: created.table_number }
}

async function runCleanup() {
  const { data: probeOrders, error: probeOrdersError } = await db
    .from('orders')
    .select('id')
    .eq('session_id', PROBE_TAG)
  if (probeOrdersError) throw probeOrdersError

  const orderIds = (probeOrders ?? []).map((r: { id: string }) => r.id)
  console.log(`Found ${orderIds.length} probe order(s) tagged '${PROBE_TAG}'.`)
  if (orderIds.length === 0) return

  const { data: lines, error: linesError } = await db
    .from('order_lines')
    .select('id')
    .in('order_id', orderIds)
  if (linesError) throw linesError
  const lineIds = (lines ?? []).map((r: { id: string }) => r.id)

  if (lineIds.length > 0) {
    const { error: deleteEventsError } = await db.from('order_line_events').delete().in('order_line_id', lineIds)
    if (deleteEventsError) console.warn('Could not delete order_line_events:', deleteEventsError.message)

    const { error: deleteLinesError } = await db.from('order_lines').delete().in('id', lineIds)
    if (deleteLinesError) throw deleteLinesError
    console.log(`Deleted ${lineIds.length} probe line(s) and their events.`)
  }

  const { error: deleteOrdersError } = await db.from('orders').delete().in('id', orderIds)
  if (deleteOrdersError) throw deleteOrdersError
  console.log(`Deleted ${orderIds.length} probe order(s).`)
}

type InsertedLine = {
  id: string
  order_id: string
  name_snapshot: string
  quantity: number
  line_note: string | null
  route_to: LineRouteTo
  kitchen_state: LineState | null
  bar_state: LineState | null
}

/**
 * Builds the SAME shape GET /api/station/lines returns for one station — one card per order,
 * NOT-FINISHED lines only, is_ready computed via the real isLineReady() — from plain rows this
 * script already has in hand. Not a re-guess of that route's contract: it imports the same
 * isLineReady/stationsOwnedBy this script also used to decide what to insert, so the "server"
 * and "seed" side of this proof cannot silently drift apart.
 */
function buildStationResponse(
  station: 'kitchen' | 'bar',
  orders: Array<{ id: string; order_number: number; table_number: number; placed_at: string }>,
  lines: InsertedLine[],
) {
  const stateColumn = station === 'kitchen' ? 'kitchen_state' : 'bar_state'
  const orderById = new Map(orders.map((o) => [o.id, o]))

  const cardsByOrder = new Map<string, ReturnType<typeof emptyCard>>()
  function emptyCard(orderId: string) {
    const order = orderById.get(orderId)!
    return {
      order_id: orderId,
      order_number: order.order_number,
      table_number: order.table_number,
      order_instructions: null,
      placed_at: order.placed_at,
      seconds_waiting: Math.max(0, Math.round((now - new Date(order.placed_at).getTime()) / 1000)),
      lines: [] as unknown[],
    }
  }

  for (const line of lines) {
    const state = (line[stateColumn] ?? null) as LineState | null
    if (state === null || state === 'ready' || state === 'voided') continue // NOT-FINISHED, same as the real route

    if (!cardsByOrder.has(line.order_id)) cardsByOrder.set(line.order_id, emptyCard(line.order_id))
    cardsByOrder.get(line.order_id)!.lines.push({
      id: line.id,
      name_snapshot: line.name_snapshot,
      quantity: line.quantity,
      line_note: line.line_note,
      route_to: line.route_to,
      kitchen_state: line.kitchen_state,
      bar_state: line.bar_state,
      is_ready: isLineReady(line),
      unrouted: line.route_to === 'unrouted',
      shared_with_other_station: line.route_to === 'both' || line.route_to === 'unrouted',
    })
  }

  const orderCards = [...cardsByOrder.values()].sort((a, b) => a.placed_at.localeCompare(b.placed_at))
  return { station, orders: orderCards, server_time: new Date(now).toISOString() }
}

async function runSeed() {
  await guardTableExists()

  console.log(`\n=== seeding order_lines on STAGING ${STAGING_REF} ===\n`)

  const ordersCreated: Array<{ id: string; order_number: number; table_number: number; placed_at: string }> = []
  const allInsertedLines: InsertedLine[] = []

  for (const spec of PROBE_ORDERS) {
    // Every line's stationsOwnedBy() must agree with the route_to it was seeded with — a real
    // assertion, not decoration, since a mismatch here would mean this script and the domain
    // model it imports have drifted.
    for (const line of spec.lines) {
      const owned = stationsOwnedBy(line.route_to)
      if (owned.includes('kitchen') !== (line.kitchen_state !== null)) {
        throw new Error(`REFUSING: ${spec.label} — kitchen_state nullness disagrees with stationsOwnedBy(${line.route_to})`)
      }
      if (owned.includes('bar') !== (line.bar_state !== null)) {
        throw new Error(`REFUSING: ${spec.label} — bar_state nullness disagrees with stationsOwnedBy(${line.route_to})`)
      }
    }

    const { orderId, tableNumber } = await createProbeOrder(spec)
    const placedAt = minutesAgo(spec.placedMinutesAgo)
    ordersCreated.push({ id: orderId, order_number: 0, table_number: tableNumber, placed_at: placedAt })

    const rows = spec.lines.map((line, index) => ({
      restaurant_id: RESTAURANT_ID,
      order_id: orderId,
      source_item_index: index,
      name_snapshot: line.name_snapshot,
      quantity: 1,
      line_note: line.line_note ?? null,
      route_to: line.route_to,
      kitchen_state: line.kitchen_state,
      bar_state: line.bar_state,
    }))

    const { data: inserted, error: insertError } = await db.from('order_lines').insert(rows).select('*')
    if (insertError) {
      console.error(`\nINSERT FAILED (order_lines, ${spec.label}) — this is a real finding about the schema, not a bug in this script:`)
      console.error(insertError.message)
      process.exitCode = 1
      return
    }
    console.log(`  Inserted ${inserted?.length ?? 0} order_lines row(s) for '${spec.label}'.`)
    allInsertedLines.push(...((inserted ?? []) as InsertedLine[]))

    // A creation event per station the line is owned by — mirrors writeOrderLines' own shape
    // (lib/orders/order-lines.ts), so these rows look like ones the real write path would have
    // produced, not a seed-script invention.
    const events = (inserted ?? []).flatMap((row: InsertedLine) =>
      stationsOwnedBy(row.route_to).map((station) => ({
        restaurant_id: RESTAURANT_ID,
        order_line_id: row.id,
        station,
        from_state: null,
        to_state: 'outstanding',
        actor_kind: 'terminal' as const,
        actor_user_id: null,
      })),
    )
    if (events.length > 0) {
      const { error: eventsError } = await db.from('order_line_events').insert(events)
      if (eventsError) console.warn(`  creation events failed for '${spec.label}':`, eventsError.message)
    }
  }

  const tableNumberByOrderId: Record<string, string> = {}
  for (const o of ordersCreated) tableNumberByOrderId[o.id] = String(o.table_number)

  const kitchenResponse = buildStationResponse('kitchen', ordersCreated, allInsertedLines)
  const barResponse = buildStationResponse('bar', ordersCreated, allInsertedLines)

  writeFileSync(
    SEED_SNAPSHOT_PATH,
    JSON.stringify(
      {
        seededAt: new Date().toISOString(),
        restaurantId: RESTAURANT_ID,
        tableNumberByOrderId,
        kitchenResponse,
        barResponse,
      },
      null,
      2,
    ),
  )
  console.log(`\nSnapshot written to ${SEED_SNAPSHOT_PATH} for __tests__/station-screens-live-staging.test.tsx to render against.`)

  console.log('')
  for (const row of allInsertedLines) {
    console.log(`  ${row.name_snapshot} — route_to=${row.route_to} kitchen_state=${row.kitchen_state} bar_state=${row.bar_state}`)
  }
  console.log(`\nrestaurant_id: ${RESTAURANT_ID}`)
  console.log(`\nClean up afterward: npx tsx scripts/seed-station-screens-staging.ts --cleanup`)
}

async function main() {
  if (cleanup) {
    await runCleanup()
  } else {
    await runSeed()
  }
}

void main().catch((err) => {
  console.error(err instanceof Error ? err.message : err)
  process.exitCode = 1
})
