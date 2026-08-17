/**
 * #308 and #309 — both found by click-test on PRODUCTION, both browser-level.
 *
 * A server probe cannot see either. #308 is a render expression (`order_number || id.slice(-6)`)
 * and the API response is correct — `order_number` is genuinely absent, which is the truth. #309 is
 * a second vocabulary living in a React component. Only a browser can observe what the customer
 * actually reads, which is why these are here and not in the chain probe.
 *
 * Both seed a real `order_requests` row, because that is the state the defects need: a submission
 * staff have not Accepted, so no number has been allocated and the status is the one the private
 * vocabulary mislabels.
 */
import { test, expect } from '@playwright/test'
import type { SupabaseClient } from '@supabase/supabase-js'
import { randomUUID } from 'crypto'
import {
  assertServedAppUsesStaging,
  assertStagingDb,
  adoptSession,
  seedTableWithOrder,
  teardown,
  FIXTURE_RESTAURANT,
  type Fixture,
} from './lib/fixture'
import { QR_REDESIGN_PENDING_COPY } from '@/lib/customer-copy/qr-redesign-copy'
import { CUSTOMER_STATUS_COPY } from '@/lib/orders/customer-status'

const escapeRe = (s: string) => s.replace(/[^A-Za-z0-9 ]/g, (c) => '\\' + c)

test.setTimeout(150_000)

let db: SupabaseClient
let fixture: Partial<Fixture> = {}
let requestId: string | null = null

test.beforeAll(async ({ baseURL }) => {
  db = assertStagingDb()
  await assertServedAppUsesStaging(baseURL!)
})

test.afterEach(async () => {
  if (requestId) {
    await db.from('order_requests').delete().eq('id', requestId)
    requestId = null
  }
  await teardown(db, fixture)
  fixture = {}
})

/** A submission staff have NOT accepted: no number allocated, status waiting_review. */
async function seedUnnumberedRequest(f: Fixture) {
  const { data, error } = await db
    .from('order_requests')
    .insert({
      restaurant_id: FIXTURE_RESTAURANT,
      channel: 'table',
      table_number: f.tableNumber,
      table_id: f.tableId,
      tab_id: f.tabId,
      session_id: f.sessionId,
      member_session_id: f.sessionId,
      status: 'waiting_review',
      idempotency_key: `probe-e2e-${randomUUID()}`,
      items: [
        {
          name: f.itemName,
          displayName: f.itemName,
          quantity: 1,
          subtotal: f.itemPriceInclusive,
          tax: 0,
          total: f.itemPriceInclusive,
        },
      ],
      subtotal: f.itemPriceInclusive,
      tax: 0,
      total: f.itemPriceInclusive,
      placed_at: new Date().toISOString(),
    })
    .select('id')
    .single()
  if (error) throw new Error(`seed order_request: ${error.message}`)
  requestId = data.id as string
  return requestId
}

test.describe('#308 — an unnumbered submission never shows a number the restaurant cannot look up', () => {
  test('My Orders shows "not numbered yet", not the last six characters of the UUID', async ({
    page,
    baseURL,
  }) => {
    const f = await seedTableWithOrder(db, { price: 25 })
    fixture = f
    const id = await seedUnnumberedRequest(f)
    await adoptSession(page.context(), baseURL!, f)

    await page.goto(`${baseURL}/menu/${FIXTURE_RESTAURANT}/my-orders?table=${f.tableNumber}`, {
      waitUntil: 'domcontentloaded',
    })
    await page.waitForFunction(() => document.body.innerText.trim().length > 20, null, { timeout: 25_000 })

    // POSITIVE CONTROL: the request must actually be on screen, or the negative assertion below
    // is measuring an empty page.
    await expect(
      page.getByText(f.itemName, { exact: false }).first(),
      `[control] the seeded request ${id} must render on My Orders, or the assertions prove nothing`,
    ).toBeVisible({ timeout: 25_000 })

    const text = (await page.locator('body').innerText()).replace(/\s+/g, ' ')
    const derived = id.replace(/-/g, '').slice(-6).toUpperCase()

    expect(
      text,
      `an order_request has no number until staff Accept. My Orders rendered "Order #${derived}", ` +
        `which is the tail of its UUID ${id} and means nothing to the kitchen. Screen: ${text.slice(0, 400)}`,
    ).not.toContain(`#${derived}`)

    // And nothing else UUID-shaped either: six hex characters after a hash is the shape of the bug.
    expect(text, `no derived identifier of any kind. Screen: ${text.slice(0, 400)}`).not.toMatch(
      /Order\s*#\s*[0-9A-F]{6}\b/,
    )

    expect(
      text,
      `it must say what the Tab says instead. Screen: ${text.slice(0, 400)}`,
    ).toMatch(new RegExp(escapeRe(QR_REDESIGN_PENDING_COPY.tabOrderNotYetNumbered), 'i'))
  })
})

test.describe('#309 — the confirmation page speaks the shared vocabulary', () => {
  test('a waiting submission does not read "NEW ORDER"', async ({ page, baseURL }) => {
    const f = await seedTableWithOrder(db, { price: 25 })
    fixture = f
    const id = await seedUnnumberedRequest(f)
    await adoptSession(page.context(), baseURL!, f)

    await page.goto(
      `${baseURL}/menu/${FIXTURE_RESTAURANT}/order-confirmation/${id}?table=${f.tableNumber}`,
      { waitUntil: 'domcontentloaded' },
    )
    await page.waitForFunction(() => document.body.innerText.trim().length > 20, null, { timeout: 25_000 })

    // POSITIVE CONTROL: the order must be on screen.
    await expect(
      page.getByText(f.itemName, { exact: false }).first(),
      `[control] the seeded request ${id} must render on the confirmation page`,
    ).toBeVisible({ timeout: 25_000 })

    const text = (await page.locator('body').innerText()).replace(/\s+/g, ' ')

    expect(
      text,
      `spec section 34 removed the NEW badge, and this order is waiting on the restaurant. ` +
        `Screen: ${text.slice(0, 400)}`,
    ).not.toMatch(/NEW ORDER/i)

    expect(
      text,
      `it must read the signed-off word for this state. Screen: ${text.slice(0, 400)}`,
    ).toMatch(new RegExp(escapeRe(CUSTOMER_STATUS_COPY.waiting), 'i'))
  })
})
