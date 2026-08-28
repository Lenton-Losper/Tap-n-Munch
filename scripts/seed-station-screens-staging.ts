/**
 * feat/station-screens-v1 — seed order_lines (+ order_line_events) on STAGING with a line in
 * every PROVEN state, so the kitchen and bar screens can be proved against real rows.
 *
 * CORRECTED 2026-08-28 to the real column/value shape — see
 * lib/stations/schema-assumptions.ts's docblock for the full account of what was found and why
 * it differs from the verbally-relayed shape (four kitchen_state values were described; only
 * 'outstanding' and 'done' have been observed in real rows, and this script only ever writes
 * those two).
 *
 * Also seeds the AGE-ESCALATION proof directly: two 'done' lines with real, backdated
 * order_line_events.occurred_at — one 6 minutes old (must render RED and sort to the top of
 * READY TO RUN) and one 1 minute old (must render WHITE and sort after it).
 *
 * STAGING ONLY, same two-guard shape scripts/diagnose-106-track-inventory-desync.ts uses.
 * Creates its OWN order (tagged orders.session_id = PROBE_TAG) rather than reusing whatever
 * order happens to be open at the fixture restaurant — the one open order found there earlier
 * turned out to be another team's own E2E fixture (cancelled mid-run), and probe data belongs
 * in a probe's own order, not borrowed from someone else's.
 *
 * Usage:
 *   npx tsx scripts/seed-station-screens-staging.ts
 *   npx tsx scripts/seed-station-screens-staging.ts --cleanup
 */
import { resolve } from 'path'
import { writeFileSync } from 'fs'
import { createClient } from '@supabase/supabase-js'
import { config } from 'dotenv'

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

async function createProbeOrder(): Promise<{ orderId: string; tableNumber: number }> {
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

  const probeOrderNumber = 900000 + (Date.now() % 90000)
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
    })
    .select('id, table_number')
    .single()

  if (createError || !created?.id) {
    throw new Error(`REFUSING: could not create a probe order: ${createError?.message}`)
  }
  console.log(`Created probe order ${created.id} (order_number ${probeOrderNumber}, table ${created.table_number}).`)
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

type SeedLine = {
  name_snapshot: string
  route_to: 'kitchen' | 'bar' | 'both' | 'unrouted'
  kitchen_state: 'outstanding' | 'done' | null
  bar_state: 'outstanding' | 'done' | null
  /** [station, to_state, minutes_ago][] — order_line_events to attach once the line has an id. */
  events: Array<['kitchen' | 'bar', 'outstanding' | 'done', number]>
}

const SEED_LINES: SeedLine[] = [
  {
    name_snapshot: 'PROBE: outstanding item',
    route_to: 'kitchen',
    kitchen_state: 'outstanding',
    bar_state: null,
    events: [],
  },
  {
    // AGE ESCALATION PROOF, red band: done 6 minutes ago. Must render red and sort ABOVE the
    // 1-minute line below (oldest first).
    name_snapshot: 'PROBE: done 6 min ago (expect RED, sorts first)',
    route_to: 'kitchen',
    kitchen_state: 'done',
    bar_state: null,
    events: [['kitchen', 'done', 6]],
  },
  {
    // AGE ESCALATION PROOF, white band: done 1 minute ago. Must render white and sort AFTER
    // the 6-minute line above.
    name_snapshot: 'PROBE: done 1 min ago (expect WHITE, sorts second)',
    route_to: 'kitchen',
    kitchen_state: 'done',
    bar_state: null,
    events: [['kitchen', 'done', 1]],
  },
  {
    // 'both', HALF-BUMPED: kitchen is done, bar is still outstanding — proves the two states
    // move independently. Must appear in kitchen's READY TO RUN and must NOT read as Out on bar.
    name_snapshot: 'PROBE: both, half-bumped (kitchen done, bar still outstanding)',
    route_to: 'both',
    kitchen_state: 'done',
    bar_state: 'outstanding',
    events: [['kitchen', 'done', 0.5]],
  },
  // 'unrouted' is DELIBERATELY NOT SEEDED. Diagnosed live against staging's
  // order_lines_states_match_route CHECK constraint 2026-08-28: route_to='unrouted' (and every
  // plausible alternate spelling tried: unassigned/none/no_station/unset) is rejected regardless
  // of kitchen_state/bar_state — the current staging migration does not yet accept it, contrary
  // to the 2026-08-28 ruling that it is a value in the enum. Real finding, not a guess to work
  // around a third time; reported rather than seeded with an invented workaround.
]

async function runSeed() {
  await guardTableExists()
  const { orderId, tableNumber } = await createProbeOrder()

  console.log(`\n=== seeding order_lines on STAGING ${STAGING_REF}, order ${orderId} ===\n`)

  const rows = SEED_LINES.map((line, index) => ({
    restaurant_id: RESTAURANT_ID,
    order_id: orderId,
    source_item_index: index,
    name_snapshot: line.name_snapshot,
    quantity: 1,
    route_to: line.route_to,
    kitchen_state: line.kitchen_state,
    bar_state: line.bar_state,
  }))

  const { data: inserted, error: insertError } = await db.from('order_lines').insert(rows).select('*')

  if (insertError) {
    console.error('\nINSERT FAILED (order_lines) — this is a real finding about the schema, not a bug in this script:')
    console.error(insertError.message)
    process.exitCode = 1
    return
  }

  console.log(`Inserted ${inserted?.length ?? 0} order_lines row(s).`)

  const eventRows = (inserted ?? []).flatMap((row, i) =>
    SEED_LINES[i].events.map(([station, toState, minsAgo]) => ({
      restaurant_id: RESTAURANT_ID,
      order_line_id: row.id,
      station,
      from_state: 'outstanding',
      to_state: toState,
      actor_kind: 'terminal',
      actor_user_id: null,
      occurred_at: minutesAgo(minsAgo),
    })),
  )

  if (eventRows.length > 0) {
    const { error: eventsError } = await db.from('order_line_events').insert(eventRows)
    if (eventsError) {
      console.error('\nINSERT FAILED (order_line_events) — order_lines rows above ARE live; clean up and fix before retrying:')
      console.error(eventsError.message)
      process.exitCode = 1
      return
    }
    console.log(`Inserted ${eventRows.length} order_line_events row(s).`)
  }

  const { data: insertedEvents } = eventRows.length
    ? await db.from('order_line_events').select('*').in('order_line_id', (inserted ?? []).map((r) => r.id))
    : { data: [] }

  writeFileSync(
    SEED_SNAPSHOT_PATH,
    JSON.stringify(
      {
        seededAt: new Date().toISOString(),
        restaurantId: RESTAURANT_ID,
        orderId,
        tableNumberByOrderId: { [orderId]: String(tableNumber) },
        lines: inserted ?? [],
        events: insertedEvents ?? [],
      },
      null,
      2,
    ),
  )
  console.log(`\nSnapshot written to ${SEED_SNAPSHOT_PATH} for __tests__/station-screens-live-staging.test.tsx to render against.`)

  console.log('')
  for (const row of inserted ?? []) {
    console.log(`  ${row.name_snapshot} — route_to=${row.route_to} kitchen_state=${row.kitchen_state} bar_state=${row.bar_state}`)
  }
  console.log(`\nrestaurant_id: ${RESTAURANT_ID}`)
  console.log(`order_id: ${orderId}`)
  console.log(`table_number: ${tableNumber}`)
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
