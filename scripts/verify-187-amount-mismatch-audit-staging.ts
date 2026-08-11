/**
 * #187 — staging verification that the payment route REACHES recordPaymentAmountMismatch.
 *
 *   npx tsx scripts/verify-187-amount-mismatch-audit-staging.ts
 *
 * WHAT THIS PROVES, AND WHY IT NEEDS A SCRIPT.
 * __tests__/payment-amount-mismatch-audit.test.ts already proves the recorder writes the right
 * row and never throws. What it CANNOT prove is that the route actually calls it: no suite can
 * load app/api/terminal/orders/[orderId]/payment/route.ts, because it imports @/lib/terminal-auth
 * -> `jose`, which ships only ESM and dies under ts-jest. So the wiring was typechecked and read
 * but never exercised. This runs the real route in-process, against staging, with a real
 * terminal JWT.
 *
 * TWO-SIDED BY CONSTRUCTION. A run that only showed the mismatch row could not distinguish
 * "wired to the mismatch branch" from "writes on every call". So:
 *   CASE A  amount != order total  -> expect 400 AMOUNT_MISMATCH and EXACTLY ONE audit row
 *   CASE B  amount == order total  -> expect success and ZERO audit rows
 * Case B is the load-bearing one.
 *
 * ENV ORDER IS LOAD-BEARING. .env.test carries the STAGING Supabase URL; .env.local carries
 * TERMINAL_JWT_SECRET (which .env.test does not have) and ALSO a PRODUCTION Supabase URL. So
 * .env.test is loaded FIRST at override:true, and .env.local SECOND at override:false, which
 * adds the missing secret without letting the production URL win. Reverse the order, or pass
 * override:true to the second call, and this script points at production.
 *
 * The ref guards below are the backstop for exactly that, and they run BEFORE any client is
 * constructed, so a misconfigured env cannot open a connection at all.
 */
import { resolve } from 'path'
import { createClient } from '@supabase/supabase-js'
import { config } from 'dotenv'

// Order matters -- see the header. Staging first and authoritative, then local for secrets only.
config({ path: resolve(__dirname, '../.env.test'), override: true })
config({ path: resolve(__dirname, '../.env.local'), override: false })

const STAGING_REF = 'mdqjpxwczrhkxkbqatqa'
const PRODUCTION_REF = 'ihlmmpmolnpchzgwyhgh'

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || ''
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || ''

if (SUPABASE_URL.includes(PRODUCTION_REF)) {
  throw new Error(`REFUSING: URL points at PRODUCTION (${PRODUCTION_REF}).`)
}
if (!SUPABASE_URL.includes(STAGING_REF)) {
  throw new Error(`REFUSING: URL is not the staging ref (${STAGING_REF}). Got: ${SUPABASE_URL}`)
}
if (!SERVICE_KEY) throw new Error('REFUSING: no service role key')
if (!process.env.TERMINAL_JWT_SECRET) {
  throw new Error('REFUSING: TERMINAL_JWT_SECRET missing — .env.local was not loaded')
}

// The route builds its own client from these, so pin them to the staging values that survived
// the override:false load above.
process.env.NEXT_PUBLIC_SUPABASE_URL = SUPABASE_URL
process.env.SUPABASE_URL = SUPABASE_URL
process.env.SUPABASE_SERVICE_ROLE_KEY = SERVICE_KEY

const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
})

const ORDER_TOTAL = 120
const created = { orderIds: [] as string[] }

function log(msg: string) {
  console.log(`[${new Date().toISOString()}] ${msg}`)
}

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(`FAILED: ${message}`)
  log(`OK: ${message}`)
}

/** audit_logs rows this run's order produced, newest first. */
async function mismatchRowsFor(orderId: string) {
  const { data, error } = await admin
    .from('audit_logs')
    .select('id, action, entity_id, metadata, created_at')
    .eq('entity_type', 'order')
    .eq('entity_id', orderId)
    .eq('action', 'payment.amount_mismatch')
    .order('created_at', { ascending: false })
  if (error) throw error
  return data ?? []
}

async function createPendingOrder(tag: string): Promise<string> {
  const { data, error } = await admin
    .from('orders')
    .insert({
      restaurant_id: RESTAURANT_ID,
      order_number: 987_000 + (Date.now() % 10_000),
      table_number: 99,
      status: 'accepted',
      payment_status: 'unpaid',
      total: ORDER_TOTAL,
      items: [{ name: tag, quantity: 1, price: ORDER_TOTAL }],
    })
    .select('id')
    .single()
  if (error || !data) throw error || new Error('order insert failed')
  created.orderIds.push(data.id)
  return data.id
}

