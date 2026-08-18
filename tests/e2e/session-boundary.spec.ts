/**
 * A SESSION ENDED BY CLOSE TABLE IS OVER. A customer who joins after it sees only their own.
 *
 * THE DEFECT, found by click test on production 2026-08-18: clear the table, start a fresh
 * customer session, order — and My Orders showed the new order AND orders from before the close,
 * including a collapsed "Earlier (4)" of declined requests.
 *
 * WHY A BROWSER TEST. The server filter is unit-tested in __tests__/session-boundary.test.ts. What
 * only a browser can show is the thing the click test found: what a REAL customer session sees on
 * the rendered screen after a real close. The unit tests assert a predicate; this asserts the
 * outcome.
 *
 * IT MUST FAIL AGAINST THE PRE-FIX BUILD. Both assertions are counts on a live screen, so a
 * server that serves across the boundary shows two orders where this demands one.
 *
 * AND THE HISTORY MUST SURVIVE. The pre-close rows are financial records. This is about what a
 * CUSTOMER sees, not about deleting anything — so the last assertion reads the database directly
 * and requires the old order to still be there.
 */
import { test, expect } from '@playwright/test'
import type { SupabaseClient } from '@supabase/supabase-js'
import { randomUUID } from 'crypto'
import {
  assertStagingDb,
  assertServedAppUsesStaging,
  seedTableWithOrder,
  adoptSession,
  teardown,
  FIXTURE_RESTAURANT,
  type Fixture,
} from './lib/fixture'

let db: SupabaseClient
let fixture: Partial<Fixture> = {}
let extraIds: { orders: string[]; requests: string[]; tabs: string[] } = {
  orders: [],
  requests: [],
  tabs: [],
}

test.beforeAll(async ({ baseURL }) => {
  db = assertStagingDb()
  await assertServedAppUsesStaging(baseURL!)
})

test.afterEach(async () => {
  for (const id of extraIds.requests) await db.from('order_requests').delete().eq('id', id)
  for (const id of extraIds.orders) await db.from('orders').delete().eq('id', id)
  for (const id of extraIds.tabs) {
    await db.from('customer_sessions').delete().eq('tab_id', id)
    await db.from('payments').delete().eq('tab_id', id)
    await db.from('tabs').delete().eq('id', id)
  }
  extraIds = { orders: [], requests: [], tabs: [] }
  await teardown(db, fixture)
  fixture = {}
})

/**
 * Close the table exactly as staff do. `lib/session-manager.ts` calls this RPC; it settles the
 * table's tabs, expires its customer_sessions rows, and bumps current_session_version. Driving the
 * real function rather than writing the columns by hand is the point — a test that hand-rolled the
 * close would pass against a close that had stopped doing one of the three.
 */
async function closeTable(f: Fixture) {
  const { data, error } = await db.rpc('close_table_session', {
    p_table_id: f.tableId,
    p_restaurant_id: FIXTURE_RESTAURANT,
  })
  if (error) throw new Error(`close_table_session: ${error.message}`)
  return data
}

/** A tab and an order for a NEW customer at the same table, after the close. */
/**
 * THE NEW SESSION REUSES THE PHONE'S EXISTING SESSION ID, and that is the whole defect.
 *
 * A first version of this fixture minted a fresh id for the second customer — and the spec passed
 * against the UNFIXED build, because `fetchGuestOrdersBySession` scopes by session_id, so an old
 * order under a different id was never in scope to leak. The test was reproducing a scenario that
 * was never broken.
 *
 * What actually happens on a real phone: `close_table_session` bumps the table's version and
 * expires the customer_sessions rows, but `flashtap_session_v1` in localStorage is untouched — so
 * the SAME id asks for its own history and gets it. Reusing the id here is what makes this a
 * reproduction rather than a demonstration.
 */
