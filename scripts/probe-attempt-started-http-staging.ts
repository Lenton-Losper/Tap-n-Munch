/**
 * HTTP probe against the deployed staging Worker for the attempt-started marker and
 * the E04111 cron discriminator.
 *
 * Confirms:
 *  1. POST /api/terminal/orders/[orderId]/attempt-started records the marker
 *  2. The endpoint is idempotent on retry
 *  3. Cron + E04111 cancels allocated-only orders as no_payment_attempt_made
 *  4. Cron + E04111 leaves attempt-started orders pending/uncertain
 *
 * Marker: PROBE_ATTEMPT_STARTED_HTTP_STAGING_OK
 * Trigger: commit message contains [probe-attempt-started-http]
 */
// @ts-nocheck
import { createClient } from '@supabase/supabase-js'
import { randomUUID } from 'crypto'
import { config } from 'dotenv'
import { resolve } from 'path'
import { generateTerminalActivationCode } from '../lib/terminals/activation-code'
import { STALE_POS_TIMEOUT_MS } from '../lib/orders/auto-cancel-stale-pos-orders'

config({ path: resolve(__dirname, '../.env.test'), override: true })
config({ path: resolve(__dirname, '../.env.local'), override: false })

const WORKER =
  process.env.STAGING_WORKER_URL || 'https://flashtap-staging.llosperofficial.workers.dev'
const STAGING_REF = 'mdqjpxwczrhkxkbqatqa'
const url =
  process.env.NEXT_PUBLIC_SUPABASE_URL ||
  process.env.STAGING_SUPABASE_URL ||
  process.env.SUPABASE_URL ||
  ''
const serviceKey =
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.STAGING_SUPABASE_SERVICE_ROLE_KEY || ''

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg)
}

function log(label: string, value: unknown) {
  console.log(`== ${label} ==`)
  console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2))
}

