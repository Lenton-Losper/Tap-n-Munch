/**
 * Staging verification: terminal payment integrity + PIN lockout + menu scope.
 *
 * Prerequisites:
 *  - record_terminal_refund_event applied on staging DB
 *  - Worker/API running the fixed routes (local next start OR staging Worker)
 *
 *   npx tsx scripts/verify-terminal-payment-integrity-staging.ts
 *
 * Env: .env.test (staging SUPABASE_*) + TERMINAL_JWT_SECRET in .env.local
 * VERIFY_APP_URL defaults to staging Worker.
 */
import { createClient } from '@supabase/supabase-js'
import { config } from 'dotenv'
import { resolve } from 'path'
import { signTerminalJwt } from '../lib/terminals/terminal-jwt'
import { hashTerminalPin } from '../lib/terminal-auth/pin-credentials'
import {
  PIN_MAX_FAILED_ATTEMPTS,
} from '../lib/terminal-auth/pin-lockout'

config({ path: resolve(__dirname, '../.env.test'), override: true })
config({ path: resolve(__dirname, '../.env.local'), override: false })

const APP =
  process.env.VERIFY_APP_URL ||
  'https://flashtap-staging.llosperofficial.workers.dev'
const STAGING_REF = 'mdqjpxwczrhkxkbqatqa'
const RESTAURANT_ID = 'a1999166-ddfa-40d1-ad1f-2f01282a1652'

const url = process.env.SUPABASE_URL || ''
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || ''

if (!url.includes(STAGING_REF) || !serviceKey) {
  throw new Error('Refusing: staging credentials missing (.env.test)')
}
if (!process.env.TERMINAL_JWT_SECRET) {
  throw new Error('TERMINAL_JWT_SECRET missing — set in .env.local')
}

const admin = createClient(url, serviceKey, {
  auth: { autoRefreshToken: false, persistSession: false },
})

const tag = `pay-integrity-${Date.now()}`
const createdOrderIds: string[] = []
const createdEventIds: string[] = []

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
    headers: {
      Authorization: `Bearer ${jwt}`,
      'Content-Type': 'application/json',
    },
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
    await admin.from('orders').delete().in('id', createdOrderIds)
  }
}

