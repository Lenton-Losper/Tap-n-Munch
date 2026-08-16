/**
 * STEP A -- the instrument proved on defects that were REAL.
 *
 * One check per defect a human found by hand on a phone, each written to FAIL against the SHA
 * that predates its fix and PASS against current. A browser check that has never failed is the
 * 28/28 situation with a heavier instrument: it looks like coverage and is a decoration.
 *
 *   #292  the Tab screen blanking on its 5s poll        pre-fix 955c027
 *   #294  "Change this order" landing on /session-ended  pre-fix 20cd8b4
 *   #295  the confirmation line reading the ex-VAT base  pre-fix 20cd8b4
 *   #291  the swap: remove the only line, add another    pre-fix 859f3a5
 *
 * Run against current:   npx playwright test tests/e2e/repro-known-defects.spec.ts
 * Run against a pre-fix build:
 *   E2E_BASE_URL=http://localhost:3111 npx playwright test tests/e2e/repro-known-defects.spec.ts
 *
 * Every fixture is seeded on STAGING in table range 9200-9599 with `probe-` session ids, and torn
 * down in `afterEach` including the `payments` rows the simulation's cleanup used to miss.
 */
import { test, expect, type Page } from '@playwright/test'
import type { SupabaseClient } from '@supabase/supabase-js'
import { randomUUID } from 'crypto'
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

/**
 * These drive multi-page customer journeys against a deployed worker, so the 30s default in
 * playwright.config.ts is not enough -- the swap alone is four navigations.
 */
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

/** The visible text of the page, whitespace-collapsed, for readable assertions and failures. */
async function visibleText(page: Page): Promise<string> {
  return (await page.innerText('body')).replace(/\s+/g, ' ').trim()
}

/** Wait until the client has hydrated and painted something. */
async function waitForPaint(page: Page, timeout = 25_000) {
  await page.waitForFunction(() => document.body.innerText.trim().length > 20, null, { timeout })
}

/**
 * Click a control that React has painted but may not yet have wired.
 *
 * Playwright's actionability check answers "is this element visible, stable and enabled" -- not
 * "has React attached its onClick". On these pages the button is painted by the server render and
 * hydrated a beat later, so a click that lands in the gap is swallowed silently: no error, no
 * navigation, nothing. That cost a run that looked like the edit lock being refused, when the
 * lock had never been requested.
 *
 * So: click, then wait for something the handler must produce, and click again if it did not.
 */
async function clickWhenWired(page: Page, name: RegExp, expectAfter: RegExp, tries = 3) {
  for (let i = 0; i < tries; i++) {
    await page.getByRole('button', { name }).first().click()
    try {
      await page.getByRole('button', { name: expectAfter }).first().waitFor({ timeout: 8000 })
      return
    } catch {
      if (i === tries - 1) throw new Error(`clicked ${name} ${tries}x and ${expectAfter} never appeared`)
      await page.waitForTimeout(1500)
    }
  }
}

test.describe('#295 the confirmation line price is what the customer pays', () => {
  test('a N$25 item reads 25.00, never the 21.74 ex-VAT base', async ({ page, baseURL }) => {
    const f = await seedTableWithOrder(db, { price: 25 })
    fixture = f
    await adoptSession(page.context(), baseURL!, f)

    await page.goto(
      `${baseURL}/menu/${FIXTURE_RESTAURANT}/order-confirmation/${f.orderId}?table=${f.tableNumber}`,
      { waitUntil: 'domcontentloaded' },
    )
    await waitForPaint(page)
    await expect(page.getByText(f.itemName, { exact: false }).first()).toBeVisible({
      timeout: 20_000,
    })

    /**
     * Scoped to the LINE, not the page. The first version banned "21.74" anywhere on screen and
     * failed against the FIXED build -- because the Subtotal row legitimately shows 21.74, and
     * deliberately so: it is an ex-tax decomposition sitting above a VAT line. An assertion that
     * cannot tell the line from the subtotal is not testing the defect.
     */
    const line = page.locator('li', { hasText: f.itemName }).first()
    const lineText = (await line.innerText()).replace(/\s+/g, ' ').trim()
    const pageText = await visibleText(page)
    expect(lineText, `the LINE must show what is charged. Screen said: ${pageText}`).toContain(
      '25.00',
    )
    // 25 / 1.15 = 21.7391 -- the figure the customer was actually shown, on the line.
    expect(lineText).not.toContain('21.74')
    // And the breakdown beneath it is untouched.
    expect(pageText).toContain('Subtotal')
    expect(pageText).toContain('21.74')
  })
})

test.describe('#294 a missing order does not end the dining session', () => {
  test('an order that 404s leaves the customer on the page, not on /session-ended', async ({
    page,
    baseURL,
  }) => {
    const f = await seedTableWithOrder(db, { price: 25 })
    fixture = f
    await adoptSession(page.context(), baseURL!, f)

    // Make the stored token stale the way a settled tab or a bumped table version does. This is
    // what turns the old "bounce to the landing" into an eviction: the landing validates the
    // token, gets 410, and calls handleSessionExpired.
    await db.rpc('close_table_session', {
      p_table_id: f.tableId,
      p_restaurant_id: FIXTURE_RESTAURANT,
    })

    const missingOrderId = randomUUID()
    await page.goto(
      `${baseURL}/menu/${FIXTURE_RESTAURANT}/order-confirmation/${missingOrderId}?table=${f.tableNumber}`,
      { waitUntil: 'domcontentloaded' },
    )
    await waitForPaint(page)
    await page.waitForTimeout(2500) // let any client-side redirect settle

    const url = page.url()
    const text = await visibleText(page)
    expect(
      url,
      `a 404 on ONE order must not end the session. Landed on ${url} showing: ${text}`,
    ).not.toContain('/session-ended')
    expect(text).not.toContain('Your dining session has ended')
  })
})

