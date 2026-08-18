/**
 * Fixtures for the browser suite: seed a real table / tab / order on STAGING, hand a browser
 * context the storage a real customer would hold, then tear it all down.
 *
 * WHY THIS EXISTS AT ALL. Playwright 1.61.1 has been installed in this repo, configured against
 * staging, with three specs in `tests/e2e/`, throughout the whole QR redesign build -- and every
 * proof written in that time was an API fetch, tsc, jest, or a source scan. Four customer-facing
 * defects were found by a human on a phone because none of those instruments can see a rendered
 * screen. This is the instrument that can.
 *
 * SAFETY, in order of how much it would cost to get wrong:
 *
 *   1. STAGING ONLY. `assertStagingDb` refuses any project ref but mdqjpxwczrhkxkbqatqa. The
 *      repo's own `.env.local` points at PRODUCTION (ihlmmpmolnpchzgwyhgh), so a harness that
 *      trusted whatever env it found would drive an automated browser against the live database.
 *   2. FIXTURE RANGE. Tables are seeded in 9200-9599, the range the operating contract reserves
 *      and the cleanup queries target. Never a real table.
 *   3. `probe-` PREFIX on every session id, so debris is greppable if a run dies.
 *   4. Teardown DISCOVERS dependents and deletes `payments` -- the simulation's cleanup did not,
 *      and 35 rows accumulated behind an FK until a tab delete failed and left 20 fixture tables
 *      in the live staging menu.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import type { BrowserContext } from '@playwright/test'
import { randomUUID } from 'crypto'

export const STAGING_REF = 'mdqjpxwczrhkxkbqatqa'
export const PRODUCTION_REF = 'ihlmmpmolnpchzgwyhgh'
export const FIXTURE_RESTAURANT = 'a1999166-ddfa-40d1-ad1f-2f01282a1652'
/**
 * Fixture menu items MUST carry a category.
 *
 * The browse screen renders items grouped by `menu_categories`; an item with a null
 * `category_id` is in the database, is returned by the menu API, and appears on no screen. The
 * first version of this harness seeded without one and the swap check timed out looking for an
 * Add button that could never exist -- which reads exactly like a broken picker.
 */
export const FIXTURE_CATEGORY = 'f73dd098-8fc8-4d2a-8485-907550852a4e' // 'mains'

function env(name: string): string {
  const v = process.env[name]
  if (!v) throw new Error(`missing env ${name} -- source .env.test before running the suite`)
  return v
}

/** Refuses to hand back a client for anything but staging. */
export function assertStagingDb(): SupabaseClient {
  const url = env('SUPABASE_URL')
  if (url.includes(PRODUCTION_REF)) {
    throw new Error(`REFUSING: SUPABASE_URL is PRODUCTION (${PRODUCTION_REF}).`)
  }
  if (!url.includes(STAGING_REF)) {
    throw new Error(`REFUSING: SUPABASE_URL is not the staging project: ${url}`)
  }
  return createClient(url, env('SUPABASE_SERVICE_ROLE_KEY'), {
    auth: { persistSession: false, autoRefreshToken: false },
  })
}

/**
 * The base URL under test, and a hard check that a LOCAL server is not secretly pointed at
 * production.
 *
 * A local `next dev` reads `.env.local`, and this repo's own `.env.local` is production. The
 * client bundle embeds `NEXT_PUBLIC_SUPABASE_URL`, so the served HTML is where the truth is --
 * not the env this process happens to hold.
 */
export async function assertServedAppUsesStaging(baseURL: string): Promise<void> {
  const res = await fetch(`${baseURL}/menu/${FIXTURE_RESTAURANT}/session-ended`, {
    headers: { 'cache-control': 'no-cache' },
  })
  const html = await res.text()
  if (html.includes(PRODUCTION_REF)) {
    throw new Error(
      `REFUSING: the app served at ${baseURL} embeds the PRODUCTION project ref. ` +
        `Check .env.local in the worktree serving it.`,
    )
  }
}

export type Fixture = {
  tableId: string
  tableNumber: number
  tabId: string
  sessionId: string
  sessionToken: string
  orderId: string
  itemName: string
  itemPriceInclusive: number
  menuItemIds: string[]
}

const round2 = (n: number) => Math.round(n * 100) / 100

/** Inclusive split at the 15% rate the fixture restaurant uses. */
export function inclusiveSplit(price: number) {
  const total = round2(price)
  const subtotal = round2(total / 1.15)
  return { total, subtotal, tax: round2(total - subtotal) }
}

/**
 * Seed a table with an open tab and one ACCEPTED single-line order.
 *
 * Single-line on purpose: the swap defect (#291) only appears when the order has exactly one
 * line, because a two-line order never produces an empty `keep`.
 */