async function httpJson(
  method: string,
  path: string,
  body?: unknown,
  headers?: Record<string, string>,
) {
  const res = await fetch(`${WORKER}${path}`, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  let json: unknown = null
  try {
    json = JSON.parse(text)
  } catch {
    json = text
  }
  return { status: res.status, json, text }
}

async function main() {
  assert(url.includes(STAGING_REF) && serviceKey, 'Need staging URL + service role')
  log('worker', WORKER)
  log('supabase', url)

  const admin = createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  })

  const tag = `attempt-started-http-${Date.now()}`
  const activationCode = generateTerminalActivationCode()
  const deviceSerial = `probe-${tag}`
  const createdOrderIds: string[] = []

  const { data: restaurant, error: restaurantErr } = await admin
    .from('restaurants')
    .insert({
      name: tag,
      finatic_merchant_no: 'STAGING_STUB_MERCHANT',
      finatic_store_no: 'STAGING_STUB_STORE',
    })
    .select('id')
    .single()
  assert(!restaurantErr && restaurant?.id, `restaurant insert failed: ${restaurantErr?.message}`)
  const restaurantId = String(restaurant.id)

  const { data: terminal, error: termErr } = await admin
    .from('restaurant_terminals')
    .insert({
      restaurant_id: restaurantId,
      terminal_name: tag,
      active: false,
      status: 'pending',
      activation_code: activationCode,
      activation_code_expires_at: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
      device_id: `pending-${randomUUID()}`,
    })
    .select('id')
    .single()
  assert(!termErr && terminal?.id, `terminal insert failed: ${termErr?.message}`)
  const terminalId = String(terminal.id)

  const insertOrder = async (
    suffix: string,
    merchantOrderNo: string,
    placedAt: string = new Date().toISOString(),
  ) => {
    const { data, error } = await admin
      .from('orders')
      .insert({
        restaurant_id: restaurantId,
        table_number: 0,
        channel: 'pos',
        status: 'pending',
        payment_status: 'pending',
        payment_method: 'card',
        payment_channel: 'card_manual',
        subtotal: 8,
        tax: 0,
        total: 8,
        items: [{ name: `${tag}-${suffix}`, quantity: 1, subtotal: 8 }],
        placed_at: placedAt,
        paycloud_merchant_order_no: merchantOrderNo,
      })
      .select('id')
      .single()
    assert(!error && data?.id, `order insert ${suffix}: ${error?.message}`)
    const id = String(data.id)
    createdOrderIds.push(id)
    return id
  }

  const readOrder = async (id: string) => {
    const { data, error } = await admin
      .from('orders')
      .select('id, status, payment_status, cancellation_reason, cancelled_at')
      .eq('id', id)
      .single()
    assert(!error && data, `read order ${id}: ${error?.message}`)
    return data
  }

  try {
    const activate = await httpJson('POST', '/api/terminals/activate', {
      code: activationCode,
      deviceId: deviceSerial,
      terminalSn: deviceSerial,
    })
    log('ACTIVATE_HTTP', activate)
    assert(activate.status === 200, `activate failed: ${activate.status}`)
    const accessToken = String((activate.json as any)?.accessToken || '')
    assert(accessToken, 'activate did not return accessToken')
    const auth = { Authorization: `Bearer ${accessToken}` }

    const markerBusinessOrderNo = `FTMKR${Date.now()}`.slice(0, 32)
    const markerOrder = await insertOrder('marker', markerBusinessOrderNo)
    const launchedAt = new Date().toISOString()
    const markerBody = {
      businessOrderNo: markerBusinessOrderNo,
      appVersion: 'probe-1.0.0',
      launchedAt,
    }

    const markerFirst = await httpJson(
      'POST',
      `/api/terminal/orders/${markerOrder}/attempt-started`,
      markerBody,
      auth,
    )
    log('ATTEMPT_STARTED_FIRST_HTTP', markerFirst)
    assert(markerFirst.status === 200, `attempt-started first status ${markerFirst.status}`)
    assert((markerFirst.json as any)?.success === true, 'attempt-started first success=false')
    assert((markerFirst.json as any)?.recorded === true, 'attempt-started first recorded!=true')

    const markerSecond = await httpJson(
      'POST',
      `/api/terminal/orders/${markerOrder}/attempt-started`,
      markerBody,
      auth,
    )
    log('ATTEMPT_STARTED_SECOND_HTTP', markerSecond)
    assert(markerSecond.status === 200, `attempt-started second status ${markerSecond.status}`)
    assert((markerSecond.json as any)?.recorded === false, 'attempt-started retry should be idempotent')

    const { data: markerAudit } = await admin
      .from('audit_logs')
      .select('*')
      .eq('entity_id', markerOrder)
      .eq('action', 'payment.attempt_started')
    log('ATTEMPT_STARTED_AUDIT', markerAudit)
    assert((markerAudit?.length ?? 0) === 1, 'expected exactly one payment.attempt_started audit')
    console.log('ATTEMPT_STARTED_HTTP_IDEMPOTENT_OK')

    const stalePlacedAt = new Date(Date.now() - STALE_POS_TIMEOUT_MS - 5_000).toISOString()

    const cronAllocatedOnly = await insertOrder(
      'cron-allocated-only',
      `FTE04111A${Date.now()}`.slice(0, 32),
      stalePlacedAt,
    )
    const cronARes = await httpJson(
      'POST',
      '/api/terminal/orders/reconcile-stale',
      { __stagingFinaticStub: 'e04111' },
      auth,
    )
    log('CRON_ALLOCATED_ONLY_HTTP', cronARes)
    assert(cronARes.status === 200, `cron allocated-only status ${cronARes.status}`)
    const cronARow = await readOrder(cronAllocatedOnly)
    log('CRON_ALLOCATED_ONLY_DB', cronARow)
    assert(
      cronARow.status === 'cancelled' &&
        cronARow.payment_status === 'cancelled' &&
        cronARow.cancellation_reason === 'no_payment_attempt_made',
      `allocated-only row wrong: ${JSON.stringify(cronARow)}`,
    )
    console.log('CRON_E04111_ALLOCATED_ONLY_CANCELLED_OK')

    const startedBusinessOrderNo = `FTE04111B${Date.now()}`.slice(0, 32)
    const cronStarted = await insertOrder('cron-attempt-started', startedBusinessOrderNo, stalePlacedAt)
    const startedRes = await httpJson(
      'POST',
      `/api/terminal/orders/${cronStarted}/attempt-started`,
      {
        businessOrderNo: startedBusinessOrderNo,
        appVersion: 'probe-1.0.0',
        launchedAt: new Date().toISOString(),
      },
      auth,
    )
    log('CRON_ATTEMPT_STARTED_MARK_HTTP', startedRes)
    assert(startedRes.status === 200, `attempt-started before cron status ${startedRes.status}`)

    const cronBRes = await httpJson(
      'POST',
      '/api/terminal/orders/reconcile-stale',
      { __stagingFinaticStub: 'e04111' },
      auth,
    )
    log('CRON_ATTEMPT_STARTED_HTTP', cronBRes)
    assert(cronBRes.status === 200, `cron attempt-started status ${cronBRes.status}`)
    const cronBRow = await readOrder(cronStarted)
    log('CRON_ATTEMPT_STARTED_DB', cronBRow)
    assert(
      cronBRow.status === 'pending' && cronBRow.payment_status === 'pending',
      `attempt-started row wrong: ${JSON.stringify(cronBRow)}`,
    )
    assert(
      ((cronBRes.json as any)?.posSkippedUncertainIds ?? []).includes(cronStarted),
      `cron response missing skipped id ${cronStarted}: ${JSON.stringify(cronBRes.json)}`,
    )
    console.log('CRON_E04111_ATTEMPT_STARTED_LEFT_PENDING_OK')

    console.log('PROBE_ATTEMPT_STARTED_HTTP_STAGING_OK')
  } finally {
    if (createdOrderIds.length) {
      await admin.from('audit_logs').delete().in('entity_id', createdOrderIds)
      await admin.from('receipt_documents').delete().in('order_id', createdOrderIds)
      await admin.from('orders').delete().in('id', createdOrderIds)
    }
    await admin.from('restaurant_terminals').delete().eq('id', terminalId)
    await admin.from('restaurants').delete().eq('id', restaurantId)
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