async function seedNewSessionOrder(f: Fixture, itemName: string) {
  const sessionId = f.sessionId

  const { data: table } = await db
    .from('restaurant_tables')
    .select('current_session_version')
    .eq('id', f.tableId)
    .single()

  const { data: tab, error: tabErr } = await db
    .from('tabs')
    .insert({
      restaurant_id: FIXTURE_RESTAURANT,
      table_id: f.tableId,
      table_number: f.tableNumber,
      status: 'open',
      // The new session's tab sits at the table's CURRENT version — which is what makes it the
      // current session and the pre-close tab not.
      session_version: table?.current_session_version,
      total: 0,
    })
    .select('id')
    .single()
  if (tabErr) throw new Error(`seed new tab: ${tabErr.message}`)
  extraIds.tabs.push(tab.id)

  const { data: order, error: orderErr } = await db
    .from('orders')
    .insert({
      restaurant_id: FIXTURE_RESTAURANT,
      tab_id: tab.id,
      table_id: f.tableId,
      table_number: f.tableNumber,
      session_id: sessionId,
      member_session_id: sessionId,
      channel: 'table',
      status: 'accepted',
      payment_status: 'pending',
      items: [{ name: itemName, displayName: itemName, quantity: 1, unitPrice: 25, total: 25 }],
      subtotal: 21.74,
      tax: 3.26,
      total: 25,
      placed_at: new Date().toISOString(),
    })
    .select('id')
    .single()
  if (orderErr) throw new Error(`seed new order: ${orderErr.message}`)
  extraIds.orders.push(order.id)

  return { sessionId, tabId: tab.id, orderId: order.id }
}

test.describe('a session ended by Close Table is over', () => {
  test('a new session at a cleared table sees exactly its own order', async ({ page, baseURL }) => {
    // BEFORE: a customer orders, and the table is cleared under them.
    const f = await seedTableWithOrder(db)
    fixture = f
    const beforeName = f.itemName
    await closeTable(f)

    // AFTER: a new customer at the same table.
    const afterName = `after-close-${randomUUID().slice(0, 6)}`
    const fresh = await seedNewSessionOrder(f, afterName)

    await adoptSession(page.context(), baseURL!, {
      ...f,
      sessionId: fresh.sessionId,
      tabId: fresh.tabId,
    })
    await page.goto(`${baseURL}/menu/${FIXTURE_RESTAURANT}/my-orders?table=${f.tableNumber}`, {
      waitUntil: 'domcontentloaded',
    })

    /**
     * POSITIVE CONTROL FIRST. "The old order is absent" is also true of a screen that failed to
     * load, a wrong session and a broken selector. The NEW order must be visible in the same run.
     */
    await expect(
      page.getByText(afterName, { exact: false }).first(),
      `[control] the new session's own order (${afterName}) must be on screen. If this fails the ` +
        'assertion below proves nothing — fix the fixture, not the filter.',
    ).toBeVisible({ timeout: 30_000 })

    // THE ASSERTION. Nothing from before the close, anywhere on the page — not in the live list,
    // not in the collapsed "Earlier" section.
    await expect(
      page.getByText(beforeName, { exact: false }),
      `an order placed before the table was cleared must not appear to a customer who joined ` +
        `after it (${beforeName})`,
    ).toHaveCount(0)

    // EXACTLY ONE card, which is the click test's own words.
    await expect(page.locator('[data-testid="my-orders-card"]')).toHaveCount(1)
  })

  test('the tab view refuses a tab from the previous session', async ({ page, baseURL }) => {
    const f = await seedTableWithOrder(db)
    fixture = f
    const oldTabId = f.tabId
    await closeTable(f)

    // The money surface, asked for the PRE-CLOSE tab with a valid-looking session.
    const res = await page.request.get(
      `${baseURL}/api/tabs/${oldTabId}/view?restaurantId=${FIXTURE_RESTAURANT}&sessionId=${f.sessionId}`,
    )
    expect(
      res.status(),
      'the two figures a customer is asked to settle must not be served across a closed session',
    ).toBe(410)
    const body = await res.json()
    expect(body.reason).toBe('session_version_mismatch')

    /**
     * THE POSITIVE CONTROL. A route that 410s unconditionally would pass the assertion above. The
     * NEW session's tab, on the same table, must still be served.
     */
    const fresh = await seedNewSessionOrder(f, `after-${randomUUID().slice(0, 6)}`)
    const ok = await page.request.get(
      `${baseURL}/api/tabs/${fresh.tabId}/view?restaurantId=${FIXTURE_RESTAURANT}&sessionId=${fresh.sessionId}`,
    )
    expect(
      ok.status(),
      '[control] the CURRENT session’s tab must still be served, or this is a blanket refusal',
    ).toBe(200)
  })

  test('the pre-close orders still exist — this hides history, it does not delete it', async () => {
    const f = await seedTableWithOrder(db)
    fixture = f
    await closeTable(f)

    // Read as staff would: straight from the database, no session scoping.
    const { data, error } = await db.from('orders').select('id, total').eq('id', f.orderId).single()
    expect(error, 'the pre-close order must still be readable').toBeNull()
    expect(data?.id).toBe(f.orderId)

    const { data: tab } = await db.from('tabs').select('id, status').eq('id', f.tabId).single()
    expect(tab?.id, 'the settled tab must still exist — it is a financial record').toBe(f.tabId)
  })
})
