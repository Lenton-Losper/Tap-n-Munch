/**
 * MY ORDERS ANSWERS "WHAT IS HAPPENING WITH MY FOOD NOW".
 *
 * Three defects found by click test on PRODUCTION, on a real customer session: three declined
 * orders from ten hours earlier stacked above today's food, each labelled "Not numbered yet" and
 * each carrying a "Payment: cash / PENDING" line.
 *
 * WHY THESE HAVE TO BE BROWSER TESTS. All three are render decisions. The API returns exactly what
 * it is asked for — measured: `lib/guest-orders/queries.ts` bounds the list by restaurant, session
 * and `tab_settlement_for_tab_id IS NULL` and by NOTHING ELSE on the orders side, and by
 * `status IN ('waiting_review','accepting','declined')` on the requests side. No time bound, no
 * limit, on either. A server probe reading that response sees a correct response. The defect is
 * entirely in what the screen does with it.
 *
 * EACH TEST CARRIES ITS OWN POSITIVE CONTROL, because "the stale order is not on screen" is also
 * true of a screen that failed to load, a wrong session and a broken selector. The live order must
 * be VISIBLE in the same run, every time.
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
/** Extra rows this spec creates beyond the shared fixture, torn down alongside it. */
let extraRequestIds: string[] = []

test.beforeAll(async ({ baseURL }) => {
  db = assertStagingDb()
  await assertServedAppUsesStaging(baseURL!)
})

test.afterEach(async () => {
  for (const id of extraRequestIds) await db.from('order_requests').delete().eq('id', id)
  extraRequestIds = []
  await teardown(db, fixture)
  fixture = {}
})

const HOURS = 60 * 60 * 1000

/**
 * A DECLINED submission, aged. This is the exact row from the screenshot: an `order_requests` row
 * with `status: 'declined'`, no `order_number` (the table has no such column), placed hours ago.
 */
async function seedAgedDecline(f: Fixture, hoursAgo: number, itemName: string) {
  const placedAt = new Date(Date.now() - hoursAgo * HOURS).toISOString()
  const { data, error } = await db
    .from('order_requests')
    .insert({
      restaurant_id: FIXTURE_RESTAURANT,
      tab_id: f.tabId,
      table_id: f.tableId,
      table_number: f.tableNumber,
      session_id: f.sessionId,
      member_session_id: f.sessionId,
      channel: 'table',
      status: 'declined',
      items: [
        {
          menuItemId: f.menuItemIds[0],
          name: itemName,
          displayName: itemName,
          quantity: 1,
          unitPrice: 25,
          subtotal: 21.74,
          tax: 3.26,
          total: 25,
        },
      ],
      subtotal: 21.74,
      tax: 3.26,
      total: 25,
      payment_method: 'cash',
      placed_at: placedAt,
    })
    .select('id')
    .single()
  if (error) throw new Error(`seedAgedDecline: ${error.message}`)
  extraRequestIds.push(data.id)
  return data.id
}

async function openMyOrders(page: any, baseURL: string, f: Fixture) {
  await adoptSession(page.context(), baseURL, f)
  await page.goto(
    `${baseURL}/menu/${FIXTURE_RESTAURANT}/my-orders?table=${f.tableNumber}`,
    { waitUntil: 'domcontentloaded' },
  )
}

/** The live order must be on screen, or every negative assertion below is measuring a blank page. */
async function assertLiveOrderVisible(page: any, f: Fixture, itemName: string) {
  await expect(
    page.getByText(new RegExp(itemName, 'i')).first(),
    `[control] the CURRENT order (${itemName}) must be visible on My Orders. If this fails the ` +
      'assertions below prove nothing — fix the fixture or the selector, not the filter.',
  ).toBeVisible({ timeout: 30_000 })
}

