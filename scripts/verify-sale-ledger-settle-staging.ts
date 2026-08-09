/**
 * Staging verification: the settle route writes the SALE ledger row (#156).
 *
 *   npx tsx scripts/verify-sale-ledger-settle-staging.ts
 *
 * Env: .env.test (staging SUPABASE_*) + TERMINAL_JWT_SECRET from .env.local.
 * Only the JWT secret is read from .env.local -- its Supabase URL points at PRODUCTION and is
 * deliberately never used; .env.test is loaded with override:true first, and the staging ref
 * is asserted before anything is touched.
 *
 * What this proves that jest cannot. The unit suites run against a fake; this runs the REAL
 * settle route in-process against the REAL staging database, so the real NOT NULLs, the real
 * event_type CHECK and the real UNIQUE (restaurant_id, idempotency_key) all apply. The route
 * is invoked in-process rather than over HTTP to the staging Worker because this branch is not
 * deployed there -- hitting the Worker would verify the old build, which is the opposite of
 * the point.
 *
 * Every count is taken BEFORE and AFTER. A count of 1 after a card settle means nothing
 * against an unknown starting count; only the transition 0 -> 1 does.
 *
 * Marker on success: VERIFY_SALE_LEDGER_SETTLE_OK
 */
import { createClient } from '@supabase/supabase-js'
import { config } from 'dotenv'
import { resolve } from 'path'
import { signTerminalJwt } from '../lib/terminals/terminal-jwt'

config({ path: resolve(__dirname, '../.env.test'), override: true })
// override:false -- must NOT let .env.local's production Supabase URL win.
config({ path: resolve(__dirname, '../.env.local'), override: false })

const STAGING_REF = 'mdqjpxwczrhkxkbqatqa'
const PRODUCTION_REF = 'ihlmmpmolnpchzgwyhgh'

const url = process.env.SUPABASE_URL || ''
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || ''

if (url.includes(PRODUCTION_REF)) throw new Error('REFUSING: that is PRODUCTION')
if (!url.includes(STAGING_REF)) throw new Error(`REFUSING: ${url} is not staging`)
if (!serviceKey) throw new Error('Missing staging service role key (.env.test)')
if (!process.env.TERMINAL_JWT_SECRET) {
  throw new Error('TERMINAL_JWT_SECRET missing — set in .env.local')
}

// The route builds its own client from these, so both names are pinned to staging.
process.env.NEXT_PUBLIC_SUPABASE_URL = url
process.env.SUPABASE_URL = url

const admin = createClient(url, serviceKey, {
  auth: { autoRefreshToken: false, persistSession: false },
})

const TAG = `verify156-${Date.now()}`
let failures = 0

function record(id: string, pass: boolean, detail: string) {
  console.log(`${pass ? 'PASS' : 'FAIL'} [${id}] ${detail}`)
  if (!pass) failures++
}

const createdOrderIds: string[] = []
const createdTabIds: string[] = []
const createdPaymentEventIds: string[] = []
let restaurantId = ''
let terminalId = ''
let token = ''

