/**
 * REAL-STAGING PROOF for the two station bump-route fixes (see app/api/terminal/station-lines/
 * [lineId]/route.ts and app/api/terminal/bar-rounds/[roundId]/route.ts docblocks).
 *
 * Runs the REAL kitchen bump route handler (POST /api/terminal/station-lines/[lineId], the
 * `action: 'ready_to_run'` tap) in-process against a real seeded STAGING row, through its real
 * delegate (POST /api/station/order-lines/[lineId]/state), and queries the result back from
 * staging directly -- not a mock, not a snapshot.
 *
 * STAGING ONLY, same two-guard shape as scripts/seed-station-screens-staging.ts. Creates its own
 * PROBE-tagged order, order_lines row and restaurant_terminals row; deletes all three afterward
 * (--cleanup or automatically at the end of a successful --prove run). Never touches any
 * pre-existing row in restaurant_terminals or restaurant_features -- it reads the venue's current
 * station_screens_enabled value, flips it only if necessary, and restores the exact prior value
 * before exiting, in a try/finally so a failed assertion still restores it.
 *
 * Usage:
 *   npx tsx scripts/verify-station-bump-real-state-staging.ts --prove
 *   npx tsx scripts/verify-station-bump-real-state-staging.ts --cleanup
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

// The real route modules call lib/supabase/server's createServerSupabaseClient(), which reads
// NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY -- give it the SAME staging URL/key
// already guarded above, just under the names that module reads. Real client, real staging, not
// a substitute.
process.env.NEXT_PUBLIC_SUPABASE_URL = URL
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || 'unused-service-role-key-carries-the-request'
// lib/terminal-auth.ts reads this at MODULE load time to build its jwtVerify secret, and
// lib/terminals/terminal-jwt.ts reads it at CALL time to sign. Neither is imported until after
// this line runs (both imports below are dynamic), so both sides of the sign/verify pair agree
// on this one process-local value. Never written anywhere, never reused outside this run.
process.env.TERMINAL_JWT_SECRET = process.env.TERMINAL_JWT_SECRET || `PROBE-local-secret-${Date.now()}-${Math.random().toString(36).slice(2)}`

const db = createClient(URL, KEY, { auth: { autoRefreshToken: false, persistSession: false } })

const RESTAURANT_ID = 'a1999166-ddfa-40d1-ad1f-2f01282a1652'
const PROBE_TAG = 'PROBE-station-bump-real-state'

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
  console.log(`Found ${orderIds.length} probe order(s), ${terminalIds.length} probe terminal(s) tagged '${PROBE_TAG}'.`)

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

  // Deleted STRICTLY by id, one row at a time, never a broad match on restaurant_id alone --
  // this must never touch a real terminal a venue paired.
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

  // 0. Guard: never touch order_lines before confirming it is reachable (mirrors the seed script).
  const { error: guardError } = await db.from('order_lines').select('id').limit(1)
  if (guardError) throw new Error(`REFUSING: order_lines not queryable (${guardError.message})`)

  // 1. Read (do not assume) the venue's current station_screens_enabled value, so it can be
  // restored exactly, whatever it was.
  const { data: featuresRow, error: featuresReadError } = await db
    .from('restaurant_features')
    .select('restaurant_id, station_screens_enabled')
    .eq('restaurant_id', RESTAURANT_ID)
    .maybeSingle()
  if (featuresReadError) throw featuresReadError

  const priorFlagValue = featuresRow?.station_screens_enabled ?? false
  const needsFlagFlip = priorFlagValue !== true
  console.log(`restaurant_features.station_screens_enabled for ${RESTAURANT_ID}: currently ${priorFlagValue}${needsFlagFlip ? ' -- will flip to true for this proof, then restore.' : ' -- already true, leaving as-is.'}`)

  let terminalId: string | null = null
  let orderId: string | null = null

  try {
    if (needsFlagFlip) {
      if (!featuresRow) {
        const { error } = await db.from('restaurant_features').insert({ restaurant_id: RESTAURANT_ID, station_screens_enabled: true })
        if (error) throw error
      } else {
        const { error } = await db
          .from('restaurant_features')
          .update({ station_screens_enabled: true })
          .eq('restaurant_id', RESTAURANT_ID)
        if (error) throw error
      }
    }

    // 2. Create ONE new PROBE terminal, paired to kitchen. Never reuses or touches any existing
    // restaurant_terminals row.
    const { data: terminal, error: terminalError } = await db
      .from('restaurant_terminals')
      .insert({
        restaurant_id: RESTAURANT_ID,
        device_serial: PROBE_TAG,
        terminal_name: PROBE_TAG,
        status: 'active',
        station_kind: 'kitchen',
      })
      .select('id')
      .single()
    if (terminalError || !terminal?.id) throw new Error(`REFUSING: could not create probe terminal: ${terminalError?.message}`)
    terminalId = String(terminal.id)
    console.log(`Created probe terminal ${terminalId} (device_serial='${PROBE_TAG}', station_kind='kitchen').`)

    // 3. Create ONE probe order + one order_lines row, kitchen_state = 'cooked' -- the pre-state
    // for the 'ready_to_run' tap this proof exercises (cooked -> ready).
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
        name_snapshot: 'PROBE: ready_to_run real-state proof',
        quantity: 1,
        route_to: 'kitchen',
        kitchen_state: 'cooked',
        bar_state: null,
      })
      .select('id, kitchen_state, bar_state, route_to')
      .single()
    if (lineError || !line?.id) throw new Error(`REFUSING: could not create probe line: ${lineError?.message}`)
    const lineId = String(line.id)
    console.log(`Created probe order ${orderId} / line ${lineId}, kitchen_state='cooked'.`)

    // 4. Sign a REAL terminal JWT for the probe terminal (lib/terminals/terminal-jwt.ts, imported
    // dynamically so it reads the TERMINAL_JWT_SECRET set above), then call the REAL kitchen bump
    // route handler in-process with a constructed Request -- exactly the shape
    // __tests__/station-pairing-enforcement.test.ts uses to test these route handlers directly,
    // except nothing here is mocked: real JWT, real Supabase client, real staging rows.
    const { signTerminalJwt } = await import('../lib/terminals/terminal-jwt')
    const token = await signTerminalJwt({
      terminal_id: terminalId,
      restaurant_id: RESTAURANT_ID,
      device_serial: PROBE_TAG,
    })

    const { POST: bumpLinePOST } = await import('../app/api/terminal/station-lines/[lineId]/route')

    const req = new Request(`http://localhost/api/terminal/station-lines/${lineId}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'ready_to_run' }),
    })

    console.log('\n=== calling the REAL POST /api/terminal/station-lines/[lineId] handler, action: ready_to_run ===\n')
    const res = await bumpLinePOST(req, { params: Promise.resolve({ lineId }) })
    const status = res.status
    const body = await res.json().catch(() => null)
    console.log(`Response status: ${status}`)
    console.log(`Response body: ${JSON.stringify(body, null, 2)}`)

    if (status !== 200) {
      throw new Error(`PROOF FAILED: expected 200, got ${status}. This is what the fix must prevent.`)
    }
    if (!body?.ok || body.line?.kitchen_state !== 'ready') {
      throw new Error(`PROOF FAILED: expected ok:true and kitchen_state:'ready' in the response, got ${JSON.stringify(body)}`)
    }

    // 5. Query the row back from staging directly -- not the route's own response, a fresh read.
    const { data: freshLine, error: freshLineError } = await db
      .from('order_lines')
      .select('id, kitchen_state, bar_state, route_to')
      .eq('id', lineId)
      .single()
    if (freshLineError) throw freshLineError

    console.log('\n=== order_lines row, queried back fresh from staging ===\n')
    console.log(JSON.stringify(freshLine, null, 2))

    if (freshLine.kitchen_state !== 'ready') {
      throw new Error(`PROOF FAILED: staging row's kitchen_state is '${freshLine.kitchen_state}', not 'ready'.`)
    }

    // 6. Query the audit event back.
    const { data: events, error: eventsError } = await db
      .from('order_line_events')
      .select('id, restaurant_id, order_line_id, station, from_state, to_state, actor_kind, actor_user_id, occurred_at')
      .eq('order_line_id', lineId)
      .order('occurred_at', { ascending: true })
    if (eventsError) throw eventsError

    console.log('\n=== order_line_events row(s), queried back fresh from staging ===\n')
    console.log(JSON.stringify(events, null, 2))

    if (!events || events.length !== 1) {
      throw new Error(`PROOF FAILED: expected exactly 1 order_line_events row, found ${events?.length ?? 0}.`)
    }
    const event = events[0]
    const columnsPresent = Object.keys(event)
    const requiredColumns = ['from_state', 'to_state', 'actor_kind', 'actor_user_id', 'occurred_at']
    const missing = requiredColumns.filter((c) => !columnsPresent.includes(c))
    if (missing.length > 0) throw new Error(`PROOF FAILED: event row missing columns: ${missing.join(', ')}`)
    if (event.from_state !== 'cooked' || event.to_state !== 'ready' || event.station !== 'kitchen' || event.actor_kind !== 'station') {
      throw new Error(`PROOF FAILED: event row has wrong values: ${JSON.stringify(event)}`)
    }
    // The two bugs this fix closes, asserted directly against the real row: never the literal
    // action name, and never the guessed event_type/created_at/created_by shape.
    if ((freshLine as unknown as Record<string, unknown>).kitchen_state === 'ready_to_run') {
      throw new Error('PROOF FAILED: kitchen_state stored the action name, not the state.')
    }
    if ('event_type' in event || 'created_by' in event) {
      throw new Error('PROOF FAILED: event row still carries the guessed event_type/created_by shape.')
    }

    console.log('\n=== PROOF PASSED ===')
    console.log('- POST /api/terminal/station-lines/[lineId] with action:"ready_to_run" returned 200, not a 500.')
    console.log("- The line's stored kitchen_state, read back fresh from staging, is genuinely 'ready'.")
    console.log('- Exactly one order_line_events row was written, with real from_state/to_state/actor_kind/actor_user_id/occurred_at columns, matching the transition.')
  } finally {
    // Cleanup always runs, success or failure -- delete only what this run created, by exact id,
    // and restore the feature flag to exactly what it was before this run touched it.
    console.log('\n=== cleaning up probe rows ===')
    if (orderId) {
      const { data: lines } = await db.from('order_lines').select('id').eq('order_id', orderId)
      const lineIds = (lines ?? []).map((r: { id: string }) => r.id)
      if (lineIds.length > 0) {
        await db.from('order_line_events').delete().in('order_line_id', lineIds)
        await db.from('order_lines').delete().in('id', lineIds)
      }
      await db.from('orders').delete().eq('id', orderId)
      console.log(`Deleted probe order ${orderId} and its line(s)/event(s).`)
    }
    if (terminalId) {
      await db.from('restaurant_terminals').delete().eq('id', terminalId)
      console.log(`Deleted probe terminal ${terminalId}, by id.`)
    }
    if (needsFlagFlip) {
      if (!featuresRow) {
        await db.from('restaurant_features').delete().eq('restaurant_id', RESTAURANT_ID)
        console.log(`Removed the restaurant_features row this run created for ${RESTAURANT_ID} (none existed before).`)
      } else {
        await db.from('restaurant_features').update({ station_screens_enabled: priorFlagValue }).eq('restaurant_id', RESTAURANT_ID)
        console.log(`Restored restaurant_features.station_screens_enabled to ${priorFlagValue} for ${RESTAURANT_ID}.`)
      }
    }
  }
}

main().catch((err) => {
  console.error('\nFAILED:', err instanceof Error ? err.message : err)
  process.exitCode = 1
})
