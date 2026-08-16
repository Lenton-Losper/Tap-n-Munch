/**
 * #302 — the five-step takeover chain, as a check that can FAIL.
 *
 * Run against the SHA that predates the fix and every step succeeds: that is the attack working.
 * Run against the fix and steps 2-5 must be refused while step 1 still passes, because a diner at
 * the same table is *supposed* to see the shared order — removing that would be a product change,
 * not a security fix.
 *
 *   1. same-table diner can still SEE the shared order            (must keep PASSING)
 *   2. cannot obtain a usable mutation credential for it          (session_id must not leak)
 *   3. cannot acquire its edit lock
 *   4. cannot add or replace lines
 *   5. a stale/closed table session is refused on edit exactly as it already is on POST /api/orders
 *
 * Every step prints ATTACK-SUCCEEDS or REFUSED. The script exits 1 when the chain is open, so it
 * is a failing-first proof rather than a report.
 *
 * Read-only against the app; seeds and tears down its own fixture in table range 9200-9599.
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
    /* non-JSON body is fine; `text` is what the assertions read */
  }
  return { status: res.status, text, json }
}

const results: Array<{ step: string; open: boolean; detail: string }> = []
function record(step: string, open: boolean, detail: string) {
  results.push({ step, open, detail })
  console.log(`  ${open ? 'ATTACK-SUCCEEDS' : 'REFUSED       '}  ${step}  ${detail}`)
}

