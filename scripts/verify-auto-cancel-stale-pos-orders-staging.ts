/**
 * Staging verification for Part 2 — auto-cancel incomplete Sale-tab (POS) orders.
 *
 * Confirms:
 *  1. Fresh pending POS order is NOT cancelled before the 2-minute timeout
 *  2. After aging past 2 minutes, check-on-read (GET /api/terminal/orders) cancels it
 *     with cancellation_reason='auto_timeout'
 *  3. Concurrent push-to-terminal (payment_status flipped to terminal_pending) prevents cancel
 *  4. Aged terminal_pending orders are untouched
 *  5. Cron route performs the same cleanup (with CRON_SECRET)
 *
 *   npx tsx scripts/verify-auto-cancel-stale-pos-orders-staging.ts
 */
import { createClient } from '@supabase/supabase-js'
import { config } from 'dotenv'
import { resolve } from 'path'
import { signTerminalJwt } from '../lib/terminals/terminal-jwt'
import { STALE_POS_TIMEOUT_MS } from '../lib/orders/auto-cancel-stale-pos-orders'

config({ path: resolve(__dirname, '../.env.test'), override: true })
config({ path: resolve(__dirname, '../.env.local'), override: false })

const APP = process.env.VERIFY_APP_URL || 'https://flashtap-staging.llosperofficial.workers.dev'
const STAGING_REF = 'mdqjpxwczrhkxkbqatqa'
const RESTAURANT_ID = 'a1999166-ddfa-40d1-ad1f-2f01282a1652'

const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || ''
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || ''
const cronSecret = process.env.CRON_SECRET || process.env.STAGING_CRON_SECRET || ''

if (!url.includes(STAGING_REF) || !serviceKey) {
  throw new Error('Refusing: staging credentials missing (.env.test / .env.local)')
}
if (!process.env.TERMINAL_JWT_SECRET) {
  throw new Error('TERMINAL_JWT_SECRET missing — set in .env.local')
}

const admin = createClient(url, serviceKey, {
  auth: { autoRefreshToken: false, persistSession: false },
})

const tag = `auto-cancel-${Date.now()}`
const createdIds: string[] = []

function record(id: string, pass: boolean, detail: string) {
  console.log(`${pass ? 'PASS' : 'FAIL'} [${id}] ${detail}`)
  if (!pass) throw new Error(`Failed: ${id}`)
}

async function getActiveTerminal(): Promise<{ id: string; device_serial: string }> {
  const { data, error } = await admin
    .from('restaurant_terminals')
    .select('id, device_serial, status, active')
    .eq('restaurant_id', RESTAURANT_ID)
    .eq('active', true)
    .eq('status', 'active')
    .not('device_serial', 'is', null)
    .limit(1)
    .maybeSingle()
  if (error) throw error
  if (!data?.id || !data.device_serial) {
    throw new Error('No active terminal with device_serial found')
  }
  return { id: String(data.id), device_serial: String(data.device_serial) }
}

async function insertPosOrder(overrides: Record<string, unknown> = {}) {
  const placedAt =
    typeof overrides.placed_at === 'string'
      ? overrides.placed_at
      : new Date().toISOString()
  const row = {
    restaurant_id: RESTAURANT_ID,
    table_number: 0,
    order_number: Math.floor(Date.now() / 1000) % 1000000,
    channel: 'pos',
    status: 'pending',
    payment_status: 'pending',
    payment_channel: 'card_manual',
    payment_method: 'card',
    subtotal: 1,
    tax: 0,
    total: 1,
    items: [{ name: tag, quantity: 1, subtotal: 1 }],
    order_instructions: tag,
    placed_at: placedAt,
    ...overrides,
  }
  const { data, error } = await admin.from('orders').insert(row).select('id').single()
  if (error) throw error
  const id = String(data.id)
  createdIds.push(id)
  return id
}

async function getOrder(id: string) {
  const { data, error } = await admin
    .from('orders')
    .select('id, status, payment_status, cancellation_reason, cancelled_at, placed_at')
    .eq('id', id)
    .single()
  if (error) throw error
  return data
}

async function triggerTerminalGet(jwt: string) {
  const res = await fetch(`${APP}/api/terminal/orders`, {
    headers: { Authorization: `Bearer ${jwt}` },
  })
  const json = await res.json().catch(() => ({}))
  return { status: res.status, json }
}

async function cleanup() {
  if (!createdIds.length) return
  await admin.from('orders').delete().in('id', createdIds)
  console.log(`Cleaned up ${createdIds.length} test order(s)`)
}

