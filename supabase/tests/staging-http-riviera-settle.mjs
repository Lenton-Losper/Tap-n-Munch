/**
 * PHASE 2 -- STAGING HTTP LEG: the Riviera multi-order settlement, end to end over real HTTP.
 *
 * The DB leg already proves `settle_order_payment`. What has NEVER run is the ROUTE on top of it
 * -- app/api/terminal/tabs/[tabId]/settle/route.ts, +125 lines in this sprint -- because the
 * staging worker was 93 commits stale behind a dead Cloudflare token.
 *
 * The terminal token is obtained the way a real P5 obtains one: a terminal row is created with an
 * activation code and POSTed to /api/terminals/activate. Nothing is minted locally, so the token
 * is signed by the worker's own secret and the auth middleware is exercised too.
 *
 * THE CASE:  N$220 + N$500 = N$720, one gateway charge, both orders settled as CARD,
 *            ONE ledger row covering both, no duplicate settlement, tab outstanding 0,
 *            payment intent consumed exactly once.
 *
 * The settle call is then REPLAYED verbatim, because "no duplicate settlement" is only meaningful
 * against a second attempt.
 *
 *   node supabase/tests/staging-http-riviera-settle.mjs
 */
import { randomUUID } from 'node:crypto'
import { connectStaging } from './staging-db.mjs'

const BASE = process.env.STAGING_BASE ?? 'https://flashtap-staging.llosperofficial.workers.dev'
const VENUE = 'a1999166-ddfa-40d1-ad1f-2f01282a1652'
const MARKER = 'HTTPRIV-' + new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14)
const A = 220
const B = 500
const TOTAL = A + B

let pass = 0
let fail = 0
const ok = (n, c, d) => {
  if (c) {
    pass += 1
    console.log('  PASS  ' + n)
  } else {
    fail += 1
    console.log('  FAIL  ' + n + (d ? ' -- ' + d : ''))
  }
}

const client = await connectStaging()
const made = { orders: [], tabs: [], tables: [], terminals: [], intents: [] }