async function callPaymentRoute(
  orderId: string,
  token: string,
  amount: number,
): Promise<{ status: number; body: any }> {
  // The real route, imported in-process. tsx resolves the @/* tsconfig alias and handles the
  // ESM `jose` import that stops jest loading this same module.
  const { POST } = await import('@/app/api/terminal/orders/[orderId]/payment/route')
  const req = new Request(`http://localhost/api/terminal/orders/${orderId}/payment`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      status: 'success',
      amount,
      reference: `verify187-${Date.now()}`,
      voucherNo: `V${Date.now()}`,
      paymentMethod: 'card',
    }),
  })
  const res = await POST(req, { params: Promise.resolve({ orderId }) })
  return { status: res.status, body: await res.json().catch(() => null) }
}

let RESTAURANT_ID = ''

async function main() {
  console.log(`=== #187 route-wiring verification — STAGING ${STAGING_REF} ===\n`)

  const { data: terminal, error: terminalError } = await admin
    .from('restaurant_terminals')
    .select('id, restaurant_id, device_serial, status')
    .eq('status', 'active')
    .limit(1)
    .single()
  if (terminalError || !terminal) throw terminalError || new Error('no active terminal on staging')
  RESTAURANT_ID = terminal.restaurant_id
  log(`using terminal ${terminal.id} on restaurant ${RESTAURANT_ID}`)

  const { signTerminalJwt } = await import('@/lib/terminals/terminal-jwt')
  const token = await signTerminalJwt({
    terminal_id: terminal.id,
    restaurant_id: terminal.restaurant_id,
    device_serial: terminal.device_serial,
  })

  // ---- CASE A: amount does NOT match. The card would already have been charged here.
  console.log('\n--- CASE A: mismatched amount ---')
  const orderA = await createPendingOrder('verify187-mismatch')
  log(`order ${orderA} total ${ORDER_TOTAL}`)

  assert((await mismatchRowsFor(orderA)).length === 0, 'no audit row exists before the call')

  const resA = await callPaymentRoute(orderA, token, ORDER_TOTAL + 5)
  log(`route answered ${resA.status} ${JSON.stringify(resA.body)}`)
  assert(resA.status === 400, 'mismatch is refused with 400')
  assert(resA.body?.code === 'AMOUNT_MISMATCH', 'refusal carries code AMOUNT_MISMATCH')

  const rowsA = await mismatchRowsFor(orderA)
  assert(rowsA.length === 1, `exactly ONE payment.amount_mismatch row was written (got ${rowsA.length})`)
  const meta = rowsA[0]?.metadata as Record<string, unknown>
  assert(meta?.expectedAmount === ORDER_TOTAL, `row carries expectedAmount ${ORDER_TOTAL}`)
  assert(meta?.receivedAmount === ORDER_TOTAL + 5, `row carries receivedAmount ${ORDER_TOTAL + 5}`)
  assert(meta?.source === 'terminal_callback', 'row names source terminal_callback')
  assert(meta?.outcome === 'refused_left_pending', 'row names outcome refused_left_pending')
  log(`audit_logs row id: ${rowsA[0].id}`)

  const { data: orderAfterA } = await admin
    .from('orders')
    .select('payment_status, status')
    .eq('id', orderA)
    .single()
  assert(
    orderAfterA?.payment_status === 'unpaid',
    'the order is still unpaid — recording changed no money',
  )

  // ---- CASE B: amount matches. The branch must NOT be reached.
  console.log('\n--- CASE B: matching amount (the two-sided half) ---')
  const orderB = await createPendingOrder('verify187-match')
  log(`order ${orderB} total ${ORDER_TOTAL}`)

  const resB = await callPaymentRoute(orderB, token, ORDER_TOTAL)
  log(`route answered ${resB.status} ${JSON.stringify(resB.body)}`)
  assert(resB.status === 200, 'matching amount is accepted')

  const rowsB = await mismatchRowsFor(orderB)
  assert(
    rowsB.length === 0,
    `NO payment.amount_mismatch row for a matching amount (got ${rowsB.length}) — this is what ` +
      'distinguishes "wired to the mismatch branch" from "writes on every call"',
  )

  console.log('\n=== ALL ASSERTIONS PASSED ===')
  console.log('audit_logs rows created by this run:')
  console.log(`  ${rowsA[0].id}  (order ${orderA})`)
  console.log('orders created by this run:')
  for (const id of created.orderIds) console.log(`  ${id}`)
  console.log('\nNOT cleaned up — left for the orchestrator to decide, per instruction.')
}

main().catch((e) => {
  console.error('verification failed:', e)
  console.error('orders created before failure:', created.orderIds)
  process.exit(1)
})
