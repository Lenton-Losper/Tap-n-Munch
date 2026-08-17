/**
 * #296 -- the confirmation screen must not display an order number that does not exist.
 *
 * Found on a phone: a submitted order_request rendered "Order #0" in bold under "Order Placed!".
 * `order_requests` has no `order_number` column at all; a number is allocated when staff Accept.
 *
 * This is the browser check for it. It fails against the SHA that predates the fix.
 */
import { test, expect } from '@playwright/test'
import type { SupabaseClient } from '@supabase/supabase-js'
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

/**
 * Selectors read the SHIPPED copy constants rather than a hard-coded phrase.
 *
 * The 2026-08-17 sign-off changed `addSomething` and `pickerBanner`, and the specs that had the
 * old wording typed into a RegExp simply stopped matching -- a 2.6 minute timeout reported as a
 * product failure. A selector bound to a constant cannot drift out of step with the string the
 * app actually renders.
 */
const escapeRe = (s: string) => s.replace(/[^A-Za-z0-9 ]/g, (c) => '\\' + c)

test.setTimeout(150_000)

let db: SupabaseClient
let fixture: Partial<Fixture> = {}

test.beforeAll(async ({ baseURL }) => {
  db = assertStagingDb()
  await assertServedAppUsesStaging(baseURL!)
})
test.afterEach(async () => {
  await teardown(db, fixture)
  fixture = {}
})

test('an unnumbered submission never renders "#0"', async ({ page, baseURL }) => {
  // The fixture inserts no order_number, which is the same state a request is in: none allocated.
  const f = await seedTableWithOrder(db, { price: 25 })
  fixture = f
  await adoptSession(page.context(), baseURL!, f)

  await page.goto(
    `${baseURL}/menu/${FIXTURE_RESTAURANT}/order-confirmation/${f.orderId}?table=${f.tableNumber}`,
    { waitUntil: 'domcontentloaded' },
  )
  await page.waitForFunction(() => document.body.innerText.trim().length > 20, null, {
    timeout: 25_000,
  })
  await expect(page.getByText(f.itemName, { exact: false }).first()).toBeVisible({
    timeout: 20_000,
  })

  const text = (await page.innerText('body')).replace(/\s+/g, ' ').trim()
  expect(text, `an order with no number must not display one. Screen said: ${text}`).not.toMatch(
    /Order\s*#0\b/,
  )
  // And it says something instead of nothing, so the customer can still identify the submission.
  expect(text).toMatch(
    new RegExp(`Order Placed|${escapeRe(QR_REDESIGN_PENDING_COPY.tabOrderNotYetNumbered)}`, 'i'),
  )
})