async function main() {
  const { POST: settlePost } = await import('@/app/api/terminal/tabs/[tabId]/settle/route')
  const { POST: salePost } = await import('@/app/api/terminal/payment-events/sale/route')

  console.log(`staging: ${url}\n`)

  // An existing active terminal, so validateTerminalRecord runs against a real row.
  const { data: terminal, error: termErr } = await admin
    .from('restaurant_terminals')
    .select('id, restaurant_id, device_serial')
    .eq('active', true)
    .eq('status', 'active')
    .not('device_serial', 'is', null)
    .limit(1)
    .maybeSingle()
  if (termErr || !terminal?.id) throw new Error('no active terminal with a device_serial on staging')
  terminalId = String(terminal.id)
  restaurantId = String(terminal.restaurant_id)

  const { data: restaurant } = await admin
    .from('restaurants')
    .select('name')
    .eq('id', restaurantId)
    .maybeSingle()
  console.log(`restaurant: ${restaurant?.name ?? '?'} (${restaurantId})`)
  console.log(`terminal:   ${terminalId}\n`)

  token = await signTerminalJwt({
    terminal_id: terminalId,
    restaurant_id: restaurantId,
    device_serial: String(terminal.device_serial),
  })

  // idx_tabs_one_open_per_table allows a single open tab per table, and every tab this script
  // opens stays open until cleanup -- so each needs its own table number. Well outside any
  // real venue's range so a live table is never touched.
  let nextTableNumber = 9100 + Math.floor(Math.random() * 400)

  const makeTab = async () => {
    const tableNumber = nextTableNumber++
    const { data, error } = await admin
      .from('tabs')
      .insert({ restaurant_id: restaurantId, table_number: tableNumber, status: 'open', total: 0 })
      .select('id')
      .single()
    if (error) throw new Error(`tab insert failed: ${error.message}`)
    createdTabIds.push(String(data.id))
    return String(data.id)
  }

  const makeOrder = async (tabId: string, total: number) => {
    const { data, error } = await admin
      .from('orders')
      .insert({
        restaurant_id: restaurantId,
        tab_id: tabId,
        table_number: 0,
        channel: 'pos',
        status: 'pending',
        payment_status: 'pending',
        total,
      })
      .select('id')
      .single()
    if (error) throw new Error(`order insert failed: ${error.message}`)
    createdOrderIds.push(String(data.id))
    return String(data.id)
  }

  /** SALE rows linked to this order, via the real order_ids uuid[] containment. */
  const saleRowsFor = async (orderId: string) => {
    const { data, error } = await admin
      .from('payment_events')
      .select('id, event_type, amount, order_ids, business_order_no, reason_code, initiated_by, transaction_id, terminal_id')
      .eq('restaurant_id', restaurantId)
      .eq('event_type', 'sale')
      .contains('order_ids', [orderId])
    if (error) throw new Error(`payment_events read failed: ${error.message}`)
    for (const r of data ?? []) {
      if (!createdPaymentEventIds.includes(String(r.id))) createdPaymentEventIds.push(String(r.id))
    }
    return data ?? []
  }

  const settle = async (tabId: string, body: Record<string, unknown>) => {
    const res = await settlePost(
      new Request(`https://staging.local/api/terminal/tabs/${tabId}/settle`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      }),
      { params: Promise.resolve({ tabId }) },
    )
    return { status: res.status, json: await res.json() }
  }

  // ------------------------------------------------------------------ CASH
  console.log('=== C1  real CASH settle: 0 SALE rows before, 0 after ===')
  {
    const tabId = await makeTab()
    const orderId = await makeOrder(tabId, 31.5)

    const before = (await saleRowsFor(orderId)).length
    console.log(`  SALE rows BEFORE: ${before}`)

    const { status, json } = await settle(tabId, {
      order_ids: [orderId],
      amount: 31.5,
      method: 'cash',
    })
    console.log(`  settle -> ${status} ${JSON.stringify(json)}`)

    const after = (await saleRowsFor(orderId)).length
    console.log(`  SALE rows AFTER:  ${after}   (delta ${after - before})`)

    const { data: order } = await admin
      .from('orders')
      .select('payment_status, payment_method')
      .eq('id', orderId)
      .single()

    record('C1.1', status === 200 && json.success === true, `cash settle succeeded (${status})`)
    record('C1.2', order?.payment_status === 'paid', `order is paid (${order?.payment_status})`)
    record('C1.3', order?.payment_method === 'cash', `method is cash (${order?.payment_method})`)
    record('C1.4', before === 0, `0 SALE rows before (${before})`)
    record('C1.5', after === 0, `0 SALE rows after — cash wrote nothing (${after})`)
    record('C1.6', json.sale_ledger_outcome === 'skipped_cash', `outcome skipped_cash (${json.sale_ledger_outcome})`)
  }

  // ------------------------------------------------------------------ CARD
  console.log('\n=== C2  real CARD settle: 0 SALE rows before, exactly 1 after ===')
  const businessOrderNo = `FT${TAG}`
  let cardOrderId = ''
  {
    const tabId = await makeTab()
    cardOrderId = await makeOrder(tabId, 47.25)

    const before = (await saleRowsFor(cardOrderId)).length
    console.log(`  SALE rows BEFORE: ${before}`)

    const { status, json } = await settle(tabId, {
      order_ids: [cardOrderId],
      amount: 47.25,
      method: 'card',
      business_order_no: businessOrderNo,
      voucher_no: businessOrderNo,
    })
    console.log(`  settle -> ${status} ${JSON.stringify(json)}`)

    const rows = await saleRowsFor(cardOrderId)
    console.log(`  SALE rows AFTER:  ${rows.length}   (delta ${rows.length - before})`)
    console.log(`  row: ${JSON.stringify(rows[0])}`)

    record('C2.1', status === 200 && json.success === true, `card settle succeeded (${status})`)
    record('C2.2', before === 0, `0 SALE rows before (${before})`)
    record('C2.3', rows.length === 1, `EXACTLY 1 SALE row after (${rows.length})`)
    record('C2.4', Number(rows[0]?.amount) === 47.25, `amount is the server total (${rows[0]?.amount})`)
    record('C2.5', rows[0]?.event_type === 'sale', `event_type is sale (${rows[0]?.event_type})`)
    record('C2.6', rows[0]?.reason_code === 'settle_card', `reason_code is settle_card (${rows[0]?.reason_code})`)
    record('C2.7', rows[0]?.initiated_by === null, `initiated_by is null (${rows[0]?.initiated_by})`)
    record('C2.8', rows[0]?.business_order_no === businessOrderNo, 'business_order_no matches')
    record(
      'C2.9',
      Array.isArray(rows[0]?.order_ids) && rows[0].order_ids.length === 1 && String(rows[0].order_ids[0]) === cardOrderId,
      'order_ids links exactly this order',
    )
  }

  // ------------------------------------- OLD APK against the same reference
  console.log('\n=== C3  an OLD APK posts the same reference: still exactly 1 row ===')
  {
    const before = (await saleRowsFor(cardOrderId)).length
    console.log(`  SALE rows BEFORE: ${before}`)

    const res = await salePost(
      new Request('https://staging.local/api/terminal/payment-events/sale', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({
          order_ids: [cardOrderId],
          business_order_no: businessOrderNo,
          transaction_id: businessOrderNo,
          amount: 47.25,
          currency: 'NAD',
          app_version: '1.34',
        }),
      }),
    )
    console.log(`  old-APK sale post -> ${res.status}`)

    const rows = await saleRowsFor(cardOrderId)
    console.log(`  SALE rows AFTER:  ${rows.length}   (delta ${rows.length - before})`)

    record('C3.1', res.status === 200, `old client got 200, not an error it would retry on (${res.status})`)
    record('C3.2', rows.length === 1, `STILL exactly 1 SALE row (${rows.length})`)
    record('C3.3', rows[0]?.reason_code === 'settle_card', 'the server-written row survived')
  }

  // ------------------------------------------------------ reconciliation
  console.log('\n=== C4  the reconciliation check sees a real gap, and reports only ===')
  {
    const { data: orphan, error } = await admin
      .from('orders')
      .insert({
        restaurant_id: restaurantId,
        table_number: 0,
        channel: 'pos',
        status: 'completed',
        payment_status: 'paid',
        payment_method: 'card',
        total: 9.99,
        paid_at: new Date().toISOString(),
      })
      .select('id')
      .single()
    if (error) throw new Error(`orphan insert failed: ${error.message}`)
    createdOrderIds.push(String(orphan.id))

    const { reconcileSaleLedgerCoverage } = await import('@/lib/payments/reconcile-sale-ledger-coverage')
    const { createServerSupabaseClient } = await import('@/lib/supabase/server')

    const result = await reconcileSaleLedgerCoverage(createServerSupabaseClient(), {
      windowHours: 1,
      restaurantId,
      dryRun: true, // reports only — writes nothing, so there is nothing extra to clean up
    })
    const venue = result.report?.venues.find((v) => v.restaurantId === restaurantId)
    console.log(`  totals: ${JSON.stringify(result.report?.totals)}`)
    console.log(`  venue:  paid=${venue?.paidCount} missing=${venue?.missingCount} degraded=${venue?.degraded}`)

    record('C4.1', result.ok === true, 'reconciliation ran')
    record(
      'C4.2',
      Boolean(venue?.missingOrderIds.includes(String(orphan.id))),
      'the card order with no SALE row is reported missing',
    )
    record(
      'C4.3',
      !venue?.missingOrderIds.includes(createdOrderIds[0]),
      'the CASH order is not counted as a gap',
    )
    record(
      'C4.4',
      Boolean(venue) && !venue!.missingOrderIds.includes(cardOrderId),
      'the settled card order is covered, not missing',
    )
  }

  console.log(`\n${failures === 0 ? 'VERIFY_SALE_LEDGER_SETTLE_OK' : `${failures} CHECK(S) FAILED`}`)
}

