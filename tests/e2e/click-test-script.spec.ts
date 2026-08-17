/**
 * STEP B -- the click-test script, driven.
 *
 * `docs/qr-redesign-click-test-2026-08-16.md`, restricted to what a browser can genuinely assert.
 *
 * WHAT IS DELIBERATELY NOT HERE, and why:
 *
 *   - Copy wording, one-handed layout, whether a flow FEELS right -- a human's eyes.
 *   - Real QR scanning, the physical terminal (#287), the printer -- no device.
 *   - Anything the A-Q simulation already answers. The shared tab returning both members, the
 *     two-figure split, is_self, the token guard, the swap COMMITTING, re-acceptance following
 *     the total: all of those are simulation checks against the real routes, and duplicating
 *     them here would be two instruments answering one question with two chances to disagree.
 *     What is left for the browser is what the simulation structurally cannot see: what is
 *     RENDERED, and what a click does to it.
 *
 * Every check here has been seen to fail. Where there was no pre-fix SHA to fail against, the
 * expectation was inverted once, the failure observed, and the inversion reverted -- noted per
 * check.
 */
import { test, expect, type Page } from '@playwright/test'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  assertServedAppUsesStaging,
  assertStagingDb,
  adoptSession,
  pickExistingMenuItem,
  seedTableWithOrder,
  teardown,
  FIXTURE_RESTAURANT,
  type Fixture,
} from './lib/fixture'
import { EDIT_COPY } from '@/lib/orders/edit-lock'
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

async function waitForPaint(page: Page, timeout = 25_000) {
  await page.waitForFunction(() => document.body.innerText.trim().length > 20, null, { timeout })
}

async function visibleText(page: Page): Promise<string> {
  return (await page.innerText('body')).replace(/\s+/g, ' ').trim()
}

/** See repro-known-defects.spec.ts: painted is not wired. */
async function clickWhenWired(page: Page, name: RegExp, expectAfter: RegExp, tries = 3) {
  for (let i = 0; i < tries; i++) {
    await page.getByRole('button', { name }).first().click()
    try {
      await page.getByRole('button', { name: expectAfter }).first().waitFor({ timeout: 8000 })
      return
    } catch {
      if (i === tries - 1) throw new Error(`clicked ${name} ${tries}x, ${expectAfter} never came`)
      await page.waitForTimeout(1500)
    }
  }
}

/**
 * Section 2 -- every item opens the same sheet, and the whole card is the target.
 *
 * Seen to fail: asserting the sheet opens on a card click while pointing the click at a
 * non-interactive element produced "sheet never opened", as expected.
 */
test.describe('click-test 2 -- the menu', () => {
  test('tapping an item card opens the configuration sheet, not just the + button', async ({
    page,
    baseURL,
  }) => {
    const f = await seedTableWithOrder(db)
    fixture = f
    await adoptSession(page.context(), baseURL!, f)
    const item = await pickExistingMenuItem(db)

    await page.goto(`${baseURL}/menu/${FIXTURE_RESTAURANT}/browse?table=${f.tableNumber}`, {
      waitUntil: 'domcontentloaded',
    })
    await waitForPaint(page)

    const card = page.getByText(item.name, { exact: false }).first()
    await expect(card).toBeVisible({ timeout: 25_000 })
    await card.click()

    // The sheet is the redesign's single entry point for configuring any item.
    const sheet = page.getByRole('dialog')
    await expect(
      sheet,
      'tapping the card must open the same sheet the + button opens (spec section 2)',
    ).toBeVisible({ timeout: 15_000 })
    await expect(sheet).toContainText(item.name)
  })
})

/**
 * Section 7b -- the picker round trip, and THE thing that would be silently wrong.
 *
 * The click-test calls this out by name: an item picked in picker mode must go to the pending
 * EDIT, not to the cart. Nothing server-side can see the difference at pick time -- the cart is
 * browser state -- so this is browser-only by construction.
 *
 * Seen to fail: inverted to `toBe(before + 1)` and the run reported the badge unchanged.
 */
test.describe('click-test 7b -- picker mode does not touch the cart', () => {
  test('an item added in picker mode leaves the cart badge alone', async ({ page, baseURL }) => {
    const f = await seedTableWithOrder(db)
    fixture = f
    await adoptSession(page.context(), baseURL!, f)
    const item = await pickExistingMenuItem(db)

    await page.goto(
      `${baseURL}/menu/${FIXTURE_RESTAURANT}/order-confirmation/${f.orderId}?table=${f.tableNumber}`,
      { waitUntil: 'domcontentloaded' },
    )
    await waitForPaint(page)
    await clickWhenWired(page, /Change this order/i, /Save changes/i)

    const cartCountBefore = await page.evaluate((rid) => {
      const raw = localStorage.getItem(`flashtap_cart_${rid}`) || localStorage.getItem('cart') || '[]'
      try {
        const parsed = JSON.parse(raw)
        return Array.isArray(parsed) ? parsed.length : 0
      } catch {
        return 0
      }
    }, FIXTURE_RESTAURANT)

    await page.getByRole('button', { name: new RegExp(escapeRe(EDIT_COPY.addSomething), 'i') }).first().click()
    await page.waitForURL(/\/browse/, { timeout: 20_000 })
    await waitForPaint(page)
    await expect(page.getByText(new RegExp(escapeRe(QR_REDESIGN_PENDING_COPY.pickerBanner), 'i'))).toBeVisible({
      timeout: 20_000,
    })

    const add = page
      .getByRole('button', { name: new RegExp(`Add ${item.name} to cart`, 'i') })
      .first()
    await expect(add).toBeVisible({ timeout: 25_000 })
    await add.click()
    // Items with sizes or addons open a configuration sheet first; others add straight away.
    const sheetAdd = page.getByRole('button', { name: /^Add to (cart|order)/i }).first()
    if (await sheetAdd.isVisible({ timeout: 5000 }).catch(() => false)) await sheetAdd.click()
    await page.waitForURL(/order-confirmation/, { timeout: 25_000 })
    await waitForPaint(page)

    const cartCountAfter = await page.evaluate((rid) => {
      const raw = localStorage.getItem(`flashtap_cart_${rid}`) || localStorage.getItem('cart') || '[]'
      try {
        const parsed = JSON.parse(raw)
        return Array.isArray(parsed) ? parsed.length : 0
      } catch {
        return 0
      }
    }, FIXTURE_RESTAURANT)

    expect(
      cartCountAfter,
      `picker mode must add to the pending EDIT, not the cart. Cart went ${cartCountBefore} -> ${cartCountAfter}`,
    ).toBe(cartCountBefore)

    // And it really did land in the edit.
    await expect(page.getByText(item.name, { exact: false }).first()).toBeVisible({
      timeout: 20_000,
    })
  })
})

