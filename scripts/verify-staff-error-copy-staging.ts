/**
 * Live staging verification for terminal staff error copy.
 * Triggers real AMOUNT_MISMATCH / ALREADY_PAID / PIN_LOCKED / AMOUNT_EXCEEDS
 * against VERIFY_APP_URL and asserts the mapped staff strings.
 *
 *   npx tsx scripts/verify-staff-error-copy-staging.ts
 *
 * Env: .env.test (staging SUPABASE_*) + TERMINAL_JWT_SECRET in .env.local
 */
import { createClient } from '@supabase/supabase-js'
import { config } from 'dotenv'
import { resolve } from 'path'
import { signTerminalJwt } from '../lib/terminals/terminal-jwt'
import { hashTerminalPin } from '../lib/terminal-auth/pin-credentials'
import { PIN_MAX_FAILED_ATTEMPTS } from '../lib/terminal-auth/pin-lockout'

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

const tag = `staff-copy-${Date.now()}`
const createdOrderIds: string[] = []
const createdEventIds: string[] = []

/** Mirrors FlashTapTerminal/src/lib/staffApiErrors.ts */
function formatNadAmount(amount: number): string {
  return `N$${amount.toFixed(2)}`
}

function staffMessageForPinLock(retryAfterSeconds: number | null | undefined): string {
  if (retryAfterSeconds != null && retryAfterSeconds > 0) {
    const minutes = Math.max(1, Math.ceil(retryAfterSeconds / 60))
    return `PIN locked -- try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`
  }
  return 'PIN locked after too many attempts. Try again later.'
}

function staffMessageForMarkPaid(code: string | undefined, expected: number | null): string {
  switch (code) {
    case 'ALREADY_PAID':
      return 'This order was already paid.'
    case 'PAYMENT_CLAIM_CONFLICT':
      return 'This payment could not be completed -- the order may already be paid. Refresh and check the order.'
    case 'AMOUNT_MISMATCH': {
      const base =
        'Payment amount does not match this order. Refresh the order and try again.'
      if (expected != null) return `${base} Expected ${formatNadAmount(expected)}.`
      return base
    }
    default:
      return 'Payment update failed'
  }
}

function staffMessageForSettle(code: string | undefined, error: string): string {
  if (code === 'SETTLE_CLAIM_CONFLICT') {
    return 'Some selected orders were already paid. Refresh the table and try again.'
  }
  return error
}

