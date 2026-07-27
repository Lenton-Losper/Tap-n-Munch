/**
 * Production verification: terminal payment integrity + PIN lockout + menu scope.
 * Same 5 checks as verify-terminal-payment-integrity-staging.ts, run against the
 * real deployed production Worker with a fully disposable restaurant/terminal/staff
 * fixture created and torn down by this script.
 *
 *   npx tsx scripts/verify-terminal-payment-integrity-production.ts
 *
 * Env: .env.local (production SUPABASE_* + TERMINAL_JWT_SECRET)
 */
import { createClient } from '@supabase/supabase-js'
import { config } from 'dotenv'
import { resolve } from 'path'
import crypto from 'crypto'
import { signTerminalJwt } from '../lib/terminals/terminal-jwt'
import { hashTerminalPin } from '../lib/terminal-auth/pin-credentials'
import { PIN_MAX_FAILED_ATTEMPTS } from '../lib/terminal-auth/pin-lockout'

config({ path: resolve(__dirname, '../.env.local'), override: true })

const APP = process.env.VERIFY_APP_URL || 'https://flashtap.app'
const PRODUCTION_REF = 'ihlmmpmolnpchzgwyhgh'

const url = process.env.NEXT_PUBLIC_SUPABASE_URL || ''
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || ''

if (!url.includes(PRODUCTION_REF) || !serviceKey) {
  throw new Error('Refusing: production credentials missing (.env.local)')
}
if (!process.env.TERMINAL_JWT_SECRET) {
  throw new Error('TERMINAL_JWT_SECRET missing — set in .env.local')
}

const admin = createClient(url, serviceKey, {
  auth: { autoRefreshToken: false, persistSession: false },
})

const tag = `prod-verify-${Date.now()}`
const RESTAURANT_ID = crypto.randomUUID()
const USER_ID = crypto.randomUUID()
const createdOrderIds: string[] = []
const createdEventIds: string[] = []
let categoryId = ''
let terminalId = ''

function record(id: string, pass: boolean, detail: string) {
  console.log(`${pass ? 'PASS' : 'FAIL'} [${id}] ${detail}`)
  if (!pass) throw new Error(`Failed: ${id}`)
}

async function setupFixture(): Promise<{ id: string; device_serial: string }> {
  const { error: rErr } = await admin.from('restaurants').insert({
    id: RESTAURANT_ID,
    name: tag,
    is_active: true,
    deleted_at: null,
    currency: 'NAD',
  })
  if (rErr) throw rErr

  const { error: uErr } = await admin.from('users').insert({
    id: USER_ID,
    email: `${tag}@example.invalid`,
    full_name: 'Prod Verify Staff',
  })
  if (uErr) throw uErr

  const { error: roleErr } = await admin.from('restaurant_roles').insert({
    restaurant_id: RESTAURANT_ID,
    role_slug: 'owner',
    display_name: 'Owner',
    permissions: ['payments:refund', 'terminal:auth:manage'],
    is_system: true,
  })
  if (roleErr) throw roleErr

  const { error: ruErr } = await admin.from('restaurant_users').insert({
    restaurant_id: RESTAURANT_ID,
    user_id: USER_ID,
    role: 'owner',
  })
  if (ruErr) throw ruErr

  const deviceSerial = `${tag}-device`
  const { data: terminal, error: tErr } = await admin
    .from('restaurant_terminals')
    .insert({
      restaurant_id: RESTAURANT_ID,
      device_serial: deviceSerial,
      sn: deviceSerial,
      name: tag,
      active: true,
      status: 'active',
    })
    .select('id')
    .single()
  if (tErr || !terminal?.id) throw tErr ?? new Error('terminal insert failed')
  terminalId = String(terminal.id)

  const { data: cat, error: cErr } = await admin
    .from('menu_categories')
    .insert({ restaurant_id: RESTAURANT_ID, name: tag, active: true })
    .select('id')
    .single()
  if (cErr || !cat?.id) throw cErr ?? new Error('category insert failed')
  categoryId = String(cat.id)

  const hashed = await hashTerminalPin('4242')
  const { error: credErr } = await admin.from('terminal_authorization_credentials').upsert({
    user_id: USER_ID,
    restaurant_id: RESTAURANT_ID,
    pin_hash: hashed.pinHash,
    pin_salt: hashed.pinSalt,
  })
  if (credErr) throw credErr

  return { id: terminalId, device_serial: deviceSerial }
}