export async function seedTableWithOrder(
  db: SupabaseClient,
  opts: { itemName?: string; price?: number } = {},
): Promise<Fixture> {
  const itemName = opts.itemName ?? `probe-e2e-${randomUUID().slice(0, 8)}`
  const price = opts.price ?? 25

  const { data: menuItem, error: menuErr } = await db
    .from('menu_items')
    .insert({
      restaurant_id: FIXTURE_RESTAURANT,
      name: itemName,
      base_price: price,
      status: 'available',
      track_inventory: false,
      category_id: FIXTURE_CATEGORY,
    })
    .select('id')
    .single()
  if (menuErr) throw new Error(`seed menu item: ${menuErr.message}`)

  let tableNumber = 9200 + Math.floor(Math.random() * 390)
  let tableId = ''
  for (let attempt = 0; attempt < 8; attempt++) {
    const { data, error } = await db
      .from('restaurant_tables')
      .insert({
        restaurant_id: FIXTURE_RESTAURANT,
        table_number: tableNumber,
        active: true,
        is_view_only: false,
        is_kiosk: false,
        status: 'occupied',
      })
      .select('id')
      .single()
    if (!error && data) {
      tableId = data.id
      break
    }
    if (error && error.code !== '23505') throw new Error(`seed table: ${error.message}`)
    tableNumber = 9200 + Math.floor(Math.random() * 390)
  }
  if (!tableId) throw new Error('seed table: 8 consecutive collisions in 9200-9599')

  const sessionId = `probe-e2e-${randomUUID()}`
  const sessionToken = randomUUID()

  const { data: tab, error: tabErr } = await db
    .from('tabs')
    .insert({
      restaurant_id: FIXTURE_RESTAURANT,
      table_id: tableId,
      table_number: tableNumber,
      status: 'open',
        /**
         * THE FIXTURE MUST LOOK LIKE A REAL TAB. Added 2026-08-18: guest reads are now bounded by
         * the session version, so a tab without one is dropped as unattributable — and every spec
         * using this fixture failed its own positive control, which is how the gap was found.
         *
         * A freshly seeded table sits at version 1, the same value POST /api/tabs now stamps.
         */
        session_version: 1,
      session_token: sessionToken,
      members: [{ session_id: sessionId, display_name: 'Probe' }],
      total: 0,
    })
    .select('id')
    .single()
  if (tabErr) throw new Error(`seed tab: ${tabErr.message}`)

  /**
   * The token is not a string the app trusts on its own -- `validateSessionToken` looks it up in
   * `customer_sessions` and compares `session_version` against the TABLE's
   * `current_session_version`. Without this row every token-guarded route answers 410 and the
   * customer screens redirect to "Your dining session has ended", which is what the first run of
   * this suite did: the harness looked like four product defects and was one missing row.
   */
  const { data: tableRow } = await db
    .from('restaurant_tables')
    .select('current_session_version')
    .eq('id', tableId)
    .single()
  const { error: sessErr } = await db.from('customer_sessions').insert({
    token: sessionToken,
    tab_id: tab.id,
    table_id: tableId,
    restaurant_id: FIXTURE_RESTAURANT,
    session_version: Number(tableRow?.current_session_version ?? 1),
    active: true,
    expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
  })
  if (sessErr) throw new Error(`seed customer_session: ${sessErr.message}`)

  const money = inclusiveSplit(price)
  const { data: order, error: orderErr } = await db
    .from('orders')
    .insert({
      restaurant_id: FIXTURE_RESTAURANT,
      tab_id: tab.id,
      table_id: tableId,
      table_number: tableNumber,
      session_id: sessionId,
      member_session_id: sessionId,
      channel: 'table',
      status: 'accepted',
      payment_status: 'pending',
      items: [
        {
          name: itemName,
          displayName: itemName,
          menuItemId: menuItem.id,
          quantity: 1,
          unitPrice: price,
          basePrice: price,
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
  if (orderErr) throw new Error(`seed order: ${orderErr.message}`)

  return {
    tableId,
    tableNumber,
    tabId: tab.id,
    sessionId,
    sessionToken,
    orderId: order.id,
    itemName,
    itemPriceInclusive: price,
    menuItemIds: [menuItem.id],
  }
}

/**
 * Pick an item that is ALREADY on the live staging menu, for flows that must add one.
 *
 * Seeding a fresh item and immediately driving a browser to it was flaky: the row existed in the
 * database and did not reliably appear on the rendered menu within the test's patience, so a run
 * failed while its retry passed. A check that only passes on the second attempt is a flake, and a
 * flake in a REPRODUCTION suite is indistinguishable from the defect it exists to catch.
 *
 * Excludes stock-tracked items, which 409 at checkout on staging today (`espresso beans` sits at
 * a negative balance), and anything `probe-` so a parallel run's fixture is never picked.
 */
export async function pickExistingMenuItem(
  db: SupabaseClient,
): Promise<{ id: string; name: string; price: number }> {
  const { data, error } = await db
    .from('menu_items')
    .select('id, name, base_price, status, track_inventory, category_id')
    .eq('restaurant_id', FIXTURE_RESTAURANT)
    .eq('status', 'available')
    .not('category_id', 'is', null)
    .order('name')
  if (error) throw new Error(`pick menu item: ${error.message}`)
  const usable = (data ?? []).find(
    (m) => !m.track_inventory && !String(m.name).startsWith('probe-') && Number(m.base_price) > 0,
  )
  if (!usable) throw new Error('no usable existing menu item on the staging fixture restaurant')
  return { id: usable.id, name: String(usable.name), price: Number(usable.base_price) }
}

/** A second menu item, for the swap to add. */
export async function seedMenuItem(
  db: SupabaseClient,
  price: number,
): Promise<{ id: string; name: string; price: number }> {
  const name = `probe-e2e-${randomUUID().slice(0, 8)}`
  const { data, error } = await db
    .from('menu_items')
    .insert({
      restaurant_id: FIXTURE_RESTAURANT,
      name,
      base_price: price,
      status: 'available',
      track_inventory: false,
      category_id: FIXTURE_CATEGORY,
    })
    .select('id')
    .single()
  if (error) throw new Error(`seed menu item: ${error.message}`)
  return { id: data.id, name, price }
}

/**
 * Give a browser context the storage a real customer holds after scanning and joining.
 *
 * `addInitScript` rather than `page.evaluate` after load: the app reads these during its first
 * render, so writing them afterwards races the very effects under test.
 */
export async function adoptSession(
  context: BrowserContext,
  baseURL: string,
  f: Pick<Fixture, 'tabId' | 'tableNumber' | 'sessionId' | 'sessionToken'>,
): Promise<void> {
  await context.addInitScript(
    ({ tabId, tableNumber, sessionId, sessionToken }) => {
      try {
        localStorage.setItem('flashtap_session_v1', sessionId)
        localStorage.setItem('flashtap_tab_id', tabId)
        localStorage.setItem('flashtap_table', String(tableNumber))
        localStorage.setItem('flashtap_tab_session_id_mirror', sessionId)
        localStorage.setItem('flashtap_session_token', sessionToken)
        sessionStorage.setItem('tab_session_id', sessionId)
        sessionStorage.setItem('flashtap_session_token', sessionToken)
        sessionStorage.removeItem('flashtap_session_expired')
      } catch {
        /* storage unavailable before navigation; the next init script run will set it */
      }
    },
    {
      tabId: f.tabId,
      tableNumber: f.tableNumber,
      sessionId: f.sessionId,
      sessionToken: f.sessionToken,
    },
  )
  void baseURL
}

/** FK-safe teardown, mirroring the order the simulation had to learn the hard way. */
export async function teardown(db: SupabaseClient, f: Partial<Fixture>): Promise<void> {
  const tabIds = f.tabId ? [f.tabId] : []
  const tableIds = f.tableId ? [f.tableId] : []

  const orderIds = new Set<string>()
  for (const tabId of tabIds) {
    const { data } = await db.from('orders').select('id').eq('tab_id', tabId)
    for (const r of data ?? []) orderIds.add(r.id as string)
  }
  for (const tableId of tableIds) {
    const { data } = await db.from('orders').select('id').eq('table_id', tableId)
    for (const r of data ?? []) orderIds.add(r.id as string)
  }

  for (const id of orderIds) {
    await db.from('receipt_documents').delete().eq('order_id', id)
    await db.from('payment_events').delete().contains('order_ids', [id])
  }
  for (const tabId of tabIds) {
    await db.from('payments').delete().eq('tab_id', tabId)
    await db.from('order_requests').delete().eq('tab_id', tabId)
    await db.from('orders').delete().eq('tab_id', tabId)
    await db.from('customer_sessions').delete().eq('tab_id', tabId)
  }
  for (const tableId of tableIds) {
    await db.from('payments').delete().eq('table_id', tableId)
    await db.from('order_requests').delete().eq('table_id', tableId)
    await db.from('orders').delete().eq('table_id', tableId)
  }
  for (const id of orderIds) await db.from('orders').delete().eq('id', id)
  for (const tabId of tabIds) await db.from('tabs').delete().eq('id', tabId)
  for (const tableId of tableIds) await db.from('restaurant_tables').delete().eq('id', tableId)
  for (const id of f.menuItemIds ?? []) await db.from('menu_items').delete().eq('id', id)
}