async function main() {
  console.log(`APP=${APP}`)
  console.log(`tag=${tag}`)

  // Preflight: cancellation_reason column must exist
  const probeId = await insertPosOrder()
  const { error: probeErr } = await admin
    .from('orders')
    .update({ cancellation_reason: 'probe' })
    .eq('id', probeId)
  if (probeErr) {
    throw new Error(
      `cancellation_reason column missing on staging — apply migration 20260723090000 first: ${probeErr.message}`,
    )
  }
  await admin.from('orders').delete().eq('id', probeId)
  createdIds.splice(createdIds.indexOf(probeId), 1)

  const terminal = await getActiveTerminal()
  const jwt = await signTerminalJwt({
    terminal_id: terminal.id,
    restaurant_id: RESTAURANT_ID,
    device_serial: terminal.device_serial,
  })

  // 1) Fresh pending — must survive check-on-read
  const freshId = await insertPosOrder()
  const freshGet = await triggerTerminalGet(jwt)
  record('fresh-get-ok', freshGet.status === 200, `status=${freshGet.status}`)
  const freshAfter = await getOrder(freshId)
  record(
    'fresh-not-cancelled',
    freshAfter.payment_status === 'pending' && freshAfter.status === 'pending',
    `payment_status=${freshAfter.payment_status} status=${freshAfter.status}`,
  )

  // 2) Aged pending — check-on-read must cancel with auto_timeout
  const agedPendingId = await insertPosOrder({
    placed_at: new Date(Date.now() - STALE_POS_TIMEOUT_MS - 5_000).toISOString(),
  })
  const agedGet = await triggerTerminalGet(jwt)
  record('aged-get-ok', agedGet.status === 200, `status=${agedGet.status}`)
  const agedAfter = await getOrder(agedPendingId)
  record(
    'aged-cancelled',
    agedAfter.status === 'cancelled' &&
      agedAfter.payment_status === 'cancelled' &&
      agedAfter.cancellation_reason === 'auto_timeout' &&
      Boolean(agedAfter.cancelled_at),
    `status=${agedAfter.status} payment_status=${agedAfter.payment_status} reason=${agedAfter.cancellation_reason}`,
  )

  // 3) Concurrent push-to-terminal wins: aged but already terminal_pending
  const raceId = await insertPosOrder({
    placed_at: new Date(Date.now() - STALE_POS_TIMEOUT_MS - 5_000).toISOString(),
    payment_status: 'terminal_pending',
  })
  // Simulate race: flip a separate aged-pending row to terminal_pending just before cancel WHERE runs
  // by using the conditional UPDATE semantics — call cleanup after flipping.
  const racePendingId = await insertPosOrder({
    placed_at: new Date(Date.now() - STALE_POS_TIMEOUT_MS - 5_000).toISOString(),
  })
  await admin.from('orders').update({ payment_status: 'terminal_pending' }).eq('id', racePendingId)
  await triggerTerminalGet(jwt)
  const raceAfter = await getOrder(racePendingId)
  record(
    'race-terminal-pending-wins',
    raceAfter.payment_status === 'terminal_pending' && raceAfter.status === 'pending',
    `payment_status=${raceAfter.payment_status} status=${raceAfter.status}`,
  )

  const agedTerminalPending = await getOrder(raceId)
  record(
    'terminal-pending-untouched',
    agedTerminalPending.payment_status === 'terminal_pending' &&
      agedTerminalPending.status === 'pending' &&
      !agedTerminalPending.cancellation_reason,
    `payment_status=${agedTerminalPending.payment_status} reason=${agedTerminalPending.cancellation_reason}`,
  )

  // 4) Cron route (if secret available)
  if (cronSecret) {
    const cronAgedId = await insertPosOrder({
      placed_at: new Date(Date.now() - STALE_POS_TIMEOUT_MS - 5_000).toISOString(),
    })
    const cronRes = await fetch(`${APP}/api/cron/cleanup-stale-orders`, {
      method: 'POST',
      headers: { 'x-cron-secret': cronSecret },
    })
    const cronBody = await cronRes.json().catch(() => ({}))
    record('cron-http-ok', cronRes.status === 200, `status=${cronRes.status} body=${JSON.stringify(cronBody)}`)
    const cronAfter = await getOrder(cronAgedId)
    record(
      'cron-cancelled',
      cronAfter.cancellation_reason === 'auto_timeout' && cronAfter.payment_status === 'cancelled',
      `payment_status=${cronAfter.payment_status} reason=${cronAfter.cancellation_reason}`,
    )
  } else {
    console.log('SKIP [cron] CRON_SECRET / STAGING_CRON_SECRET not in env — HTTP cron check skipped')
  }

  await cleanup()
  console.log('ALL CHECKS PASSED')
}

main().catch(async (e) => {
  console.error(e)
  try {
    await cleanup()
  } catch (cleanupErr) {
    console.error('cleanup failed', cleanupErr)
  }
  process.exit(1)
})