async function createUnpaidOrder(total: number): Promise<string> {
  const { data, error } = await admin
    .from('orders')
    .insert({
      restaurant_id: RESTAURANT_ID,
      table_number: 0,
      status: 'pending',
      payment_status: 'pending',
      payment_method: null,
      subtotal: total,
      total,
      items: [{ name: tag, quantity: 1, unit_price: total, total_price: total }],
      placed_at: new Date().toISOString(),
    })
    .select('id')
    .single()
  if (error || !data?.id) throw error ?? new Error('order insert failed')
  createdOrderIds.push(String(data.id))
  return String(data.id)
}

async function postPayment(
  jwt: string,
  orderId: string,
  body: Record<string, unknown>,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${APP}/api/terminal/orders/${orderId}/payment`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>
  return { status: res.status, json }
}

async function cleanup() {
  if (createdEventIds.length) {
    await admin.from('payment_events').delete().in('id', createdEventIds)
  }
  if (createdOrderIds.length) {
    // Mark-paid issues a receipt (receipt_documents FK → orders) — must go first.
    await admin.from('receipt_documents').delete().in('order_id', createdOrderIds)
    await admin.from('orders').delete().in('id', createdOrderIds)
  }
  await admin.from('authorization_events').delete().eq('restaurant_id', RESTAURANT_ID)
  await admin.from('terminal_authorization_credentials').delete().eq('restaurant_id', RESTAURANT_ID)
  if (categoryId) await admin.from('menu_categories').delete().eq('id', categoryId)
  if (terminalId) await admin.from('restaurant_terminals').delete().eq('id', terminalId)
  await admin.from('restaurant_users').delete().eq('restaurant_id', RESTAURANT_ID)
  await admin.from('restaurant_roles').delete().eq('restaurant_id', RESTAURANT_ID)
  await admin.from('restaurants').delete().eq('id', RESTAURANT_ID)
  await admin.from('users').delete().eq('id', USER_ID)
}

async function main() {
  console.log(`APP=${APP}`)
  console.log(`RESTAURANT_ID=${RESTAURANT_ID} (disposable)`)
  const terminal = await setupFixture()
  const jwt = await signTerminalJwt({
    terminal_id: terminal.id,
    restaurant_id: RESTAURANT_ID,
    device_serial: terminal.device_serial,
  })

  // ---------- 1: amount mismatch ----------
  {
    const orderId = await createUnpaidOrder(41.11)
    const bad = await postPayment(jwt, orderId, {
      status: 'success',
      reference: `${tag}-bad`,
      amount: 1.0,
      paymentMethod: 'cash',
    })
    record(
      '1-amount-mismatch',
      bad.status === 400 && String(bad.json.code) === 'AMOUNT_MISMATCH',
      `status=${bad.status} code=${bad.json.code} body=${JSON.stringify(bad.json)}`,
    )
    const { data: still } = await admin.from('orders').select('payment_status').eq('id', orderId).single()
    record('1-amount-mismatch-unpaid', String(still?.payment_status) === 'pending', `payment_status=${still?.payment_status}`)
  }

  // ---------- 2: double mark-paid ----------
  {
    const orderId = await createUnpaidOrder(18.0)
    const payload = { status: 'success', reference: `${tag}-paid`, amount: 18.0, paymentMethod: 'cash' }
    const first = await postPayment(jwt, orderId, payload)
    record('2-first-mark-paid-ok', first.status === 200, `status=${first.status} body=${JSON.stringify(first.json)}`)
    const second = await postPayment(jwt, orderId, { ...payload, reference: `${tag}-paid-2` })
    record(
      '2-double-mark-paid-rejected',
      second.status === 409 && String(second.json.code) === 'ALREADY_PAID',
      `status=${second.status} code=${second.json.code} body=${JSON.stringify(second.json)}`,
    )
  }

  // ---------- 3: refund over remaining balance ----------
  {
    const orderId = await createUnpaidOrder(50.0)
    const saleKey = `${tag}-sale`
    const { data: sale, error: saleErr } = await admin
      .from('payment_events')
      .insert({
        restaurant_id: RESTAURANT_ID,
        order_ids: [orderId],
        event_type: 'sale',
        business_order_no: saleKey,
        origin_business_order_no: saleKey,
        amount: 50,
        currency: 'NAD',
        idempotency_key: saleKey,
        reason_code: 'sale',
        initiated_by: USER_ID,
      })
      .select('id')
      .single()
    if (saleErr || !sale?.id) throw saleErr ?? new Error('sale insert failed')
    createdEventIds.push(String(sale.id))

    const { data: overRefund, error: overErr } = await admin.rpc('record_terminal_refund_event', {
      p_restaurant_id: RESTAURANT_ID,
      p_order_ids: [orderId],
      p_event_type: 'refund_succeeded',
      p_business_order_no: `${tag}-rf-over`,
      p_origin_business_order_no: saleKey,
      p_transaction_id: null,
      p_terminal_id: terminal.id,
      p_amount: 999,
      p_currency: 'NAD',
      p_idempotency_key: `${tag}-rf-over`,
      p_initiated_by: USER_ID,
      p_reason_code: 'customer_request',
      p_reason_note: 'prod verify over-limit',
      p_gateway_result_code: null,
      p_gateway_result_message: null,
    })
    record(
      '3-refund-over-limit-rejected',
      !overRefund && String(overErr?.message ?? '').includes('AMOUNT_EXCEEDS_REMAINING'),
      `error=${overErr?.message ?? 'none'}`,
    )

    const { data: validRefund, error: validErr } = await admin.rpc('record_terminal_refund_event', {
      p_restaurant_id: RESTAURANT_ID,
      p_order_ids: [orderId],
      p_event_type: 'refund_succeeded',
      p_business_order_no: `${tag}-rf-ok`,
      p_origin_business_order_no: saleKey,
      p_transaction_id: null,
      p_terminal_id: terminal.id,
      p_amount: 40,
      p_currency: 'NAD',
      p_idempotency_key: `${tag}-rf-ok`,
      p_initiated_by: USER_ID,
      p_reason_code: 'customer_request',
      p_reason_note: 'prod verify within-limit',
      p_gateway_result_code: null,
      p_gateway_result_message: null,
    })
    record('3-refund-within-limit-succeeds', !validErr && Boolean(validRefund?.id), `error=${validErr?.message ?? 'none'}`)
    if (validRefund?.id) createdEventIds.push(String(validRefund.id))
  }

  // ---------- 4: PIN lockout ----------
  {
    async function authorizePin(pin: string) {
      const res = await fetch(`${APP}/api/terminal/authorize`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_id: USER_ID, pin, purpose: 'refund' }),
      })
      const json = (await res.json().catch(() => ({}))) as Record<string, unknown>
      return { status: res.status, json }
    }

    const first = await authorizePin('0000')
    record('4-wrong-pin-before-lock', first.status === 401, `status=${first.status} code=${first.json.code}`)

    let locked = false
    for (let i = 0; i < PIN_MAX_FAILED_ATTEMPTS + 2; i++) {
      const r = await authorizePin('0000')
      if (r.status === 429 || r.json.code === 'PIN_LOCKED') {
        locked = true
        record('4-pin-lockout', true, `locked after attempt i=${i} status=${r.status} body=${JSON.stringify(r.json)}`)
        break
      }
    }
    if (!locked) record('4-pin-lockout', false, 'never received PIN_LOCKED / 429')
  }

  // ---------- 5: menu category ownership ----------
  {
    const fakeCategory = crypto.randomUUID()
    const wrong = await fetch(`${APP}/api/menu/${RESTAURANT_ID}/category/${fakeCategory}`)
    record('5-menu-cross-restaurant-rejected', wrong.status === 404, `status=${wrong.status}`)

    const ok = await fetch(`${APP}/api/menu/${RESTAURANT_ID}/category/${categoryId}`)
    record('5-menu-same-restaurant-ok', ok.status === 200, `status=${ok.status}`)
  }

  await cleanup()
  console.log('VERIFY_TERMINAL_PAYMENT_INTEGRITY_PRODUCTION_OK')
}

main()
  .catch(async (err) => {
    console.error(err)
    await cleanup().catch(() => {})
    process.exitCode = 1
  })