async function cleanup() {
  console.log('\n=== cleanup ===')
  const steps: Array<[string, string[]]> = [
    ['payment_events', createdPaymentEventIds],
    ['orders', createdOrderIds],
    ['tabs', createdTabIds],
  ]

  // Receipts are issued by the settle route and hold an FK to orders, so they must go first
  // or the orders delete fails and the tabs delete fails behind it.
  if (createdOrderIds.length) {
    const { data: docs } = await admin
      .from('receipt_documents')
      .select('id')
      .in('order_id', createdOrderIds)
    const docIds = (docs ?? []).map((r) => String(r.id))
    if (docIds.length) {
      const { data: deliveries } = await admin
        .from('receipt_deliveries')
        .select('id')
        .in('receipt_document_id', docIds)
      const deliveryIds = (deliveries ?? []).map((r) => String(r.id))
      // Documents unshifted first, deliveries second, so deliveries end up AHEAD of the
      // documents they reference -- the reverse would trip the FK it is here to avoid.
      steps.unshift(['receipt_documents', docIds])
      if (deliveryIds.length) steps.unshift(['receipt_deliveries', deliveryIds])
    }
  }

  // payments rows are created by the settle route itself, keyed on the tabs it settled.
  if (createdTabIds.length) {
    const { data } = await admin.from('payments').select('id').in('tab_id', createdTabIds)
    const paymentIds = (data ?? []).map((r) => String(r.id))
    if (paymentIds.length) steps.unshift(['payments', paymentIds])
  }

  // audit_logs the settle route wrote for these tabs/orders.
  const auditTargets = [...createdTabIds, ...createdOrderIds]
  if (auditTargets.length) {
    const { data } = await admin
      .from('audit_logs')
      .select('id')
      .eq('restaurant_id', restaurantId)
      .in('entity_id', auditTargets)
    const auditIds = (data ?? []).map((r) => String(r.id))
    if (auditIds.length) steps.splice(1, 0, ['audit_logs', auditIds])
  }

  for (const [table, ids] of steps) {
    if (!ids.length) {
      console.log(`  ${table}: nothing created`)
      continue
    }
    const { error } = await admin.from(table).delete().in('id', ids)
    const { data: left } = await admin.from(table).select('id').in('id', ids)
    const remaining = left?.length ?? 0
    console.log(
      `  ${table}: deleted ${ids.length}${error ? ` (ERROR ${error.message})` : ''}; ${remaining} remain`,
    )
    if (remaining > 0) failures++
  }
}

main()
  .catch((err) => {
    console.error('\nRUN FAILED:', err instanceof Error ? err.message : err)
    failures++
  })
  .then(cleanup)
  .then(() => process.exit(failures === 0 ? 0 : 1))
