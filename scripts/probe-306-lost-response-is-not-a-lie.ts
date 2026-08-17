/**
 * #306 — a lost response must not be reported as "nothing was saved".
 *
 * The edit route is replay-safe: the lock token is spent by the commit, so a byte-identical retry
 * writes nothing. What it is not is HONEST. The retry is answered with
 * `EDIT_COPY.lockExpired` — *"That took too long, so nothing was saved"* — when the write landed.
 * A customer who believes it re-applies the change and is charged twice, and because an addition
 * raises the total, each duplicate flips the order back to `pending` for a fresh staff review.
 *
 * THIS PROBE MODELS THE CUSTOMER'S DECISION FROM THE SERVER'S OWN WORDS, which is the only way the
 * sequence reproduces in a script: a human does not double-add because of a status code, they do
 * it because they were told nothing happened. So the simulated customer reads the refusal and
 * re-applies only if it says nothing was saved. Before the fix that branch is taken and the item
 * is charged twice; after it, the customer is told the truth and stops.
 *
 * Run against the SHA that predates the fix and STEP 1 and STEP 2 fail. Exits 1 while any check
 * fails, so it is a failing-first proof rather than a report.
 *
 *   STEP 1  a retry after a landed save is told the truth, and handed the current order
 *   STEP 2  the customer who reads that message does NOT double-charge
 *   STEP 3  POSITIVE CONTROL — a genuinely expired lock still says the lock expired
 *   STEP 4  POSITIVE CONTROL — an ordinary save still succeeds and still returns its notice
 *
 * Seeds and tears down its own fixture in table range 9200-9599.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { randomUUID } from 'crypto'

const RID = 'a1999166-ddfa-40d1-ad1f-2f01282a1652'
const STAGING_REF = 'mdqjpxwczrhkxkbqatqa'
const BASE = process.env.QR_SIM_BASE || 'https://flashtap-staging.llosperofficial.workers.dev'

const url = process.env.SUPABASE_URL || ''
if (!url.includes(STAGING_REF)) throw new Error(`REFUSING: not the staging project: ${url}`)
const db: SupabaseClient = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY || '', {
  auth: { persistSession: false, autoRefreshToken: false },
})

const r2 = (n: number) => Math.round(n * 100) / 100
const inc = (p: number) => {
  const total = r2(p)
  const subtotal = r2(total / 1.15)
  return { total, subtotal, tax: r2(total - subtotal) }
}

type Res = { status: number; text: string; json: any }
async function api(path: string, init: RequestInit = {}): Promise<Res> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init.headers || {}) },
  })
  const text = await res.text()
  let json: any = {}
  try {
    json = JSON.parse(text)
  } catch {
    /* non-JSON body is fine */
  }
  return { status: res.status, text, json }
}

