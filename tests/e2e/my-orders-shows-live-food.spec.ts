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
import { QR_REDESIGN_PENDING_COPY } from '@/lib/customer-copy/qr-redesign-copy'
import { CUSTOMER_STATUS_COPY } from '@/lib/orders/customer-status'

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

    const live = page.locator('[data-testid="my-orders-live"]')
    await expect(
      live,
      '[control] the live list must exist as its own region, or there is nothing to bound',
    ).toBeVisible({ timeout: 20_000 })
    await expect(
      live.getByText(new RegExp(f.itemName, 'i')),
      '[control] today’s food must be IN the live list, or the assertion below is reading an ' +
        'empty region rather than a bounded one',
    ).toHaveCount(1)

    await expect(
      live.getByText(new RegExp(staleName, 'i')),
      'a declined order from 10 hours ago must not be in the LIVE list',
    ).toHaveCount(0)
  })

  /** And it is in the collapsed section — placement, not deletion. */
  test('the stale decline is in the collapsed “Earlier” section', async ({ page, baseURL }) => {
    const f = await seedTableWithOrder(db)
    fixture = f
    const staleName = `earlier-decline-${randomUUID().slice(0, 6)}`
    await seedAgedDecline(f, 10, staleName)

    await openMyOrders(page, baseURL!, f)
    await assertLiveOrderVisible(page, f, f.itemName)

    const earlier = page.locator('[data-testid="my-orders-earlier"]')
    await expect(earlier, 'the collapsed section must render when it has content').toBeVisible({
      timeout: 20_000,
    })
    // The signed-off heading read from the CONSTANT rather than typed out, so a copy change
    // cannot silently break the selector — that has happened before on this project.
    await expect(earlier).toContainText(QR_REDESIGN_PENDING_COPY.myOrdersEarlierSection)
    await expect(
      earlier.getByText(new RegExp(staleName, 'i')),
      'the stale decline must be INSIDE the collapsed section',
    ).toHaveCount(1)
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
   * THE HEADLINE IS A FACT, NOT AN ABSENCE.
   *
   * The bold top-left slot held "Not numbered yet" — the loudest thing on the card announcing
   * that something does not exist, while the badge beside it already said WAITING FOR RESTAURANT.
   *
   * Asserted by ROLE and prominence, not by absence of a string: `getByRole('heading')` is the
   * slot itself, so this fails if the phrase merely moves to a different bold heading. A plain
   * `not.toContainText` over the whole card would also pass for a card that stopped rendering.
   */
  test('an unnumbered order does not headline with “Not numbered yet”', async ({ page, baseURL }) => {
    const f = await seedTableWithOrder(db)
    fixture = f

    await openMyOrders(page, baseURL!, f)
    await assertLiveOrderVisible(page, f, f.itemName)

    const card = page.locator('[data-testid="my-orders-card"]').first()
    await expect(card, '[control] a card must be on screen to be read').toBeVisible()

    const heading = card.getByRole('heading')
    await expect(heading, '[control] the card must still HAVE a headline').toHaveCount(1)
    await expect(
      heading,
      'the loudest slot on the card must not announce that a number does not exist',
    ).not.toContainText(/not numbered yet/i)

    // ...and the state is still stated, in the slot that owns it. Matched against the SHARED
    // vocabulary rather than one phrase: the fixture seeds an ACCEPTED order, so demanding
    // "Waiting for restaurant" here failed on a card that was rendering perfectly — the control
    // was wrong, not the fix.
    const states = Object.values(CUSTOMER_STATUS_COPY).join('|')
    await expect(
      card,
      '[control] the badge must still say what is happening, or this passes for a blank card',
    ).toContainText(new RegExp(states, 'i'))
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