async function main() {
  console.log(`=== #302 chain against ${BASE} ===`)
  const version = await api('/api/version?cb=' + Math.floor(Math.random() * 1e9))
  console.log(`served commit: ${version.json?.commit ?? 'unknown'}\n`)

  const tn = 9200 + Math.floor(Math.random() * 390)
  const { data: tbl } = await db
    .from('restaurant_tables')
    .insert({ restaurant_id: RID, table_number: tn, active: true, is_view_only: false, is_kiosk: false, status: 'occupied' })
    .select('id, current_session_version')
    .single()

  const victim = `probe-victim-${randomUUID()}`
  const attacker = `probe-attacker-${randomUUID()}`
  const victimTok = randomUUID()
  const attackerTok = randomUUID()

  const { data: tab } = await db
    .from('tabs')
    .insert({
      restaurant_id: RID,
      table_id: tbl!.id,
      table_number: tn,
      status: 'open',
      session_token: victimTok,
      members: [
        { session_id: victim, display_name: 'Victim' },
        { session_id: attacker, display_name: 'Attacker' },
      ],
      total: 0,
    })
    .select('id')
    .single()

  for (const t of [victimTok, attackerTok]) {
    await db.from('customer_sessions').insert({
      token: t,
      tab_id: tab!.id,
      table_id: tbl!.id,
      restaurant_id: RID,
      session_version: tbl!.current_session_version ?? 1,
      active: true,
      expires_at: new Date(Date.now() + 864e5).toISOString(),
    })
  }

  const { data: mi } = await db
    .from('menu_items')
    .select('id, name, base_price')
    .eq('restaurant_id', RID)
    .eq('status', 'available')
    .eq('track_inventory', false)
    .not('category_id', 'is', null)
    .limit(1)
    .single()

  const money = inc(95)
  const { data: ord } = await db
    .from('orders')
    .insert({
      restaurant_id: RID,
      tab_id: tab!.id,
      table_id: tbl!.id,
      table_number: tn,
      session_id: victim,
      member_session_id: victim,
      channel: 'table',
      status: 'accepted',
      payment_status: 'pending',
      items: [
        {
          name: 'Beef Burger',
          displayName: 'Beef Burger',
          menuItemId: mi!.id,
          quantity: 1,
          unitPrice: 95,
          basePrice: 95,
          subtotal: money.subtotal,
          tax: money.tax,
          total: money.total,
          taxRatePercentage: 15,
          taxInclusive: true,
          selectedVariants: {},
          size: null,
          addons: [],
          specialInstructions: '',
        },
      ],
      subtotal: money.subtotal,
      tax: money.tax,
      total: money.total,
      placed_at: new Date().toISOString(),
    })
    .select('id')
    .single()

  try {
    // STEP 1 — the attacker joined the tab legitimately and may SEE the order. This must keep
    // passing after the fix; hiding it would be a product change, not a security fix.
    const shared = await api(
      `/api/tabs/${tab!.id}/orders?restaurantId=${RID}&session_id=${encodeURIComponent(attacker)}`,
      { headers: { 'x-session-token': attackerTok } },
    )
    const canSee = shared.status === 200 && shared.text.includes(ord!.id)
    console.log(`  ${canSee ? 'OK            ' : 'BROKEN        '}  step 1 SEE the shared order  HTTP ${shared.status}`)
    if (!canSee) {
      console.log('  *** step 1 must PASS. A same-table diner is supposed to see this. ***')
      process.exitCode = 1
    }

    /**
     * STEP 1b — THE POSITIVE CONTROL, and the check whose absence let a regression through.
     *
     * The first version of this chain proved only that the ATTACKER was refused. It went all
     * green while the app's own client could no longer edit at all: `editRequest` in
     * lib/guest-orders/client.ts sent no `x-session-token`, so requiring one locked out every
     * legitimate customer on a tab. A security check that cannot tell "the attack is closed"
     * from "the feature is dead" is not a security check.
     */
    const ownerLock = await api(`/api/guest/orders/${ord!.id}/edit`, {
      method: 'POST',
      headers: { 'x-session-token': victimTok },
      body: JSON.stringify({ restaurantId: RID, sessionIds: [victim] }),
    })
    let ownerCanEdit = ownerLock.status === 200
    if (ownerCanEdit) {
      const ownerPatch = await api(`/api/guest/orders/${ord!.id}/edit`, {
        method: 'PATCH',
        headers: { 'x-session-token': victimTok },
        body: JSON.stringify({
          restaurantId: RID,
          sessionIds: [victim],
          lockToken: ownerLock.json.lockToken,
          orderInstructions: 'owner control',
        }),
      })
      ownerCanEdit = ownerPatch.status === 200
      console.log(`  ${ownerCanEdit ? 'OK            ' : 'BROKEN        '}  step 1b OWNER can still edit  lock=${ownerLock.status} patch=${ownerPatch.status}`)
    } else {
      console.log(`  BROKEN          step 1b OWNER can still edit  lock=${ownerLock.status}`)
    }
    if (!ownerCanEdit) {
      console.log('  *** step 1b must PASS. Refusing the owner is a lockout, not a fix. ***')
      process.exitCode = 1
    }

    // STEP 2 — can the attacker obtain a usable mutation credential?
    const read = await api(
      `/api/guest/orders/${ord!.id}?restaurantId=${RID}&table_number=${tn}&session_id=${encodeURIComponent(attacker)}`,
    )
    const leaked = read.text.includes(victim)
    record('step 2 OBTAIN the victim session_id', leaked, `HTTP ${read.status}, leaked=${leaked}`)

    // The attacker uses whatever they got. If nothing leaked they can still try their own id --
    // steps 3 and 4 must refuse that too, or the fix is only hiding the credential.
    const credential = leaked ? victim : attacker

    // STEP 3 — the edit lock.
    const lock = await api(`/api/guest/orders/${ord!.id}/edit`, {
      method: 'POST',
      body: JSON.stringify({ restaurantId: RID, sessionIds: [credential] }),
    })
    record('step 3 ACQUIRE the edit lock      ', lock.status === 200, `HTTP ${lock.status}`)

    // STEP 4 — replace the victim's lines.
    if (lock.status === 200) {
      const swap = await api(`/api/guest/orders/${ord!.id}/edit`, {
        method: 'PATCH',
        body: JSON.stringify({
          restaurantId: RID,
          sessionIds: [credential],
          lockToken: lock.json.lockToken,
          keep: [],
          add: [
            {
              menuItemId: mi!.id,
              name: mi!.name,
              displayName: mi!.name,
              quantity: 1,
              basePrice: mi!.base_price,
              subtotal: mi!.base_price,
              selectedVariants: {},
              size: null,
              addons: [],
              specialInstructions: '',
            },
          ],
        }),
      })
      const { data: after } = await db.from('orders').select('items, total').eq('id', ord!.id).single()
      const lines = Array.isArray(after?.items) ? (after!.items as unknown[]).length : 0
      record('step 4 REPLACE the victim lines  ', swap.status === 200, `HTTP ${swap.status}, order now ${lines} line(s), total ${after?.total}`)
    } else {
      record('step 4 REPLACE the victim lines  ', false, 'not attempted - no lock')
    }

    // STEP 5 — a closed table session must be refused on edit exactly as on POST /api/orders.
    await db.rpc('close_table_session', { p_table_id: tbl!.id, p_restaurant_id: RID })
    const post = await api('/api/orders', {
      method: 'POST',
      headers: { 'x-session-token': victimTok },
      body: JSON.stringify({
        restaurantId: RID, tableNumber: tn, sessionId: victim, tabId: tab!.id, memberSessionId: victim,
        items: [{ menuItemId: mi!.id, name: mi!.name, displayName: mi!.name, quantity: 1, basePrice: mi!.base_price, selectedVariants: {}, size: null, addons: [], specialInstructions: '', subtotal: mi!.base_price }],
        subtotal: 0, total: 0, orderInstructions: '',
      }),
    })
    const lock5 = await api(`/api/guest/orders/${ord!.id}/edit`, {
      method: 'POST',
      headers: { 'x-session-token': victimTok },
      body: JSON.stringify({ restaurantId: RID, sessionIds: [victim] }),
    })
    record(
      'step 5 EDIT after close_table_session',
      lock5.status === 200,
      `POST /api/orders=${post.status} (the standard), edit lock=${lock5.status}`,
    )
  } finally {
    const { data: os } = await db.from('orders').select('id').eq('tab_id', tab!.id)
    for (const o of os ?? []) await db.from('orders').delete().eq('id', o.id)
    await db.from('order_requests').delete().eq('tab_id', tab!.id)
    await db.from('payments').delete().eq('tab_id', tab!.id)
    await db.from('customer_sessions').delete().eq('tab_id', tab!.id)
    await db.from('tabs').delete().eq('id', tab!.id)
    await db.from('restaurant_tables').delete().eq('id', tbl!.id)
    console.log('\ncleaned')
  }

  const open = results.filter((r) => r.open)
  console.log(`\n${open.length} of ${results.length} attack steps still open`)
  if (open.length > 0) {
    console.log('CHAIN OPEN — ' + open.map((o) => o.step.trim()).join('; '))
    process.exitCode = 1
  } else {
    console.log('CHAIN CLOSED')
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