const failures: string[] = []
function check(step: string, ok: boolean, detail: string) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${step}  ${detail}`)
  if (!ok) failures.push(step.trim())
}

type Fixture = Awaited<ReturnType<typeof seed>>

async function seed(label: string) {
  const tn = 9200 + Math.floor(Math.random() * 390)
  const { data: tbl } = await db
    .from('restaurant_tables')
    .insert({ restaurant_id: RID, table_number: tn, active: true, is_view_only: false, is_kiosk: false, status: 'occupied' })
    .select('id, current_session_version')
    .single()

  const sid = `probe-306-${label}-${randomUUID()}`
  const tok = randomUUID()

  const { data: tab } = await db
    .from('tabs')
    .insert({
      restaurant_id: RID, table_id: tbl!.id, table_number: tn, status: 'open',
      session_token: tok, members: [{ session_id: sid, display_name: 'Diner' }], total: 0,
    })
    .select('id')
    .single()

  await db.from('customer_sessions').insert({
    token: tok, tab_id: tab!.id, table_id: tbl!.id, restaurant_id: RID,
    session_version: tbl!.current_session_version ?? 1, active: true,
    expires_at: new Date(Date.now() + 864e5).toISOString(),
  })

  const { data: mis } = await db
    .from('menu_items')
    .select('id, name, base_price')
    .eq('restaurant_id', RID)
    .eq('status', 'available')
    .eq('track_inventory', false)
    .not('category_id', 'is', null)
    .limit(2)

  const m = inc(Number(mis![0].base_price))
  const { data: ord } = await db
    .from('orders')
    .insert({
      restaurant_id: RID, tab_id: tab!.id, table_id: tbl!.id, table_number: tn,
      session_id: sid, member_session_id: sid, channel: 'table',
      status: 'accepted', payment_status: 'pending',
      items: [{
        name: mis![0].name, displayName: mis![0].name, menuItemId: mis![0].id, quantity: 1,
        unitPrice: r2(Number(mis![0].base_price)), basePrice: r2(Number(mis![0].base_price)),
        subtotal: m.subtotal, tax: m.tax, total: m.total,
        taxRatePercentage: 15, taxInclusive: true,
        selectedVariants: {}, size: null, addons: [], specialInstructions: '',
      }],
      subtotal: m.subtotal, tax: m.tax, total: m.total, placed_at: new Date().toISOString(),
    })
    .select('id')
    .single()

  return { tbl: tbl!, tab: tab!, sid, tok, mis: mis!, ord: ord! , tn }
}

async function teardown(f: Fixture) {
  await db.from('payments').delete().eq('tab_id', f.tab.id)
  await db.from('orders').delete().eq('tab_id', f.tab.id)
  await db.from('order_requests').delete().eq('tab_id', f.tab.id)
  await db.from('customer_sessions').delete().eq('tab_id', f.tab.id)
  await db.from('tabs').delete().eq('id', f.tab.id)
  await db.from('restaurant_tables').delete().eq('id', f.tbl.id)
}

const addLine = (mi: any, qty: number) => ({
  menuItemId: mi.id, name: mi.name, displayName: mi.name, quantity: qty,
  basePrice: Number(mi.base_price), subtotal: Number(mi.base_price) * qty,
  selectedVariants: {}, size: null, addons: [], specialInstructions: '',
})

async function row(id: string) {
  const { data } = await db
    .from('orders')
    .select('items, total, customer_edit_count, status')
    .eq('id', id)
    .single()
  return data as any
}

/** Did the server tell the customer that nothing was saved? This is what drives a human retry. */
const saysNothingWasSaved = (res: Res) =>
  /nothing was saved/i.test(String(res.json?.error ?? ''))

async function main() {
  console.log(`=== #306 probe against ${BASE} ===`)
  const version = await api('/api/version?cb=' + Math.floor(Math.random() * 1e9))
  console.log(`served commit: ${version.json?.commit ?? 'unknown'}\n`)

  // ---------------------------------------------------------------- STEPS 1 & 2
  const f = await seed('lost')
  try {
    const H = { 'x-session-token': f.tok }
    const lock = await api(`/api/guest/orders/${f.ord.id}/edit`, {
      method: 'POST', headers: H,
      body: JSON.stringify({ restaurantId: RID, sessionIds: [f.sid] }),
    })
    const body = JSON.stringify({
      restaurantId: RID, sessionIds: [f.sid], lockToken: lock.json.lockToken,
      keep: [{ index: 0, quantity: 1 }], add: [addLine(f.mis[1], 1)],
    })

    // The save LANDS. Its response is discarded -- this is the lost response.
    const landed = await api(`/api/guest/orders/${f.ord.id}/edit`, { method: 'PATCH', headers: H, body })
    const afterSave = await row(f.ord.id)
    console.log(`  (save landed: HTTP ${landed.status}, order now ${afterSave.items.length} line(s), total ${afterSave.total})`)

    // The client resends the identical request, exactly as it would after a dropped response.
    const retry = await api(`/api/guest/orders/${f.ord.id}/edit`, { method: 'PATCH', headers: H, body })

    check(
      'step 1 the retry is told the truth      ',
      !saysNothingWasSaved(retry),
      `HTTP ${retry.status} reason=${retry.json?.reason} :: "${String(retry.json?.error ?? '').slice(0, 62)}"`,
    )
    const handedOrder = Array.isArray(retry.json?.items) && retry.json.items.length === afterSave.items.length
    check(
      'step 1b and handed the current order    ',
      handedOrder,
      handedOrder ? `${retry.json.items.length} line(s), total ${retry.json?.total}` : 'no items returned',
    )

    /**
     * STEP 2 -- the customer, deciding from what they were just told. This is the double charge.
     * Before the fix the message says nothing was saved, so they reopen and add it again.
     */
    if (saysNothingWasSaved(retry)) {
      const reopen = await api(`/api/guest/orders/${f.ord.id}/edit`, {
        method: 'POST', headers: H,
        body: JSON.stringify({ restaurantId: RID, sessionIds: [f.sid] }),
      })
      await api(`/api/guest/orders/${f.ord.id}/edit`, {
        method: 'PATCH', headers: H,
        body: JSON.stringify({
          restaurantId: RID, sessionIds: [f.sid], lockToken: reopen.json.lockToken,
          keep: (reopen.json.items ?? []).map((it: any, i: number) => ({ index: i, quantity: it.quantity })),
          add: [addLine(f.mis[1], 1)],
        }),
      })
    }

    const final = await row(f.ord.id)
    const timesCharged = (final.items as any[]).filter((i) => i.menuItemId === f.mis[1].id).length
    check(
      'step 2 the item is charged exactly once ',
      timesCharged === 1,
      `charged ${timesCharged}x, order total ${final.total}, edit_count ${final.customer_edit_count}`,
    )
  } finally {
    await teardown(f)
  }

  // ---------------------------------------------------------------- STEP 3
  /**
   * POSITIVE CONTROL. A lock that genuinely expired with nothing committed must STILL say the
   * lock expired. Without this, "never say nothing was saved" could be satisfied by deleting the
   * honest message too -- the same shape as a security check with no legitimate-user assertion.
   */
  const g = await seed('expired')
  try {
    const H = { 'x-session-token': g.tok }
    const lock = await api(`/api/guest/orders/${g.ord.id}/edit`, {
      method: 'POST', headers: H,
      body: JSON.stringify({ restaurantId: RID, sessionIds: [g.sid] }),
    })
    // Expire it in place: the token STAYS (that is what distinguishes expiry from a commit,
    // which nulls it), and nothing has been committed.
    await db
      .from('orders')
      .update({ edit_lock_expires_at: new Date(Date.now() - 60_000).toISOString() })
      .eq('id', g.ord.id)

    const late = await api(`/api/guest/orders/${g.ord.id}/edit`, {
      method: 'PATCH', headers: H,
      body: JSON.stringify({
        restaurantId: RID, sessionIds: [g.sid], lockToken: lock.json.lockToken,
        keep: [{ index: 0, quantity: 1 }], add: [addLine(g.mis[1], 1)],
      }),
    })
    const after = await row(g.ord.id)
    check(
      'step 3 a real expiry still says expired ',
      saysNothingWasSaved(late) && late.status === 409 && after.items.length === 1,
      `HTTP ${late.status} reason=${late.json?.reason} :: "${String(late.json?.error ?? '').slice(0, 52)}"`,
    )
  } finally {
    await teardown(g)
  }

  // ---------------------------------------------------------------- STEP 4
  /** POSITIVE CONTROL. The ordinary save must be untouched by any of this. */
  const h = await seed('happy')
  try {
    const H = { 'x-session-token': h.tok }
    const lock = await api(`/api/guest/orders/${h.ord.id}/edit`, {
      method: 'POST', headers: H,
      body: JSON.stringify({ restaurantId: RID, sessionIds: [h.sid] }),
    })
    const ok = await api(`/api/guest/orders/${h.ord.id}/edit`, {
      method: 'PATCH', headers: H,
      body: JSON.stringify({
        restaurantId: RID, sessionIds: [h.sid], lockToken: lock.json.lockToken,
        keep: [{ index: 0, quantity: 1 }], add: [addLine(h.mis[1], 1)],
      }),
    })
    const after = await row(h.ord.id)
    check(
      'step 4 an ordinary save still succeeds  ',
      ok.status === 200 && after.items.length === 2 && Boolean(ok.json?.message),
      `HTTP ${ok.status}, ${after.items.length} line(s), message=${Boolean(ok.json?.message)}`,
    )
  } finally {
    await teardown(h)
  }

  console.log('\ncleaned')
  if (failures.length) {
    console.log(`\n${failures.length} check(s) FAILED — ${failures.join('; ')}`)
    process.exitCode = 1
  } else {
    console.log('\nall checks passed')
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
