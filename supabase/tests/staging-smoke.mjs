/**
 * PHASE 5 — STAGING SMOKE, DATABASE LEG.
 *
 * Every scenario below runs against the LIVE STAGING DATABASE and calls the REAL deployed
 * `settle_order_payment`, the real constraints and the real grants. Nothing is faked.
 *
 * WHAT THIS DOES NOT COVER, and why: the Cloudflare staging WORKER could not be redeployed —
 * `wrangler secret put` fails with `Authentication error [code: 10000]`, the Workers-API
 * signature of a dead token. So the HTTP legs (routes, auth middleware, rate limiting, the
 * customer-facing active-tab total) are not exercised here; they are named in the report.
 *
 * FIXTURES ARE REMOVED. Every row this creates carries the marker below in `idempotency_key` /
 * `merchant_order_no` / `payment_reference`, and the teardown deletes by that marker. The teardown
 * runs from `finally`, so a thrown assertion still cleans up.
 *
 *   node supabase/tests/staging-smoke.mjs
 */
import { randomUUID } from 'node:crypto'
import { connectStaging } from './staging-db.mjs'

const MARKER = 'SMOKE-' + new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14)
const VENUE = 'a1999166-ddfa-40d1-ad1f-2f01282a1652' // the "staging test" restaurant

let pass = 0
let fail = 0
const failures = []