function staffMessageForRefund(code: string | undefined, error: string, remaining: number | null): string {
  const exceeds =
    code === 'AMOUNT_EXCEEDS_REMAINING' || /exceeds remaining/i.test(error)
  if (!exceeds) return error
  const lines = ["Refund amount is more than what's left on this sale."]
  if (remaining != null) {
    lines.push(`Only ${formatNadAmount(remaining)} can still be refunded.`)
  }
  return lines.join(' ')
}

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
  const auth = { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' }

  // --- AMOUNT_MISMATCH ---
  {
    const orderId = await createUnpaidOrder(25.0)
    const res = await fetch(`${APP}/api/terminal/orders/${orderId}/payment`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({
        status: 'success',
        reference: `${tag}-mm`,
        amount: 1.0,
        paymentMethod: 'cash',
      }),
    })
    const json = (await res.json().catch(() => ({}))) as {
      error?: string
      code?: string
      expected?: number
    }
    const shown = staffMessageForMarkPaid(json.code, json.expected ?? null)
    record(
      'amount-mismatch',
      res.status === 400 &&
        json.code === 'AMOUNT_MISMATCH' &&
        shown.includes('does not match') &&
        shown.includes('N$25.00'),
      `status=${res.status} code=${json.code} shown="${shown}"`,
    )
  }

  // --- ALREADY_PAID (double mark-paid) ---
  {
    const orderId = await createUnpaidOrder(18.0)
    const body = {
      status: 'success',
      reference: `${tag}-paid`,
      amount: 18.0,
      paymentMethod: 'cash',
    }
    const first = await fetch(`${APP}/api/terminal/orders/${orderId}/payment`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify(body),
    })
    if (!first.ok) {
      throw new Error(`first mark-paid failed: ${first.status} ${await first.text()}`)
    }
    const second = await fetch(`${APP}/api/terminal/orders/${orderId}/payment`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ ...body, reference: `${tag}-paid-2` }),
    })
    const json = (await second.json()) as { error?: string; code?: string }
    const shown = staffMessageForMarkPaid(json.code, null)
    record(
      'already-paid',
      second.status === 409 &&
        json.code === 'ALREADY_PAID' &&
        shown === 'This order was already paid.',
      `status=${second.status} code=${json.code} shown="${shown}"`,
    )
  }

  // --- PIN_LOCKED ---
  {
    const { data: member } = await admin
      .from('restaurant_users')
      .select('user_id')
      .eq('restaurant_id', RESTAURANT_ID)
      .is('deleted_at', null)
      .limit(1)
      .maybeSingle()
    if (!member?.user_id) throw new Error('No staff user for PIN test')
    const userId = String(member.user_id)
    const hashed = await hashTerminalPin('4242')
    await admin.from('terminal_authorization_credentials').upsert({
      user_id: userId,
      restaurant_id: RESTAURANT_ID,
      pin_hash: hashed.pinHash,
      pin_salt: hashed.pinSalt,
    })
    await admin
      .from('authorization_events')
      .delete()
      .eq('restaurant_id', RESTAURANT_ID)
      .eq('actor_user_id', userId)
      .eq('event_type', 'denied')
      .gte('created_at', new Date(Date.now() - 15 * 60 * 1000).toISOString())

    let lockedJson: {
      code?: string
      retry_after_seconds?: number
      error?: string
    } | null = null
    let lockedStatus = 0
    for (let i = 0; i < PIN_MAX_FAILED_ATTEMPTS + 2; i++) {
      const res = await fetch(`${APP}/api/terminal/authorize`, {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({
          user_id: userId,
          pin: '0000',
          purpose: 'refund',
        }),
      })
      const json = (await res.json()) as {
        code?: string
        retry_after_seconds?: number
        error?: string
      }
      if (res.status === 429 || json.code === 'PIN_LOCKED') {
        lockedStatus = res.status
        lockedJson = json
        break
      }
    }
    const shown = staffMessageForPinLock(lockedJson?.retry_after_seconds ?? null)
    record(
      'pin-locked',
      lockedStatus === 429 &&
        lockedJson?.code === 'PIN_LOCKED' &&
        shown.startsWith('PIN locked'),
      `status=${lockedStatus} code=${lockedJson?.code} retry=${lockedJson?.retry_after_seconds} shown="${shown}"`,
    )

    // Clear lockout denials so the refund over-limit test can authorize.
    await admin
      .from('authorization_events')
      .delete()
      .eq('restaurant_id', RESTAURANT_ID)
      .eq('actor_user_id', userId)
      .eq('event_type', 'denied')
      .gte('created_at', new Date(Date.now() - 15 * 60 * 1000).toISOString())
  }

  // --- AMOUNT_EXCEEDS_REMAINING via refund route ---
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

    const { data: member } = await admin
      .from('restaurant_users')
      .select('user_id')
      .eq('restaurant_id', RESTAURANT_ID)
      .is('deleted_at', null)
      .limit(1)
      .maybeSingle()
    if (!member?.user_id) throw new Error('No staff for refund auth')
    const userId = String(member.user_id)

    // Fresh credential + clear any prior PIN lockout denials
    const hashed = await hashTerminalPin('4242')
    await admin.from('terminal_authorization_credentials').upsert({
      user_id: userId,
      restaurant_id: RESTAURANT_ID,
      pin_hash: hashed.pinHash,
      pin_salt: hashed.pinSalt,
    })
    await admin
      .from('authorization_events')
      .delete()
      .eq('restaurant_id', RESTAURANT_ID)
      .eq('actor_user_id', userId)
      .eq('event_type', 'denied')
      .gte('created_at', new Date(Date.now() - 15 * 60 * 1000).toISOString())

    const authRes = await fetch(`${APP}/api/terminal/authorize`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({
        user_id: userId,
        pin: '4242',
        purpose: 'refund',
      }),
    })
    const authJson = (await authRes.json()) as { token_id?: string; error?: string }
    if (!authRes.ok || !authJson.token_id) {
      throw new Error(`authorize for refund failed: ${authRes.status} ${JSON.stringify(authJson)}`)
    }

    const refundRes = await fetch(`${APP}/api/terminal/payment-events/refund`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({
        token_id: authJson.token_id,
        user_id: userId,
        origin_business_order_no: saleKey,
        order_ids: [orderId],
        business_order_no: `${tag}-rf-over`,
        amount: 999,
        reason_code: 'customer_request',
        gateway_result: 'success',
      }),
    })
    const refundJson = (await refundRes.json()) as {
      error?: string
      code?: string
      remaining?: number
    }
    const shown = staffMessageForRefund(
      refundJson.code,
      refundJson.error || '',
      refundJson.remaining ?? null,
    )
    record(
      'refund-over-limit',
      refundRes.status === 400 &&
        shown.includes("more than what's left") &&
        (refundJson.remaining == null || shown.includes('N$')),
      `status=${refundRes.status} code=${refundJson.code} remaining=${refundJson.remaining} shown="${shown}"`,
    )
  }

  console.log('ALL STAFF-COPY CHECKS PASSED')
}

main()
  .catch((err) => {
    console.error(err)
    process.exitCode = 1
  })
  .finally(() => cleanup())