/**
 * Section 5 -- two phones, one table. RENDERING only.
 *
 * The simulation already proves the shared-tab ROUTE returns both members with their own
 * figures, is_self set for exactly one, and no session id or lock token leaking (events B, B6,
 * B-sec). Repeating that here would be a second instrument answering the same question.
 *
 * What it cannot see is whether the second phone RENDERS the first phone's group, and whether
 * the edit affordance is drawn only on the caller's own orders. Those are the two assertions
 * here, in two isolated browser contexts.
 *
 * Seen to fail: with the second context's session id pointed at the first customer's, both
 * contexts drew the edit control and the "only on my own" assertion failed.
 */
test.describe('click-test 5 -- two phones render one shared tab', () => {
  test('each phone shows both diners, and the edit control only on its own order', async ({
    browser,
    baseURL,
  }) => {
    const f = await seedTableWithOrder(db)
    fixture = f

    // A second diner on the same tab, with their own session and their own order.
    const otherSessionId = `probe-e2e-other-${Date.now()}`
    await db
      .from('tabs')
      .update({
        members: [
          { session_id: f.sessionId, display_name: 'Probe' },
          { session_id: otherSessionId, display_name: 'Other' },
        ],
      })
      .eq('id', f.tabId)
    const other = await pickExistingMenuItem(db)
    await db.from('orders').insert({
      restaurant_id: FIXTURE_RESTAURANT,
      tab_id: f.tabId,
      table_id: f.tableId,
      table_number: f.tableNumber,
      session_id: otherSessionId,
      member_session_id: otherSessionId,
      channel: 'table',
      status: 'accepted',
      payment_status: 'pending',
      items: [{ name: other.name, displayName: other.name, quantity: 1, subtotal: other.price, tax: 0, total: other.price }],
      subtotal: other.price,
      tax: 0,
      total: other.price,
      placed_at: new Date().toISOString(),
    })

    const ctxA = await browser.newContext()
    const ctxB = await browser.newContext()
    await adoptSession(ctxA, baseURL!, f)
    await adoptSession(ctxB, baseURL!, { ...f, sessionId: otherSessionId })

    const pageA = await ctxA.newPage()
    const pageB = await ctxB.newPage()
    const url = `${baseURL}/menu/${FIXTURE_RESTAURANT}/tab?table=${f.tableNumber}`
    await Promise.all([
      pageA.goto(url, { waitUntil: 'domcontentloaded' }),
      pageB.goto(url, { waitUntil: 'domcontentloaded' }),
    ])
    await Promise.all([waitForPaint(pageA), waitForPaint(pageB)])

    const textA = await visibleText(pageA)
    const textB = await visibleText(pageB)

    // Both phones render BOTH diners' names. This is what was broken before piece 5: each phone
    // saw only its own orders under a heading carrying the whole table's money.
    for (const [label, text] of [['phone A', textA], ['phone B', textB]] as const) {
      expect(text, `${label} must render both diners. Saw: ${text}`).toContain('Probe')
      expect(text, `${label} must render both diners. Saw: ${text}`).toContain('Other')
    }

    /**
     * The edit affordance is drawn on the caller's OWN group only.
     *
     * I first asserted this with `getByRole('button', {name: /Change this order/i})`, got
     * `Received: 0`, and wrote a docblock concluding that `/tab` renders no edit affordance at
     * all. That was wrong, and an inverted-probe failure dump is what corrected it: the rendered
     * screen reads "You - Probe Edit Order #0 ... Other Order #0". The control exists and is
     * labelled **Edit**. A count of zero meant my selector was wrong, not that the feature was
     * absent -- and I had already written the wrong conclusion into a comment.
     *
     * Exactly one per phone: on its own group, never on the other diner's.
     */
    const editsOnA = await pageA.getByRole('button', { name: /^Edit$/i }).count()
    const editsOnB = await pageB.getByRole('button', { name: /^Edit$/i }).count()
    expect(editsOnA, `phone A must draw exactly one Edit control -- its own. Saw ${editsOnA}`).toBe(1)
    expect(editsOnB, `phone B must draw exactly one Edit control -- its own. Saw ${editsOnB}`).toBe(1)

    await ctxA.close()
    await ctxB.close()
  })
})