function check(name, ok, detail) {
  if (ok) {
    pass += 1
    console.log(`  PASS  ${name}`)
  } else {
    fail += 1
    failures.push(name + (detail ? ` — ${detail}` : ''))
    console.log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`)
  }
}

const client = await connectStaging()

/** One settlement call. Returns the jsonb the function returned. */
async function settle(args) {
  const r = await client.query(
    `select public.settle_order_payment(
       $1::uuid, $2::uuid[], $3::integer, $4::integer, $5::text, $6::text, $7::text, $8::text,
       $9::uuid, $10::text, $11::text, $12::integer, $13::uuid, $14::uuid[], $15::text) as out`,
    [
      args.restaurantId ?? VENUE,
      args.orderIds,
      args.expectedCents ?? null,
      args.gatewayCents === undefined ? null : args.gatewayCents,
      args.txn ?? null,
      args.reference ?? null,
      args.method ?? 'card',
      args.merchantOrderNo ?? null,
      args.intentId ?? null,
      args.source ?? 'smoke',
      args.terminalId ?? null,
      args.tipCents ?? 0,
      args.tipStaffUserId ?? null,
      args.allowCancelled ?? null,
      args.appVersion ?? 'smoke-1',
    ],
  )
  return r.rows[0].out
}

/** An order at the staging venue, in cents. */
async function makeOrder({ tabId, tableId, cents, paymentStatus = 'pending', status = 'pending' }) {
  const id = randomUUID()
  await client.query(
    `insert into public.orders
       (id, restaurant_id, tab_id, table_id, status, payment_status, payment_method,
        subtotal, tax, total, items, channel, idempotency_key, placed_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, 0, $8, '[]'::jsonb, 'table', $9, now())`,
    [id, VENUE, tabId, tableId, status, paymentStatus,
      paymentStatus === 'cash_pending' ? 'cash' : null, cents / 100, `${MARKER}-${id}`],
  )
  return id
}

/**
 * A table and its tab. `idx_tabs_one_open_per_table` permits ONE open tab per
 * (restaurant_id, table_number), so every scenario gets its own table rather than sharing one --
 * reusing a number made the second scenario die on that index.
 *
 * Ids are recorded so teardown deletes exactly what was created, never a range.
 */
const madeTables = []
// A random base: a run whose teardown does not finish leaves its numbers behind, and a fixed
// base then collides with `restaurant_tables_restaurant_id_table_number_key`.
let nextTableNumber = 9000 + Math.floor(Math.random() * 900)

async function makeTable() {
  const id = randomUUID()
  const number = nextTableNumber
  nextTableNumber += 1
  await client.query(
    `insert into public.restaurant_tables (id, restaurant_id, table_number, status)
     values ($1, $2, $3, 'occupied')`, [id, VENUE, number])
  madeTables.push(id)
  return { id, number }
}

const madeTabs = []

async function makeTab(table) {
  const id = randomUUID()
  await client.query(
    `insert into public.tabs (id, restaurant_id, table_id, table_number, status, members, total)
     values ($1, $2, $3, $4, 'open', '[]'::jsonb, 0)`,
    [id, VENUE, table.id, table.number],
  )
  madeTabs.push(id)
  return id
}

async function makeIntent({ tabId, orderIds, cents, scope = 'orders' }) {
  const id = randomUUID()
  await client.query(
    `insert into public.terminal_payment_intents
       (id, restaurant_id, tab_id, merchant_order_no, amount_cents, scope, order_ids, status)
     values ($1, $2, $3, $4, $5, $6, $7, 'launched')`,
    [id, VENUE, tabId, `${MARKER}-${id.slice(0, 8)}`, cents, scope, orderIds],
  )
  return id
}

const ordersOf = async (ids) => (await client.query(
  `select id, payment_status, payment_method, status, total, paid_at, payment_reference,
          pending_charge_cents, pending_settlement_id
     from public.orders where id = any($1) order by total`, [ids])).rows

try {
  // A dedicated table so nothing else on staging is disturbed.
  const table1 = await makeTable()

  // ══ 3 + the Riviera scenario ═══════════════════════════════════════════════════════════════
  console.log('\nS1  Riviera: Order A N$220 + Order B N$500, one card charge of N$720')
  const tabId = await makeTab(table1)
  const orderA = await makeOrder({ tabId, tableId: table1.id, cents: 22000 })
  const orderB = await makeOrder({ tabId, tableId: table1.id, cents: 50000 })
  const intent = await makeIntent({ tabId, orderIds: [orderA, orderB], cents: 72000 })
  const txn = `${MARKER}-TXN-1`
  const ref = `${MARKER}-REF-1`

  const s1 = await settle({
    orderIds: [orderA, orderB], expectedCents: 72000, gatewayCents: 72000,
    txn, reference: ref, method: 'card', merchantOrderNo: ref, intentId: intent,
  })
  check('S1 settled', s1.ok === true && s1.reason === 'settled', JSON.stringify(s1))
  check('S1 gateway charge = N$720', s1.gateway_amount_cents === 72000)
  check('S1 expected = N$720 (re-derived under lock)', s1.expected_amount_cents === 72000)
  check('S1 both orders claimed', (s1.claimed_order_ids || []).length === 2,
    JSON.stringify(s1.claimed_order_ids))
  check('S1 payment method = card', s1.payment_method === 'card')
  check('S1 ledger row written', s1.ledger_row_written === true)

  const after1 = await ordersOf([orderA, orderB])
  check('S1 both orders paid', after1.every((o) => o.payment_status === 'paid'),
    JSON.stringify(after1.map((o) => o.payment_status)))
  check('S1 no order remains cash', after1.every((o) => o.payment_method === 'card'),
    JSON.stringify(after1.map((o) => o.payment_method)))
  check('S1 allocation = N$220 + N$500', after1.map((o) => Number(o.total)).join('+') === '220+500',
    after1.map((o) => o.total).join('+'))
  check('S1 paid_at stamped on both', after1.every((o) => o.paid_at !== null))
  check('S1 pending_* cleared (F18)',
    after1.every((o) => o.pending_charge_cents === null && o.pending_settlement_id === null))

  // ══ 11 + 12  immutable ledger / payment_events ═════════════════════════════════════════════
  const ev = await client.query(
    `select event_type, amount, order_ids, transaction_id, idempotency_key,
            raw_gateway_response->>'recorded_by' as recorded_by
       from public.payment_events where restaurant_id = $1 and idempotency_key = $2`, [VENUE, ref])
  check('S1 exactly one payment_events sale row', ev.rows.length === 1, `rows=${ev.rows.length}`)
  check('S1 ledger amount = 720.00', Number(ev.rows[0]?.amount) === 720)
  check('S1 ledger covers both orders', (ev.rows[0]?.order_ids || []).length === 2)
  check('S1 ledger written server-side', ev.rows[0]?.recorded_by === 'server',
    String(ev.rows[0]?.recorded_by))

  const audit = await client.query(
    `select metadata from public.audit_logs
      where restaurant_id = $1 and action = 'payment.settlement_applied' and entity_id = $2`,
    [VENUE, intent])
  const md = audit.rows[0]?.metadata ?? {}
  check('S1 one settlement audit row', audit.rows.length === 1, `rows=${audit.rows.length}`)
  check('S1 audit settlement figure is N$720', md.settlement_gateway_amount_cents === 72000)
  check('S1 audit per-order figure is NULL for a 2-order settlement (F15)',
    md.per_order_gateway_amount_cents === null, JSON.stringify(md.per_order_gateway_amount_cents))
  check('S1 audit records intended vs applied',
    (md.intended_order_ids || []).length === 2 && (md.applied_order_ids || []).length === 2)

  const tabAfter = await client.query('select total, status from public.tabs where id = $1', [tabId])
  check('S1 no outstanding N$220 left on the tab', Number(tabAfter.rows[0].total) === 0,
    String(tabAfter.rows[0].total))

  const intentAfter = await client.query(
    `select status, consumed_at, gateway_amount_cents, gateway_payment_method, settled_order_ids
       from public.terminal_payment_intents where id = $1`, [intent])
  check('S1 intent consumed', intentAfter.rows[0].consumed_at !== null)
  check('S1 intent records the gateway figure', intentAfter.rows[0].gateway_amount_cents === 72000)
  check('S1 intent records the method', intentAfter.rows[0].gateway_payment_method === 'card')

  // ══ 8 + 17  duplicate callback / webhook, same intent ══════════════════════════════════════
  console.log('\nS2  duplicate settlement on the same intent (idempotency)')
  const s2 = await settle({
    orderIds: [orderA, orderB], expectedCents: 72000, gatewayCents: 72000,
    txn, reference: ref, method: 'card', merchantOrderNo: ref, intentId: intent,
  })
  check('S2 refused as already applied', s2.ok !== true || s2.applied !== true, JSON.stringify(s2))
  const ev2 = await client.query(
    'select count(*)::int n from public.payment_events where restaurant_id=$1 and idempotency_key=$2',
    [VENUE, ref])
  check('S2 no duplicate payment', ev2.rows[0].n === 1, `rows=${ev2.rows[0].n}`)
  const audit2 = await client.query(
    `select count(*)::int n from public.audit_logs
      where restaurant_id=$1 and action='payment.settlement_applied' and entity_id=$2`, [VENUE, intent])
  check('S2 no second settlement audit row', audit2.rows[0].n === 1, `rows=${audit2.rows[0].n}`)

  // ══ 8  a SECOND intent quoting the same merchant order no ══════════════════════════════════
  console.log('\nS3  a second settlement quoting the same reference writes no second ledger row')
  const tableX = await makeTable()
  const tabX = await makeTab(tableX)
  const orderX = await makeOrder({ tabId: tabX, tableId: tableX.id, cents: 1000 })
  const intentX = await makeIntent({ tabId: tabX, orderIds: [orderX], cents: 1000 })
  const s3 = await settle({
    orderIds: [orderX], expectedCents: 1000, gatewayCents: 1000,
    txn: `${MARKER}-TXN-X`, reference: ref, method: 'card', merchantOrderNo: ref, intentId: intentX,
  })
  check('S3 settled', s3.ok === true)
  check('S3 ledger_row_written = false (ON CONFLICT DO NOTHING)', s3.ledger_row_written === false,
    String(s3.ledger_row_written))
  const ev3 = await client.query(
    'select count(*)::int n from public.payment_events where restaurant_id=$1 and idempotency_key=$2',
    [VENUE, ref])
  check('S3 still exactly one ledger row for that reference', ev3.rows[0].n === 1)

  // ══ 14 (F14)  one gateway transaction id, one ledger row ═══════════════════════════════════
  console.log('\nS4  payment_events unique (restaurant_id, transaction_id)')
  let dupTxn = null
  try {
    await client.query(
      `insert into public.payment_events
         (restaurant_id, order_ids, event_type, business_order_no, origin_business_order_no,
          transaction_id, amount, currency, idempotency_key, reason_code)
       values ($1, $2, 'sale', $3, $3, $4, 7.2, 'NAD', $3, 'sale')`,
      [VENUE, [orderA], `${MARKER}-OTHER-KEY`, txn])
    dupTxn = 'INSERTED'
  } catch (err) {
    dupTxn = err.code
  }
  check('S4 a second row for the same transaction_id is refused', dupTxn === '23505', String(dupTxn))

  // ══ 6 (financial invariant 1)  gateway amount must equal the internal amount ════════════════
  console.log('\nS5  the Riviera defect itself: charge N$220 against a N$720 target')
  const tableR = await makeTable()
  const tabR = await makeTab(tableR)
  const rA = await makeOrder({ tabId: tabR, tableId: tableR.id, cents: 22000 })
  const rB = await makeOrder({ tabId: tabR, tableId: tableR.id, cents: 50000 })
  const intentR = await makeIntent({ tabId: tabR, orderIds: [rA, rB], cents: 72000 })
  const s5 = await settle({
    orderIds: [rA, rB], expectedCents: 72000, gatewayCents: 22000,
    txn: `${MARKER}-TXN-R`, reference: `${MARKER}-REF-R`, method: 'card',
    merchantOrderNo: `${MARKER}-REF-R`, intentId: intentR,
  })
  // The INTENT gate catches it first -- the intent recorded N$720 and the gateway said N$220 --
  // which is a stricter refusal reached one step earlier. S5b drives the same money through with
  // no intent, so the amount gate itself is exercised rather than assumed.
  check('S5 refused before anything is written',
    s5.ok === false && ['intent_amount_mismatch', 'amount_mismatch'].includes(s5.reason),
    JSON.stringify(s5))
  const afterR = await ordersOf([rA, rB])
  check('S5 nothing was paid', afterR.every((o) => o.payment_status === 'pending'),
    JSON.stringify(afterR.map((o) => o.payment_status)))
  const evR = await client.query(
    'select count(*)::int n from public.payment_events where restaurant_id=$1 and idempotency_key=$2',
    [VENUE, `${MARKER}-REF-R`])
  check('S5 no ledger row for a refused settlement', evR.rows[0].n === 0)

  const s5b = await settle({
    orderIds: [rA, rB], expectedCents: 72000, gatewayCents: 22000,
    txn: `${MARKER}-TXN-R2`, reference: `${MARKER}-REF-R2`, method: 'card',
    merchantOrderNo: `${MARKER}-REF-R2`,
  })
  check('S5b with no intent, the amount gate itself refuses',
    s5b.ok === false && s5b.reason === 'amount_mismatch', JSON.stringify(s5b))
  check('S5b reports both figures',
    s5b.expected_cents === 72000 && s5b.gateway_amount_cents === 22000, JSON.stringify(s5b))
  const after5b = await ordersOf([rA, rB])
  check('S5b still nothing paid', after5b.every((o) => o.payment_status === 'pending'),
    JSON.stringify(after5b.map((o) => o.payment_status)))

  console.log('\nS6  an absent gateway amount is not agreement')
  const s6 = await settle({
    orderIds: [rA, rB], expectedCents: 72000, gatewayCents: null,
    reference: `${MARKER}-REF-N`, method: 'card', merchantOrderNo: `${MARKER}-REF-N`,
  })
  check('S6 refused as gateway_amount_absent', s6.reason === 'gateway_amount_absent',
    JSON.stringify(s6))

  // ══ TOCTOU ═════════════════════════════════════════════════════════════════════════════════
  console.log('\nS7  the tab is amended between preparation and settlement (TOCTOU)')
  await client.query('update public.orders set total = 600 where id = $1', [rB])
  const s7 = await settle({
    orderIds: [rA, rB], expectedCents: 72000, gatewayCents: 72000,
    txn: `${MARKER}-TXN-T`, reference: `${MARKER}-REF-T`, method: 'card',
    merchantOrderNo: `${MARKER}-REF-T`, intentId: intentR,
  })
  check('S7 refused as target_changed_since_preparation',
    s7.reason === 'target_changed_since_preparation', JSON.stringify(s7))
  check('S7 reports both figures', s7.expected_at_preparation_cents === 72000 &&
    s7.expected_now_cents === 82000, JSON.stringify(s7))
  await client.query('update public.orders set total = 500 where id = $1', [rB])

  // ══ 13  every named order must be present ══════════════════════════════════════════════════
  console.log('\nS8  a partial target is refused, not settled smaller')
  const s8 = await settle({
    orderIds: [rA, rB, randomUUID()], expectedCents: 72000, gatewayCents: 72000,
    txn: `${MARKER}-TXN-P`, reference: `${MARKER}-REF-P`, method: 'card',
    merchantOrderNo: `${MARKER}-REF-P`,
  })
  check('S8 refused as orders_missing', s8.reason === 'orders_missing', JSON.stringify(s8))
  check('S8 reports requested vs found', s8.requested === 3 && s8.found === 2, JSON.stringify(s8))

  // ══ 10 (F3)  payment method comes from the gateway, never from the row ═════════════════════
  console.log('\nS9  a cash_pending order settled by card records CARD')
  const tableC = await makeTable()
  const tabC = await makeTab(tableC)
  const orderC = await makeOrder({
    tabId: tabC, tableId: tableC.id, cents: 15000, paymentStatus: 'cash_pending' })
  const before9 = await ordersOf([orderC])
  check('S9 fixture really starts as cash', before9[0].payment_method === 'cash',
    String(before9[0].payment_method))
  const s9 = await settle({
    orderIds: [orderC], expectedCents: 15000, gatewayCents: 15000,
    txn: `${MARKER}-TXN-C`, reference: `${MARKER}-REF-C`, method: 'card',
    merchantOrderNo: `${MARKER}-REF-C`,
  })
  check('S9 settled', s9.ok === true, JSON.stringify(s9))
  const after9 = await ordersOf([orderC])
  check('S9 method is card, not cash (F3)', after9[0].payment_method === 'card',
    String(after9[0].payment_method))
  const audit9 = await client.query(
    `select metadata->>'per_order_gateway_amount_cents' as per_order from public.audit_logs
      where restaurant_id=$1 and action='payment.settlement_applied' and entity_id=$2`,
    [VENUE, `${MARKER}-REF-C`])
  check('S9 per-order figure IS set for a single-order settlement',
    audit9.rows[0]?.per_order === '15000', String(audit9.rows[0]?.per_order))

  // ══ a cancelled order cannot be revived without the allow-list ═════════════════════════════
  console.log('\nS10  cancelled -> paid needs the E04111 allow-list')
  const tableK = await makeTable()
  const tabK = await makeTab(tableK)
  const okOrder = await makeOrder({ tabId: tabK, tableId: tableK.id, cents: 5000 })
  const cancelled = await makeOrder({
    tabId: tabK, tableId: tableK.id, cents: 5000, paymentStatus: 'cancelled', status: 'cancelled' })
  const s10 = await settle({
    orderIds: [okOrder, cancelled], expectedCents: 10000, gatewayCents: 10000,
    txn: `${MARKER}-TXN-K`, reference: `${MARKER}-REF-K`, method: 'card',
    merchantOrderNo: `${MARKER}-REF-K`,
  })
  check('S10 refused as illegal_transition', s10.reason === 'illegal_transition', JSON.stringify(s10))
  const after10 = await ordersOf([okOrder, cancelled])
  // A REFUSAL MUST WRITE NOTHING, WHICHEVER WAY THE IDS SORT. The target set is locked
  // `ORDER BY id`, so before 20260919093000 this passed or failed on uuid generation: the loop
  // paid every order it reached before the cancelled one and `RETURN` did not undo it.
  const legalAfter10 = after10.find((o) => o.id === okOrder)
  check('S10 the legal order was NOT paid by a refused settlement',
    legalAfter10.payment_status !== 'paid', String(legalAfter10.payment_status))
  check('S10 the cancelled order was not revived',
    after10.find((o) => o.id === cancelled).payment_status === 'cancelled')
  const ev10 = await client.query(
    'select count(*)::int n from public.payment_events where idempotency_key = $1',
    [`${MARKER}-REF-K`])
  check('S10 no ledger row for the refused settlement', ev10.rows[0].n === 0)
  const s10b = await settle({
    orderIds: [okOrder, cancelled], expectedCents: 10000, gatewayCents: 10000,
    txn: `${MARKER}-TXN-K2`, reference: `${MARKER}-REF-K2`, method: 'card',
    merchantOrderNo: `${MARKER}-REF-K2`, allowCancelled: [cancelled],
  })
  check('S10b the allow-list permits the recovery', s10b.ok === true, JSON.stringify(s10b))
  check('S10b the recovery is reported', (s10b.recovered_order_ids || []).length === 1)

  // ══ 16  tab close during/around payment ════════════════════════════════════════════════════
  console.log('\nS11  the tab is closed out before the charge lands')
  const tableZ = await makeTable()
  const tabZ = await makeTab(tableZ)
  const orderZ = await makeOrder({ tabId: tabZ, tableId: tableZ.id, cents: 30000 })
  const intentZ = await makeIntent({ tabId: tabZ, orderIds: [orderZ], cents: 30000 })
  await client.query('select public.close_table_session($1::uuid, $2::uuid)', [tableZ.id, VENUE])
  const closedTab = await client.query('select status from public.tabs where id=$1', [tabZ])
  check('S11 the tab really was closed first', closedTab.rows[0].status !== 'open',
    String(closedTab.rows[0].status))
  const s11 = await settle({
    orderIds: [orderZ], expectedCents: 30000, gatewayCents: 30000,
    txn: `${MARKER}-TXN-Z`, reference: `${MARKER}-REF-Z`, method: 'card',
    merchantOrderNo: `${MARKER}-REF-Z`, intentId: intentZ,
  })
  check('S11 the charge is still applied — never silently lost', s11.ok === true, JSON.stringify(s11))
  check('S11 tab_was_closed is reported, not silent', s11.tab_was_closed === true,
    String(s11.tab_was_closed))
  const auditZ = await client.query(
    `select metadata->>'tab_was_closed' as closed from public.audit_logs
      where restaurant_id=$1 and action='payment.settlement_applied' and entity_id=$2`, [VENUE, intentZ])
  check('S11 the audit row carries it too', auditZ.rows[0]?.closed === 'true',
    String(auditZ.rows[0]?.closed))

  // ══ the state machine, enforced by the database ════════════════════════════════════════════
  console.log('\nS12  payment_status is enumerated in the database')
  let bogus = null
  try {
    await client.query("update public.orders set payment_status = 'refunded' where id = $1", [orderZ])
    bogus = 'ACCEPTED'
  } catch (err) { bogus = err.code }
  check('S12 an unknown payment_status is refused', bogus === '23514', String(bogus))

  console.log('\nS13  unsupported payment method is refused by the function')
  let badMethod = null
  try {
    await settle({
      orderIds: [okOrder], expectedCents: 5000, gatewayCents: 5000,
      reference: `${MARKER}-REF-M`, method: 'bitcoin', merchantOrderNo: `${MARKER}-REF-M`,
    })
    badMethod = 'ACCEPTED'
  } catch (err) { badMethod = err.message }
  check('S13 refused', /unsupported payment method/.test(String(badMethod)), String(badMethod))

  // ══ 17  per-restaurant idempotency key (F12) ═══════════════════════════════════════════════
  console.log('\nS14  orders.idempotency_key is unique PER RESTAURANT, not globally')
  const dupKey = `${MARKER}-DUPKEY`
  const d1 = randomUUID()
  await client.query(
    `insert into public.orders (id, restaurant_id, status, payment_status, subtotal, tax, total,
       items, channel, idempotency_key, placed_at)
     values ($1,$2,'pending','pending',10,0,10,'[]'::jsonb,'table',$3,now())`, [d1, VENUE, dupKey])
  let sameVenue = null
  try {
    await client.query(
      `insert into public.orders (id, restaurant_id, status, payment_status, subtotal, tax, total,
         items, channel, idempotency_key, placed_at)
       values ($1,$2,'pending','pending',10,0,10,'[]'::jsonb,'table',$3,now())`,
      [randomUUID(), VENUE, dupKey])
    sameVenue = 'ACCEPTED'
  } catch (err) { sameVenue = err.code }
  check('S14 the same key twice at one venue is refused', sameVenue === '23505', String(sameVenue))

  const other = await client.query(
    'select id from public.restaurants where id <> $1 limit 1', [VENUE])
  const d2 = randomUUID()
  let otherVenue = null
  try {
    await client.query(
      `insert into public.orders (id, restaurant_id, status, payment_status, subtotal, tax, total,
         items, channel, idempotency_key, placed_at)
       values ($1,$2,'pending','pending',10,0,10,'[]'::jsonb,'table',$3,now())`,
      [d2, other.rows[0].id, dupKey])
    otherVenue = 'ACCEPTED'
  } catch (err) { otherVenue = err.code }
  check('S14 the same key at a DIFFERENT venue is allowed (F12)', otherVenue === 'ACCEPTED',
    String(otherVenue))

  // ══ 18  unauthorized access, with a positive control ═══════════════════════════════════════
  console.log('\nS15  the new RPC cannot be called by an unauthorized client')
  const grants = await client.query(
    `select r.rolname,
            has_function_privilege(r.rolname, p.oid, 'EXECUTE') as can
       from pg_proc p
       join pg_namespace n on n.oid = p.pronamespace,
            (values ('anon'),('authenticated'),('service_role')) r(rolname)
      where n.nspname = 'public' and p.proname = 'settle_order_payment'`)
  const g = Object.fromEntries(grants.rows.map((r) => [r.rolname, r.can]))
  check('S15 anon cannot EXECUTE', g.anon === false, String(g.anon))
  check('S15 authenticated cannot EXECUTE', g.authenticated === false, String(g.authenticated))
  check('S15 POSITIVE CONTROL: service_role CAN — the check is alive', g.service_role === true,
    String(g.service_role))
  const pub = await client.query(
    `select coalesce(proacl::text, '') acl from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public' and p.proname='settle_order_payment'`)
  check('S15 EXECUTE is not granted to PUBLIC', !/(^|,)=X/.test(pub.rows[0].acl), pub.rows[0].acl)

  // A live anon call over PostgREST is the end-to-end form of the same question.
  const anonProbe = await client.query(
    `select has_function_privilege('anon', 'public.settle_order_payment(uuid, uuid[], integer,
       integer, text, text, text, text, uuid, text, text, integer, uuid, uuid[], text)',
       'EXECUTE') as can`)
  check('S15 anon by full signature', anonProbe.rows[0].can === false)

  // ══ 14  reconciliation ═════════════════════════════════════════════════════════════════════
  console.log('\nS16  reconciliation balances over what was just settled')
  const rec = await client.query(
    `select o.id,
            o.payment_status,
            round(o.total * 100)::integer as order_cents,
            (select count(*)::int from public.payment_events e
              where e.restaurant_id = o.restaurant_id and o.id = any(e.order_ids)) as ledger_rows
       from public.orders o
      where o.restaurant_id = $1 and o.idempotency_key like $2
      order by o.total`, [VENUE, `${MARKER}-%`])
  const paidRows = rec.rows.filter((r) => r.payment_status === 'paid')

  /**
   * S3 IS DELIBERATELY EXCLUDED, and saying why is the assertion.
   *
   * S3 settles a second, unrelated order quoting S1's merchant order number, to prove the ledger's
   * ON CONFLICT DO NOTHING. That order is therefore paid with no ledger row of its own, by design.
   * A real gateway reference is unique per sale, so this is a property of the scenario and not a
   * hole in reconciliation -- but it is exactly the shape a real hole would take, so it is named
   * here rather than filtered silently, and it must be the ONLY one.
   */
  const uncovered = paidRows.filter((r) => r.ledger_rows === 0)
  check("S16 exactly one paid order lacks a ledger row: S3's deliberate duplicate",
    uncovered.length === 1 && uncovered[0].id === orderX,
    JSON.stringify(uncovered.map((r) => [r.id, r.order_cents])))

  const covered = paidRows.filter((r) => r.id !== orderX)
  check('S16 every other paid order has a ledger row covering it',
    covered.every((r) => r.ledger_rows > 0),
    JSON.stringify(covered.map((r) => [r.order_cents, r.ledger_rows])))

  const paidCents = covered.reduce((a, r) => a + r.order_cents, 0)
  const ledgerCents = (await client.query(
    `select coalesce(sum(amount) * 100, 0)::integer n from public.payment_events
      where restaurant_id = $1 and idempotency_key like $2`, [VENUE, `${MARKER}-%`])).rows[0].n
  check(`S16 paid orders ${paidCents}c balance the ledger's ${ledgerCents}c`,
    paidCents === ledgerCents, `${paidCents} vs ${ledgerCents}`)

  const unpaidLedger = await client.query(
    `select count(*)::int n from public.orders o
      where o.restaurant_id = $1 and o.idempotency_key like $2 and o.payment_status <> 'paid'
        and exists (select 1 from public.payment_events e
                     where e.restaurant_id = o.restaurant_id and o.id = any(e.order_ids)
                       and e.idempotency_key like $2)`, [VENUE, `${MARKER}-%`])
  check('S16 no unpaid order is named by a ledger row of this run', unpaidLedger.rows[0].n === 0,
    String(unpaidLedger.rows[0].n))
} finally {
  // ── teardown ───────────────────────────────────────────────────────────────────────────────
  console.log('\nTEARDOWN')
  const del = async (label, sql, params) => {
    const r = await client.query(sql, params)
    console.log(`  ${label}: ${r.rowCount}`)
  }
  try {
    await del('payment_tips', "delete from public.payment_tips where payment_reference like $1", [`${MARKER}-%`])
    await del('payment_events', "delete from public.payment_events where idempotency_key like $1", [`${MARKER}-%`])
    await del('audit_logs', `delete from public.audit_logs where action='payment.settlement_applied'
       and (entity_id like $1 or entity_id in (select id::text from public.terminal_payment_intents
            where merchant_order_no like $1))`, [`${MARKER}-%`])
    await del('orders', "delete from public.orders where idempotency_key like $1", [`${MARKER}-%`])
    await del('intents', "delete from public.terminal_payment_intents where merchant_order_no like $1", [`${MARKER}-%`])
    await del('customer_sessions', 'delete from public.customer_sessions where table_id = any($1)', [madeTables])
    await del('tabs', 'delete from public.tabs where id = any($1)', [madeTabs])
    await del('restaurant_tables', 'delete from public.restaurant_tables where id = any($1)', [madeTables])
  } catch (err) {
    console.log('  TEARDOWN FAILED: ' + err.message)
    console.log(`  marker was ${MARKER} — remove by hand`)
  }
  await client.end()
  console.log(`\nSTAGING SMOKE (DB LEG): ${pass} passed, ${fail} failed`)
  for (const f of failures) console.log('  FAILED: ' + f)
  process.exitCode = fail === 0 ? 0 : 1
}