test.describe('My Orders — the live list', () => {
  /**
   * DEFECT 1. Ten hours old, terminal, unactionable, and still stacked above today's food.
   *
   * The rule being asserted: an order in a terminal state the customer cannot act on does not sit
   * in the LIVE list indefinitely. It is not deleted — a customer who was declined and sees
   * nothing has no idea what happened — so the assertion is about the live list specifically.
   */
  test('a ten-hour-old declined order is not stacked above today’s food', async ({ page, baseURL }) => {
    const f = await seedTableWithOrder(db)
    fixture = f
    const staleName = `stale-decline-${randomUUID().slice(0, 6)}`
    await seedAgedDecline(f, 10, staleName)

    await openMyOrders(page, baseURL!, f)
    await assertLiveOrderVisible(page, f, f.itemName)

    /**
     * ASSERTED AS ORDERING, which is what ships. The collapsed section is built but held back:
     * it needs a heading, a heading is a customer-facing string, and the PENDING COPY marker
     * would render literally to a customer. Ordering needs no wording and fixes the reported
     * harm -- the dead order no longer sits ABOVE today's food.
     */
    const cards = page.locator('[data-testid="my-orders-card"]')
    await expect(cards.first()).toBeVisible({ timeout: 20_000 })
    const texts = await cards.allInnerTexts()
    const liveIdx = texts.findIndex((t) => t.includes(f.itemName))
    const staleIdx = texts.findIndex((t) => t.includes(staleName))

    expect(liveIdx, '[control] the current order must be among the cards').toBeGreaterThanOrEqual(0)
    expect(staleIdx, '[control] the stale decline must be among the cards, not dropped').toBeGreaterThanOrEqual(0)
    expect(
      staleIdx,
      `a declined order from 10 hours ago must come AFTER today's food, not above it ` +
        `(live at ${liveIdx}, stale at ${staleIdx})`,
    ).toBeGreaterThan(liveIdx)
  })

  /**
   * THE OTHER SIDE OF DEFECT 1, and the reason this is not a blanket terminal-state filter: a
   * customer declined a minute ago must SEE it. Hiding a fresh decline is a worse defect than
   * showing a stale one.
   */
  test('a decline from a minute ago IS in the live list', async ({ page, baseURL }) => {
    const f = await seedTableWithOrder(db)
    fixture = f
    const freshName = `fresh-decline-${randomUUID().slice(0, 6)}`
    await seedAgedDecline(f, 0, freshName)

    await openMyOrders(page, baseURL!, f)
    await assertLiveOrderVisible(page, f, f.itemName)

        await expect(
      page.getByText(new RegExp(freshName, 'i')),
      'a decline the customer has not seen yet must stay in the live list',
    ).toHaveCount(1)
  })

  /** And it is not deleted: the stale decline is still reachable on the page. */
  test('the stale decline is still on the page, not dropped', async ({ page, baseURL }) => {
    const f = await seedTableWithOrder(db)
    fixture = f
    const staleName = `kept-decline-${randomUUID().slice(0, 6)}`
    await seedAgedDecline(f, 10, staleName)

    await openMyOrders(page, baseURL!, f)
    await assertLiveOrderVisible(page, f, f.itemName)

    await expect(
      page.getByText(new RegExp(staleName, 'i')),
      'the order must still exist somewhere on the screen — silently dropping it is its own defect',
    ).toHaveCount(1)
  })

  /**
   * DEFECT 2. "Not numbered yet" means "submitted, awaiting acceptance". A declined order will
   * never be numbered, so the string is right and the condition rendering it is wrong.
   */
  test('a declined order is never labelled "Not numbered yet"', async ({ page, baseURL }) => {
    const f = await seedTableWithOrder(db)
    fixture = f
    const name = `declined-label-${randomUUID().slice(0, 6)}`
    await seedAgedDecline(f, 0, name)

    await openMyOrders(page, baseURL!, f)
    await assertLiveOrderVisible(page, f, f.itemName)

    const card = page
      .locator('[data-testid="my-orders-card"]')
      .filter({ hasText: new RegExp(name, 'i') })
    await expect(card, '[control] the declined card must be on screen to be read').toHaveCount(1)
    await expect(
      card.getByText(/not numbered yet/i),
      'a declined order will never receive a number; "not yet" is a promise that cannot be kept',
    ).toHaveCount(0)
  })

  /**
   * DEFECT 3. Payment belongs on the Tab, which owns the money. On a card about food status
   * "PENDING" reads as a problem when nothing is wrong.
   */
  test('the card carries no payment method or payment status', async ({ page, baseURL }) => {
    const f = await seedTableWithOrder(db)
    fixture = f

    await openMyOrders(page, baseURL!, f)
    await assertLiveOrderVisible(page, f, f.itemName)

    const card = page.locator('[data-testid="my-orders-card"]').first()
    await expect(card, '[control] a card must be on screen to be read').toBeVisible()
    await expect(card.getByText(/^Payment:/i), 'payment belongs on the Tab').toHaveCount(0)
    await expect(card.getByText(/⏳\s*Pending/i), 'PENDING reads as a problem').toHaveCount(0)
  })
})