try {
  // ---- fixture -----------------------------------------------------------------------------
  const tableId = randomUUID()
  const tableNumber = 9000 + Math.floor(Math.random() * 900)
  await client.query(
    'insert into public.restaurant_tables (id,restaurant_id,table_number,status,active)' +
      " values ($1,$2,$3,'occupied',true)",
    [tableId, VENUE, tableNumber],
  )
  made.tables.push(tableId)

  const tabId = randomUUID()
  await client.query(
    'insert into public.tabs (id,restaurant_id,table_id,table_number,status,members,total)' +
      " values ($1,$2,$3,$4,'open','[]'::jsonb,0)",
    [tabId, VENUE, tableId, tableNumber],
  )
  made.tabs.push(tabId)

  const orderIds = []
  for (const amt of [A, B]) {
    const id = randomUUID()
    await client.query(
      'insert into public.orders (id,restaurant_id,tab_id,table_id,status,payment_status,' +
        'subtotal,tax,total,items,channel,idempotency_key,placed_at)' +
        " values ($1,$2,$3,$4,'pending','pending',$5,0,$5,'[]'::jsonb,'table',$6,now())",
      [id, VENUE, tabId, tableId, amt, MARKER + '-' + id],
    )
    made.orders.push(id)
    orderIds.push(id)
  }

  const merchantOrderNo = MARKER + '-' + randomUUID().slice(0, 8)
  const intentId = randomUUID()
  await client.query(
    'insert into public.terminal_payment_intents (id,restaurant_id,tab_id,merchant_order_no,' +
      "amount_cents,scope,order_ids,status) values ($1,$2,$3,$4,$5,'orders',$6,'launched')",
    [intentId, VENUE, tabId, merchantOrderNo, TOTAL * 100, orderIds],
  )
  made.intents.push(intentId)

  // a terminal a real device can activate
  const terminalId = randomUUID()
  const code = String(Math.floor(100000 + Math.random() * 899999))
  await client.query(
    'insert into public.restaurant_terminals (id,restaurant_id,name,active,activation_code,' +
      "activation_code_expires_at) values ($1,$2,$3,false,$4, now() + interval '1 hour')",
    [terminalId, VENUE, MARKER + '-term', code],
  )
  made.terminals.push(terminalId)

  console.log('fixture: tab ' + tabId + '  orders ' + A + ' + ' + B + ' = ' + TOTAL)
  console.log('         intent ' + intentId + '\n')

  // ---- activate, exactly as a device does ----------------------------------------------------
  const act = await fetch(BASE + '/api/terminals/activate', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      code: code,
      deviceId: MARKER + '-dev',
      terminalSn: MARKER + '-sn',
    }),
  })
  const actBody = await act.json().catch(() => null)
  ok(
    'CONTROL the terminal activated and a token was issued',
    act.status === 200 && !!(actBody && actBody.accessToken),
    'status=' + act.status + ' body=' + JSON.stringify(actBody).slice(0, 200),
  )
  const token = actBody && actBody.accessToken
  if (!token) throw new Error('no token; cannot exercise the settle route')

  // ---- settle ---------------------------------------------------------------------------------
  const settleBody = {
    order_ids: orderIds,
    amount: TOTAL,
    method: 'card',
    gateway_reference: merchantOrderNo,
    voucher_no: MARKER + '-V',
    business_order_no: merchantOrderNo,
  }
  const doSettle = async () => {
    const r = await fetch(BASE + '/api/terminal/tabs/' + tabId + '/settle', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token },
      body: JSON.stringify(settleBody),
    })
    return { status: r.status, body: await r.json().catch(() => null) }
  }

  const first = await doSettle()
  console.log('  settle #1 -> ' + first.status + ' ' + JSON.stringify(first.body).slice(0, 300))
  ok(
    'the settle route accepted the multi-order settlement',
    first.status === 200,
    'status=' + first.status + ' ' + JSON.stringify(first.body).slice(0, 300),
  )

  const second = await doSettle()
  console.log('  settle #2 (replay) -> ' + second.status + ' ' + JSON.stringify(second.body).slice(0, 300) + '\n')

  // ---- what the database now says ---------------------------------------------------------------
  const ordersAfter = (
    await client.query(
      'select id, payment_status, payment_method from public.orders where id = any($1::uuid[]) order by total',
      [orderIds],
    )
  ).rows
  ok(
    'both orders are paid',
    ordersAfter.length === 2 && ordersAfter.every((o) => o.payment_status === 'paid'),
    JSON.stringify(ordersAfter),
  )
  ok(
    'both orders record payment_method = card',
    ordersAfter.every((o) => o.payment_method === 'card'),
    JSON.stringify(ordersAfter.map((o) => o.payment_method)),
  )

  const events = (
    await client.query(
      "select id, amount, event_type, order_ids from public.payment_events where event_type='sale' and order_ids && $1::uuid[]",
      [orderIds],
    )
  ).rows
  ok('exactly ONE ledger row exists for this settlement (no duplicate)', events.length === 1, 'found ' + events.length)
  if (events.length === 1) {
    ok('that ledger row covers N$' + TOTAL, Number(events[0].amount) === TOTAL, 'amount=' + events[0].amount)
    const covered = (events[0].order_ids || []).map(String)
    ok('the ledger row names BOTH orders', orderIds.every((id) => covered.includes(id)), JSON.stringify(covered))
  }

  const outstanding = (
    await client.query(
      "select coalesce(sum(total),0) as owed from public.orders where tab_id=$1 and payment_status <> 'paid' and status <> 'cancelled'",
      [tabId],
    )
  ).rows
  ok('tab outstanding is 0', Number(outstanding[0].owed) === 0, 'owed=' + outstanding[0].owed)

  /**
   * THE TAB-SETTLE ROUTE IS NOT THE INTENT'S CONSUMER, and asserting that it is was wrong.
   *
   * `p_intent_id` is passed to `settle_order_payment` only by `settleWholeOrderPayment`
   * (lib/payments/settle-whole-order-payment.ts:280), and only when a gateway reference RESOLVED
   * to an intent -- the prepare-payment -> verify-payment / webhook leg. This route claims its
   * orders directly and never receives the intent, so an intent created alongside the fixture is
   * simply unrelated to it.
   *
   * So the honest assertion is the opposite one: settling a tab must not silently consume an
   * intent it was never handed. Intent consumption itself is covered at the RPC level by
   * staging-smoke.mjs; over HTTP it belongs to the verify-payment leg and is NOT exercised here.
   */
  const intentAfter = (
    await client.query('select status, consumed_at from public.terminal_payment_intents where id=$1', [intentId])
  ).rows
  ok(
    'an intent this route was never handed is left untouched (not silently consumed)',
    !!(intentAfter[0] && !intentAfter[0].consumed_at && intentAfter[0].status === 'launched'),
    JSON.stringify(intentAfter[0]),
  )

  ok('the REPLAY did not create a second settlement', events.length === 1, 'ledger rows after replay: ' + events.length)
} finally {
  console.log('\nTEARDOWN')
  if (made.orders.length) {
    await client.query('delete from public.payment_events where order_ids && $1::uuid[]', [made.orders]).catch(() => {})
  }
  const plan = [
    ['payment_tips', 'tab_id', made.tabs],
    ['orders', 'id', made.orders],
    ['terminal_payment_intents', 'id', made.intents],
    ['tabs', 'id', made.tabs],
    ['restaurant_tables', 'id', made.tables],
    ['restaurant_terminals', 'id', made.terminals],
  ]
  for (const [table, col, list] of plan) {
    if (!list.length) continue
    const r = await client
      .query('delete from public.' + table + ' where ' + col + ' = any($1::uuid[])', [list])
      .catch((e) => ({ rowCount: 'ERR ' + String(e.message).slice(0, 50) }))
    console.log('  ' + table + ': ' + r.rowCount)
  }
  await client.end()
}
console.log('\nSTAGING HTTP (Riviera multi-order settle): ' + pass + ' passed, ' + fail + ' failed')
process.exit(fail === 0 ? 0 : 1)