test.describe('#292 the Tab screen refreshes in place', () => {
  test('the screen is never replaced by a spinner across a poll tick', async ({
    page,
    baseURL,
  }) => {
    const f = await seedTableWithOrder(db, { price: 25 })
    fixture = f
    await adoptSession(page.context(), baseURL!, f)

    await page.goto(`${baseURL}/menu/${FIXTURE_RESTAURANT}/tab?table=${f.tableNumber}`, {
      waitUntil: 'domcontentloaded',
    })
    await waitForPaint(page)
    await expect(page.getByText(f.itemName, { exact: false }).first()).toBeVisible({
      timeout: 20_000,
    })

    /**
     * Sample across TWO poll ticks (5s each). The old code called setLoading(true) at the top of
     * every tick, and `showTabLoading` returns a full-screen spinner -- so the item name vanishes
     * for the duration of three network round-trips, roughly twice in this window.
     */
    const samples: boolean[] = []
    const started = Date.now()
    while (Date.now() - started < 12_000) {
      samples.push(await page.getByText(f.itemName, { exact: false }).first().isVisible())
      await page.waitForTimeout(250)
    }

    const disappearances = samples.filter((v) => !v).length
    expect(
      disappearances,
      `the tab content vanished on ${disappearances}/${samples.length} samples across 12s ` +
        `(two poll ticks). A refresh must replace data in place, not blank the screen.`,
    ).toBe(0)
  })
})

test.describe('#291 an item can be swapped', () => {
  test('remove the only line, add another, and Save is enabled', async ({ page, baseURL }) => {
    const f = await seedTableWithOrder(db, { price: 25 })
    // An item already on the menu, not a freshly seeded one -- see pickExistingMenuItem.
    const replacement = await pickExistingMenuItem(db)
    fixture = f
    await adoptSession(page.context(), baseURL!, f)

    await page.goto(
      `${baseURL}/menu/${FIXTURE_RESTAURANT}/order-confirmation/${f.orderId}?table=${f.tableNumber}`,
      { waitUntil: 'domcontentloaded' },
    )
    await waitForPaint(page)
    await clickWhenWired(page, /Change this order/i, /Save changes/i)

    /**
     * The REAL round trip, not a storage poke.
     *
     * The first version of this check wrote `flashtap_edit_additions_<orderId>` directly and
     * reloaded. It failed, and correctly so: I was guessing at a storage shape instead of using
     * the affordance. Driving "+ Add something" -> menu -> add -> back is both the honest
     * reproduction and click-test section 7b, so it is one flow covering two things.
     */
    await page.getByRole('button', { name: /Add something/i }).first().click()
    await page.waitForURL(/\/browse/, { timeout: 20_000 })
    await waitForPaint(page)

    // Picker mode announces itself; if that banner is gone the customer is in the ordinary menu
    // and anything added would land in the CART instead of the pending edit.
    await expect(page.getByText(/Choosing something to add to your order/i)).toBeVisible({
      timeout: 20_000,
    })

    /**
     * Wait for the freshly seeded item to actually be on the menu, and reload once if it is not.
     *
     * The browse screen reads the menu directly rather than through an API this harness can poll,
     * and a first run failed here while its retry passed in 10s -- the item existed in the
     * database and not yet on the rendered page. A check that only passes on the second attempt
     * is a flake, and a flake in a reproduction suite is indistinguishable from the defect.
     */
    const addButton = page
      .getByRole('button', { name: new RegExp(`Add ${replacement.name} to cart`, 'i') })
      .first()
    if (!(await addButton.isVisible({ timeout: 15_000 }).catch(() => false))) {
      await page.reload({ waitUntil: 'domcontentloaded' })
      await waitForPaint(page)
    }
    await expect(addButton).toBeVisible({ timeout: 30_000 })
    await addButton.click()

    // Some items open a configuration sheet before adding; others add straight away. Handle both
    // rather than assuming, and fail loudly if neither happens.
    const sheetAdd = page.getByRole('button', { name: /^Add to (cart|order)/i }).first()
    if (await sheetAdd.isVisible({ timeout: 4000 }).catch(() => false)) {
      await sheetAdd.click()
    }

    await page.waitForURL(/order-confirmation/, { timeout: 25_000 })
    await waitForPaint(page)

    // The editor reopens by itself because a pending addition exists for this order.
    await expect(page.getByRole('button', { name: /Save changes/i })).toBeVisible({
      timeout: 25_000,
    })
    await expect(page.getByText(replacement.name, { exact: false }).first()).toBeVisible({
      timeout: 20_000,
    })

    // Now remove the only ORIGINAL line. The control is labelled `Remove <item name>`.
    await page
      .getByRole('button', { name: new RegExp(`^Remove ${f.itemName}`, 'i') })
      .first()
      .click()

    const save = page.getByRole('button', { name: /Save changes/i }).first()
    const text = await visibleText(page)
    expect(
      await save.isEnabled(),
      `zero kept + one addition is a SWAP, not an empty order. Screen said: ${text}`,
    ).toBe(true)
    expect(text).not.toContain('An order needs at least one item')
  })
})
