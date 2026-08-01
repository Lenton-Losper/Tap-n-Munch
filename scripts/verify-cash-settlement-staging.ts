/**
 * Staging verification: cash settlement on the terminal tab settle endpoint.
 *
 * Decision under test: cash may be taken for an order at any time EXCEPT while a card payment
 * is genuinely in flight for that order, and every cash settlement is attributable.
 *
 *   npx tsx scripts/verify-cash-settlement-staging.ts
 *
 * Env: .env.test (staging SUPABASE_*) + TERMINAL_JWT_SECRET in .env.local
 * VERIFY_APP_URL defaults to the staging Worker.
 */
import { createClient } from '@supabase/supabase-js'
import { config } from 'dotenv'
import { resolve } from 'path'
import { signTerminalJwt } from '../lib/terminals/terminal-jwt'

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

const tag = `cash-settle-${Date.now()}`
const createdOrderIds: string[] = []
const createdTabIds: string[] = []
const createdTableIds: string[] = []
let failures = 0

function record(id: string, pass: boolean, detail: string) {
  console.log(`${pass ? 'PASS' : 'FAIL'} [${id}] ${detail}`)
  if (!pass) failures++
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

// Table numbers well outside the venue's real range so a live table is never touched. One
// open tab per table is enforced by a unique index, and every tab this script opens stays
// open until cleanup, so these must not repeat within a run — hence a counter, not a random.
let nextTableNumber = 9000 + Math.floor(Math.random() * 500) * 2

/**
 * @param withTable also create an occupied restaurant_tables row and link the tab to it.
 * /api/terminal/tables reads restaurant_tables and inner-joins tabs, so a tab with no linked
 * table is invisible there — required for the visibility checks, needless for the rest.
 */
async function createTab(withTable = false): Promise<{ tabId: string; tableId: string | null }> {
  for (let attempt = 0; attempt < 50; attempt++) {
    const tableNumber = nextTableNumber++

    let tableId: string | null = null
    if (withTable) {
      const { data: tableRow, error: tableError } = await admin
        .from('restaurant_tables')
        .insert({
          restaurant_id: RESTAURANT_ID,
          table_number: tableNumber,
          table_name: `${tag}-t${tableNumber}`,
          active: true,
          status: 'occupied',
        })
        .select('id')
        .single()
      if (tableError?.code === '23505') continue
      if (tableError || !tableRow?.id) throw tableError ?? new Error('table insert failed')
      tableId = String(tableRow.id)
      createdTableIds.push(tableId)
    }

    const { data, error } = await admin
      .from('tabs')
      .insert({
        restaurant_id: RESTAURANT_ID,
        status: 'open',
        total: 0,
        table_number: tableNumber,
        table_id: tableId,
      })
      .select('id')
      .single()

    // A leftover open tab from an interrupted run can still hold a slot: step past it.
    if (error?.code === '23505') continue
    if (error || !data?.id) throw error ?? new Error('tab insert failed')

    createdTabIds.push(String(data.id))
    return { tabId: String(data.id), tableId }
  }
  throw new Error('could not find a free test table number')
}

/** Most checks only need the tab id. */
async function createPlainTab(): Promise<string> {
  return (await createTab()).tabId
}

async function createOrder(
  tabId: string,
  total: number,
  paymentStatus: string,
  paymentMethod: string | null = null,
  terminalPushedAt: string | null = null,
): Promise<string> {
  const { data, error } = await admin
    .from('orders')
    .insert({
      restaurant_id: RESTAURANT_ID,
      tab_id: tabId,
      table_number: 0,
      status: 'pending',
      payment_status: paymentStatus,
      payment_method: paymentMethod,
      terminal_pushed_at: terminalPushedAt,
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

async function settle(
  jwt: string,
  tabId: string,
  body: Record<string, unknown>,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${APP}/api/terminal/tabs/${tabId}/settle`, {
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

async function orderRow(orderId: string) {
  const { data } = await admin
    .from('orders')
    .select('payment_status, payment_method, payment_reference, payment_voucher_no, status, paid_at')
    .eq('id', orderId)
    .single()
  return data as Record<string, unknown> | null
}

async function cleanup() {
  if (createdOrderIds.length) {
    await admin.from('orders').delete().in('id', createdOrderIds)
  }
  if (createdTabIds.length) {
    await admin.from('tabs').delete().in('id', createdTabIds)
  }
  if (createdTableIds.length) {
    await admin.from('restaurant_tables').delete().in('id', createdTableIds)
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

  // ---------- 1: cash settles an ordinary unpaid order ----------
  {
    const tabId = await createPlainTab()
    const orderId = await createOrder(tabId, 42.5, 'pending')
    const res = await settle(jwt, tabId, {
      order_ids: [orderId],
      amount: 42.5,
      method: 'cash',
    })
    record(
      'c1-cash-settles-pending',
      res.status === 200 && res.json.success === true && res.json.method === 'cash',
      `status=${res.status} body=${JSON.stringify(res.json)}`,
    )
    const row = await orderRow(orderId)
    record(
      'c1-order-state',
      row?.payment_status === 'paid' &&
        row?.payment_method === 'cash' &&
        row?.status === 'completed' &&
        Boolean(row?.paid_at),
      `row=${JSON.stringify(row)}`,
    )
    record(
      'c1-no-card-reference',
      row?.payment_voucher_no === null,
      `payment_voucher_no=${JSON.stringify(row?.payment_voucher_no)} (cash must not carry a gateway voucher)`,
    )
  }

  // ---------- 2: cash settles an order parked as cash_pending ----------
  // This is the cancel-terminal path. Before the change the claim skipped these entirely and
  // the endpoint answered "Orders are already paid" for money nobody had collected.
  {
    const tabId = await createPlainTab()
    const orderId = await createOrder(tabId, 30, 'cash_pending', 'cash')
    const res = await settle(jwt, tabId, {
      order_ids: [orderId],
      amount: 30,
      method: 'cash',
    })
    record(
      'c2-cash-settles-cash-pending',
      res.status === 200 && res.json.success === true,
      `status=${res.status} body=${JSON.stringify(res.json)}`,
    )
    const row = await orderRow(orderId)
    record(
      'c2-order-state',
      row?.payment_status === 'paid' && row?.payment_method === 'cash',
      `row=${JSON.stringify(row)}`,
    )
  }

  // ---------- 3: cash settles after a failed card attempt ----------
  {
    const tabId = await createPlainTab()
    const orderId = await createOrder(tabId, 17.25, 'failed', 'card')
    const res = await settle(jwt, tabId, {
      order_ids: [orderId],
      amount: 17.25,
      method: 'cash',
    })
    record(
      'c3-cash-settles-failed',
      res.status === 200 && res.json.success === true,
      `status=${res.status} body=${JSON.stringify(res.json)}`,
    )
    const row = await orderRow(orderId)
    record(
      'c3-order-state',
      row?.payment_status === 'paid' && row?.payment_method === 'cash',
      `row=${JSON.stringify(row)}`,
    )
  }

  // ---------- 4: cash BLOCKED while a card payment is in flight ----------
  {
    const tabId = await createPlainTab()
    // Pushed a moment ago: genuinely live, so cash must be refused.
    const orderId = await createOrder(
      tabId,
      55,
      'terminal_pending',
      'card_terminal',
      new Date().toISOString(),
    )
    const res = await settle(jwt, tabId, {
      order_ids: [orderId],
      amount: 55,
      method: 'cash',
    })
    record(
      'c4-cash-blocked-in-flight',
      res.status === 409 && res.json.code === 'CARD_PAYMENT_IN_FLIGHT',
      `status=${res.status} body=${JSON.stringify(res.json)}`,
    )
    record(
      'c4-countdown-reported',
      Number(res.json.retry_after_seconds) > 0 &&
        Number(res.json.retry_after_seconds) <= 90,
      `retry_after_seconds=${res.json.retry_after_seconds} (terminal needs this to show a countdown)`,
    )
    const row = await orderRow(orderId)
    record(
      'c4-order-untouched',
      row?.payment_status === 'terminal_pending',
      `payment_status=${row?.payment_status} (must not be collected on while the card may still succeed)`,
    )
  }

  // ---------- 5: an already-paid order in the selection is rejected before any write ----------
  // The double-charge guard: expectedAmount used to include paid orders, so the amount check
  // passed and the claim silently skipped them — taking money for an already-paid order.
  {
    const tabId = await createPlainTab()
    const unpaidId = await createOrder(tabId, 120, 'pending')
    const paidId = await createOrder(tabId, 80, 'paid', 'card')
    const res = await settle(jwt, tabId, {
      order_ids: [unpaidId, paidId],
      amount: 200,
      method: 'cash',
    })
    record(
      'c5-rejects-paid-in-selection',
      res.status === 409 && (res.json.code === 'ALREADY_PAID' || res.json.code === 'NOT_SETTLEABLE'),
      `status=${res.status} body=${JSON.stringify(res.json)}`,
    )
    const stillUnpaid = await orderRow(unpaidId)
    record(
      'c5-no-partial-write',
      stillUnpaid?.payment_status === 'pending',
      `unpaid order payment_status=${stillUnpaid?.payment_status} (must be untouched — no committed partial settlement)`,
    )
  }

  // ---------- 6: unsupported method is rejected, never defaulted to card ----------
  {
    const tabId = await createPlainTab()
    const orderId = await createOrder(tabId, 10, 'pending')
    const res = await settle(jwt, tabId, {
      order_ids: [orderId],
      amount: 10,
      method: 'bitcoin',
    })
    record(
      'c6-rejects-unknown-method',
      res.status === 400 && res.json.code === 'UNSUPPORTED_PAYMENT_METHOD',
      `status=${res.status} body=${JSON.stringify(res.json)}`,
    )
    const row = await orderRow(orderId)
    record(
      'c6-order-untouched',
      row?.payment_status === 'pending',
      `payment_status=${row?.payment_status}`,
    )
  }

  // ---------- 7: method is normalised, not taken at face value ----------
  {
    const tabId = await createPlainTab()
    const orderId = await createOrder(tabId, 12, 'pending')
    const res = await settle(jwt, tabId, {
      order_ids: [orderId],
      amount: 12,
      method: 'CASH',
    })
    const row = await orderRow(orderId)
    record(
      'c7-method-normalised',
      res.status === 200 && row?.payment_method === 'cash',
      `status=${res.status} payment_method=${JSON.stringify(row?.payment_method)} (byte-exact 'cash' or the dashboards read it as card)`,
    )
  }

  // ---------- 8: cash settlement is attributable in the audit trail ----------
  {
    const tabId = await createPlainTab()
    const orderId = await createOrder(tabId, 64, 'pending')
    const res = await settle(jwt, tabId, {
      order_ids: [orderId],
      amount: 64,
      method: 'cash',
    })
    const { data: logs } = await admin
      .from('audit_logs')
      .select('action, entity_id, metadata, created_at')
      .eq('restaurant_id', RESTAURANT_ID)
      .eq('entity_id', tabId)
      .order('created_at', { ascending: false })
      .limit(1)
    const log = (logs ?? [])[0] as Record<string, any> | undefined
    const meta = (log?.metadata ?? {}) as Record<string, unknown>
    record(
      'c8-audit-written',
      res.status === 200 && log?.action === 'payment.tab_settled_cash',
      `action=${log?.action}`,
    )
    record(
      'c8-audit-content',
      meta.method === 'cash' &&
        meta.terminal_id === terminal.id &&
        Boolean(meta.settled_at) &&
        meta.actor_attribution === 'terminal_only' &&
        meta.staff_user_id === null,
      `metadata=${JSON.stringify(meta)} (unattributed settle must SAY so, not omit the field)`,
    )
  }

  // ---------- 9: a bad authorization token never settles the orders ----------
  {
    const tabId = await createPlainTab()
    const orderId = await createOrder(tabId, 21, 'pending')
    const res = await settle(jwt, tabId, {
      order_ids: [orderId],
      amount: 21,
      method: 'cash',
      staff_user_id: '00000000-0000-4000-8000-000000000000',
      authorization_token_id: '00000000-0000-4000-8000-000000000001',
    })
    record(
      'c9-bad-token-rejected',
      res.status === 403 && res.json.code === 'AUTHORIZATION_INVALID',
      `status=${res.status} body=${JSON.stringify(res.json)}`,
    )
    const row = await orderRow(orderId)
    record(
      'c9-order-untouched',
      row?.payment_status === 'pending',
      `payment_status=${row?.payment_status} (money must not move on an unverifiable attribution)`,
    )
  }

  // ---------- 10: unpaid orders that owe money are visible to the terminal ----------
  // Without this the cash path is unreachable: staff cannot select what they cannot see, and
  // can_close would report a table settled while it still owed money.
  {
    const { tabId } = await createTab(true)
    await createOrder(tabId, 25, 'cash_pending', 'cash')
    await createOrder(tabId, 35, 'failed', 'card')
    const res = await fetch(`${APP}/api/terminal/tables`, {
      headers: { Authorization: `Bearer ${jwt}` },
    })
    const json = (await res.json().catch(() => ({}))) as Record<string, any>
    const tables = (json.tables ?? []) as Array<Record<string, any>>
    const mine = tables.find((t) => String(t?.tab?.id) === tabId)
    const mineOrders = (mine?.tab?.orders ?? []) as Array<Record<string, any>>
    record(
      'c10-tab-visible',
      Boolean(mine) && mineOrders.length === 2,
      `found=${Boolean(mine)} orders=${mineOrders.length} (setup guard — the rest is vacuous without this)`,
    )
    record(
      'c10-owed-money-visible',
      Math.abs(Number(mine?.tab?.unpaid_total) - 60) < 0.01,
      `unpaid_total=${mine?.tab?.unpaid_total} expected=60 (cash_pending + failed both owe)`,
    )
    record(
      'c10-cannot-close-with-debt',
      mine?.can_close === false,
      `can_close=${mine?.can_close} (must not report settled while money is owed)`,
    )
    record(
      'c10-cash-affordance',
      mineOrders.length === 2 && mineOrders.every((o) => o.can_settle_cash === true),
      `orders=${JSON.stringify(mineOrders.map((o) => ({ ps: o.payment_status, cash: o.can_settle_cash })))}`,
    )
  }

  // ---------- 11: card settlement behaviour is unchanged ----------
  {
    const tabId = await createPlainTab()
    const orderId = await createOrder(tabId, 90, 'pending')
    const res = await settle(jwt, tabId, {
      order_ids: [orderId],
      amount: 90,
      method: 'card',
      gateway_reference: `${tag}-gw`,
    })
    const row = await orderRow(orderId)
    record(
      'c11-card-unchanged',
      res.status === 200 && row?.payment_status === 'paid' && row?.payment_method === 'card',
      `status=${res.status} row=${JSON.stringify(row)}`,
    )
    record(
      'c11-card-keeps-reference',
      row?.payment_voucher_no === `${tag}-gw`,
      `payment_voucher_no=${JSON.stringify(row?.payment_voucher_no)} (card must still carry its gateway reference)`,
    )
  }

  // ---------- 12: card may NOT claim a cash_pending order ----------
  // Card's narrower set is deliberately unchanged; only cash was widened.
  {
    const tabId = await createPlainTab()
    const orderId = await createOrder(tabId, 15, 'cash_pending', 'cash')
    const res = await settle(jwt, tabId, {
      order_ids: [orderId],
      amount: 15,
      method: 'card',
    })
    record(
      'c12-card-set-unchanged',
      res.status === 409 && res.json.code === 'NOT_SETTLEABLE',
      `status=${res.status} body=${JSON.stringify(res.json)}`,
    )
  }

  // ---------- 13: an authorized cash settlement names the staff member, single-use ----------
  {
    const { data: member } = await admin
      .from('restaurant_users')
      .select('user_id')
      .eq('restaurant_id', RESTAURANT_ID)
      .is('deleted_at', null)
      .limit(1)
      .maybeSingle()

    const staffUserId = member?.user_id ? String(member.user_id) : null
    if (!staffUserId) {
      record('c13-attribution', false, 'no restaurant_users member on staging to attribute to')
    } else {
      const { data: token, error: tokenError } = await admin
        .from('privileged_authorization_tokens')
        .insert({
          user_id: staffUserId,
          restaurant_id: RESTAURANT_ID,
          terminal_id: terminal.id,
          purpose: 'cash_settlement',
          nonce: `${tag}-nonce`,
          ttl_seconds: 300,
          expires_at: new Date(Date.now() + 300_000).toISOString(),
        })
        .select('id')
        .single()
      if (tokenError || !token?.id) throw tokenError ?? new Error('token insert failed')
      const tokenId = String(token.id)

      const tabId = await createPlainTab()
      const orderId = await createOrder(tabId, 48, 'pending')
      const res = await settle(jwt, tabId, {
        order_ids: [orderId],
        amount: 48,
        method: 'cash',
        staff_user_id: staffUserId,
        authorization_token_id: tokenId,
      })
      record(
        'c13-authorized-settle',
        res.status === 200 && res.json.staff_user_id === staffUserId,
        `status=${res.status} body=${JSON.stringify(res.json)}`,
      )

      const { data: logs } = await admin
        .from('audit_logs')
        .select('action, metadata')
        .eq('restaurant_id', RESTAURANT_ID)
        .eq('entity_id', tabId)
        .order('created_at', { ascending: false })
        .limit(1)
      const meta = ((logs ?? [])[0]?.metadata ?? {}) as Record<string, unknown>
      record(
        'c13-audit-names-staff',
        meta.staff_user_id === staffUserId &&
          meta.actor_attribution === 'staff_authorized' &&
          meta.authorization_token_id === tokenId,
        `metadata=${JSON.stringify(meta)}`,
      )

      // Single-use: a replayed token must not authorize a second cash settlement.
      const tab2 = await createPlainTab()
      const order2 = await createOrder(tab2, 48, 'pending')
      const replay = await settle(jwt, tab2, {
        order_ids: [order2],
        amount: 48,
        method: 'cash',
        staff_user_id: staffUserId,
        authorization_token_id: tokenId,
      })
      record(
        'c13-token-single-use',
        replay.status === 403 && replay.json.code === 'AUTHORIZATION_INVALID',
        `status=${replay.status} body=${JSON.stringify(replay.json)}`,
      )
      const replayRow = await orderRow(order2)
      record(
        'c13-replay-order-untouched',
        replayRow?.payment_status === 'pending',
        `payment_status=${replayRow?.payment_status}`,
      )

      await admin.from('privileged_authorization_tokens').delete().eq('id', tokenId)
    }
  }

  // ---------- 14: the timeout fires — a stuck attempt stops blocking cash ----------
  {
    const tabId = await createPlainTab()
    const orderId = await createOrder(
      tabId,
      70,
      'terminal_pending',
      'card_terminal',
      new Date(Date.now() - 91_000).toISOString(),
    )
    const res = await settle(jwt, tabId, {
      order_ids: [orderId],
      amount: 70,
      method: 'cash',
    })
    record(
      'c14-timeout-releases-cash',
      res.status === 200 && res.json.success === true,
      `status=${res.status} body=${JSON.stringify(res.json)}`,
    )
    const row = await orderRow(orderId)
    record(
      'c14-order-settled-as-cash',
      row?.payment_status === 'paid' && row?.payment_method === 'cash',
      `row=${JSON.stringify(row)}`,
    )

    const { data: logs } = await admin
      .from('audit_logs')
      .select('metadata')
      .eq('restaurant_id', RESTAURANT_ID)
      .eq('entity_id', tabId)
      .order('created_at', { ascending: false })
      .limit(1)
    const meta = ((logs ?? [])[0]?.metadata ?? {}) as Record<string, any>
    record(
      'c14-audit-records-stuck-duration',
      Array.isArray(meta.card_in_flight_seconds) &&
        Number(meta.card_in_flight_seconds[0]) >= 90 &&
        Number(meta.card_in_flight_timeout_seconds) === 90,
      `card_in_flight_seconds=${JSON.stringify(meta.card_in_flight_seconds)} timeout=${meta.card_in_flight_timeout_seconds} (evidence for retuning the window)`,
    )
  }

  // ---------- 15: the boundary — just inside the window is still blocked ----------
  {
    const tabId = await createPlainTab()
    const orderId = await createOrder(
      tabId,
      33,
      'terminal_pending',
      'card_terminal',
      new Date(Date.now() - 85_000).toISOString(),
    )
    const res = await settle(jwt, tabId, {
      order_ids: [orderId],
      amount: 33,
      method: 'cash',
    })
    record(
      'c15-just-inside-still-blocked',
      res.status === 409 && res.json.code === 'CARD_PAYMENT_IN_FLIGHT',
      `status=${res.status} code=${res.json.code} (85s of a 90s window)`,
    )
  }

  // ---------- 16: a legacy row with no push time is not blocked forever ----------
  {
    const tabId = await createPlainTab()
    const orderId = await createOrder(tabId, 44, 'terminal_pending', 'card_terminal', null)
    const res = await settle(jwt, tabId, {
      order_ids: [orderId],
      amount: 44,
      method: 'cash',
    })
    record(
      'c16-null-push-time-settles',
      res.status === 200 && res.json.success === true,
      `status=${res.status} body=${JSON.stringify(res.json)} (predates the column — must not strand)`,
    )
  }

  // ---------- 17: the terminal payload flips the cash affordance at the timeout ----------
  {
    const { tabId } = await createTab(true)
    const liveId = await createOrder(
      tabId, 20, 'terminal_pending', 'card_terminal', new Date().toISOString(),
    )
    const staleId = await createOrder(
      tabId, 20, 'terminal_pending', 'card_terminal', new Date(Date.now() - 120_000).toISOString(),
    )
    const res = await fetch(`${APP}/api/terminal/tables`, {
      headers: { Authorization: `Bearer ${jwt}` },
    })
    const json = (await res.json().catch(() => ({}))) as Record<string, any>
    const mine = ((json.tables ?? []) as Array<Record<string, any>>).find(
      (t) => String(t?.tab?.id) === tabId,
    )
    const byId = new Map(
      ((mine?.tab?.orders ?? []) as Array<Record<string, any>>).map((o) => [String(o.id), o]),
    )
    const live = byId.get(liveId)
    const stale = byId.get(staleId)
    record(
      'c17-live-blocks-cash-button',
      live?.can_settle_cash === false && live?.card_payment_in_flight === true,
      `live=${JSON.stringify({ cash: live?.can_settle_cash, inflight: live?.card_payment_in_flight, secs: live?.card_in_flight_seconds })}`,
    )
    record(
      'c17-stale-enables-cash-button',
      stale?.can_settle_cash === true && stale?.card_payment_in_flight === false,
      `stale=${JSON.stringify({ cash: stale?.can_settle_cash, inflight: stale?.card_payment_in_flight })}`,
    )
    record(
      'c17-timeout-published',
      Number(json.card_in_flight_timeout_seconds) === 90,
      `card_in_flight_timeout_seconds=${json.card_in_flight_timeout_seconds}`,
    )
    record(
      'c17-both-still-owe-money',
      Math.abs(Number(mine?.tab?.unpaid_total) - 40) < 0.01 && mine?.can_close === false,
      `unpaid_total=${mine?.tab?.unpaid_total} can_close=${mine?.can_close} (in-flight money is still owed)`,
    )
  }
}

main()
  .then(async () => {
    await cleanup()
    if (failures > 0) {
      console.log(`\n${failures} check(s) FAILED`)
      process.exit(1)
    }
    console.log('\nAll cash settlement checks passed')
  })
  .catch(async (err) => {
    console.error(err)
    await cleanup()
    process.exit(1)
  })