async function main() {
  console.log(`APP=${APP}`)
  const terminal = await getActiveTerminal()
  const jwt = await signTerminalJwt({
    terminal_id: terminal.id,
    restaurant_id: RESTAURANT_ID,
    device_serial: terminal.device_serial,
  })

  // ---------- Part 1: amount mismatch ----------
  {
    const orderId = await createUnpaidOrder(41.11)
    const bad = await postPayment(jwt, orderId, {
      status: 'success',
      reference: `${tag}-bad`,
      amount: 1.0,
      paymentMethod: 'cash',
    })
    record(
      'p1-amount-mismatch',
      bad.status === 400 && String(bad.json.code) === 'AMOUNT_MISMATCH',
      `status=${bad.status} code=${bad.json.code} body=${JSON.stringify(bad.json)}`,
    )
    const { data: still } = await admin
      .from('orders')
      .select('payment_status')
      .eq('id', orderId)
      .single()
    record(
      'p1-amount-mismatch-unpaid',
      String(still?.payment_status) === 'pending',
      `payment_status=${still?.payment_status}`,
    )
  }

  // ---------- Part 1: concurrent mark-paid ----------
  {
    const orderId = await createUnpaidOrder(25.0)
    const payload = {
      status: 'success',
      reference: `${tag}-race`,
      amount: 25.0,
      paymentMethod: 'cash',
    }
    const [a, b] = await Promise.all([
      postPayment(jwt, orderId, payload),
      postPayment(jwt, orderId, payload),
    ])
    const statuses = [a.status, b.status].sort()
    const successCount = [a, b].filter((r) => r.status === 200).length
    const conflictCount = [a, b].filter((r) => r.status === 409).length
    record(
      'p1-concurrent-one-success',
      successCount === 1 && conflictCount === 1,
      `statuses=${statuses.join(',')} success=${successCount} conflict=${conflictCount} a=${JSON.stringify(a.json)} b=${JSON.stringify(b.json)}`,
    )
    const { data: order } = await admin
      .from('orders')
      .select('payment_status')
      .eq('id', orderId)
      .single()
    record(
      'p1-concurrent-single-paid',
      String(order?.payment_status) === 'paid',
      `payment_status=${order?.payment_status}`,
    )
  }

  // ---------- Part 2: refund race via RPC ----------
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
        initiated_by: null,
      })
      .select('id')
      .single()
    if (saleErr || !sale?.id) throw saleErr ?? new Error('sale insert failed')
    createdEventIds.push(String(sale.id))

    const { data: staff } = await admin
      .from('restaurant_users')
      .select('user_id')
      .eq('restaurant_id', RESTAURANT_ID)
      .is('deleted_at', null)
      .limit(1)
      .maybeSingle()
    if (!staff?.user_id) throw new Error('No restaurant user for refund initiated_by')

    const refundA = `${tag}-rfA`
    const refundB = `${tag}-rfB`
    const args = (key: string) => ({
      p_restaurant_id: RESTAURANT_ID,
      p_order_ids: [orderId],
      p_event_type: 'refund_succeeded',
      p_business_order_no: key,
      p_origin_business_order_no: saleKey,
      p_transaction_id: null,
      p_terminal_id: terminal.id,
      p_amount: 40,
      p_currency: 'NAD',
      p_idempotency_key: key,
      p_initiated_by: staff.user_id,
      p_reason_code: 'customer_request',
      p_reason_note: 'integrity race',
      p_gateway_result_code: null,
      p_gateway_result_message: null,
    })

    const [r1, r2] = await Promise.all([
      admin.rpc('record_terminal_refund_event', args(refundA)),
      admin.rpc('record_terminal_refund_event', args(refundB)),
    ])

    const ok1 = !r1.error && r1.data
    const ok2 = !r2.error && r2.data
    const failExceeds =
      String(r1.error?.message ?? '').includes('AMOUNT_EXCEEDS_REMAINING') ||
      String(r2.error?.message ?? '').includes('AMOUNT_EXCEEDS_REMAINING')
    record(
      'p2-refund-race',
      (ok1 ? 1 : 0) + (ok2 ? 1 : 0) === 1 && failExceeds,
      `ok1=${!!ok1} ok2=${!!ok2} e1=${r1.error?.message ?? ''} e2=${r2.error?.message ?? ''}`,
    )

    if (ok1 && r1.data?.id) createdEventIds.push(String(r1.data.id))
    if (ok2 && r2.data?.id) createdEventIds.push(String(r2.data.id))

    const { data: refunds } = await admin
      .from('payment_events')
      .select('id, amount')
      .eq('restaurant_id', RESTAURANT_ID)
      .eq('event_type', 'refund_succeeded')
      .eq('origin_business_order_no', saleKey)
    const sum = (refunds ?? []).reduce((s, row) => s + Number(row.amount), 0)
    for (const row of refunds ?? []) createdEventIds.push(String(row.id))
    record('p2-refund-sum-le-sale', sum <= 50.01, `refunded_sum=${sum}`)
  }

  // ---------- Part 3: PIN lockout ----------
  {
    const { data: cred } = await admin
      .from('terminal_authorization_credentials')
      .select('user_id')
      .eq('restaurant_id', RESTAURANT_ID)
      .limit(1)
      .maybeSingle()

    let userId = cred?.user_id ? String(cred.user_id) : ''
    if (!userId) {
      const { data: member } = await admin
        .from('restaurant_users')
        .select('user_id')
        .eq('restaurant_id', RESTAURANT_ID)
        .is('deleted_at', null)
        .limit(1)
        .maybeSingle()
      if (!member?.user_id) throw new Error('No staff user for PIN test')
      userId = String(member.user_id)
      const hashed = await hashTerminalPin('4242')
      await admin.from('terminal_authorization_credentials').upsert({
        user_id: userId,
        restaurant_id: RESTAURANT_ID,
        pin_hash: hashed.pinHash,
        pin_salt: hashed.pinSalt,
      })
    }

    // Clear recent denials for a clean window (best-effort).
    await admin
      .from('authorization_events')
      .delete()
      .eq('restaurant_id', RESTAURANT_ID)
      .eq('actor_user_id', userId)
      .eq('event_type', 'denied')
      .gte('created_at', new Date(Date.now() - 11 * 60 * 1000).toISOString())

    async function authorizePin(pin: string) {
      const res = await fetch(`${APP}/api/terminal/authorize`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${jwt}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ user_id: userId, pin, purpose: 'refund' }),
      })
      const json = (await res.json().catch(() => ({}))) as Record<string, unknown>
      return { status: res.status, json }
    }

    // Wrong PIN short of lockout still 401
    const first = await authorizePin('0000')
    record(
      'p3-wrong-pin-before-lock',
      first.status === 401,
      `status=${first.status} code=${first.json.code}`,
    )

    let locked = false
    for (let i = 0; i < PIN_MAX_FAILED_ATTEMPTS + 2; i++) {
      const r = await authorizePin('0000')
      if (r.status === 429 || r.json.code === 'PIN_LOCKED') {
        locked = true
        record(
          'p3-pin-lockout',
          true,
          `locked after attempt loop i=${i} status=${r.status}`,
        )
        break
      }
    }
    if (!locked) {
      record('p3-pin-lockout', false, 'never received PIN_LOCKED / 429')
    }
  }

  // ---------- Part 4: menu category ownership ----------
  {
    const fakeCategory = '00000000-0000-4000-8000-000000000099'
    const res = await fetch(
      `${APP}/api/menu/${RESTAURANT_ID}/category/${fakeCategory}`,
    )
    record(
      'p4-menu-wrong-category-404',
      res.status === 404,
      `status=${res.status}`,
    )

    const { data: realCat } = await admin
      .from('menu_categories')
      .select('id')
      .eq('restaurant_id', RESTAURANT_ID)
      .limit(1)
      .maybeSingle()
    if (realCat?.id) {
      const ok = await fetch(
        `${APP}/api/menu/${RESTAURANT_ID}/category/${realCat.id}`,
      )
      record(
        'p4-menu-real-category-ok',
        ok.status === 200,
        `status=${ok.status}`,
      )
    } else {
      console.log('SKIP [p4-menu-real-category-ok] no categories on staging fixture')
    }
  }

  await cleanup()
  console.log('VERIFY_TERMINAL_PAYMENT_INTEGRITY_STAGING_OK')
}

main().catch(async (err) => {
  console.error(err)
  await cleanup().catch(() => {})
  process.exit(1)
})
