/**
 * Issue #178 — browser coverage for /qr-codes Clear table, the path #176 broke.
 *
 * WHAT GOT THROUGH, AND WHY NOTHING CAUGHT IT
 *
 * Clicking Clear table on staging failed with:
 *
 *   Could not check open orders
 *   object is not iterable (cannot read property Symbol(Symbol.iterator))
 *
 * The handler passed `resolveOrderRestaurantScope`'s return value — an object,
 * `{ restaurantId, firebaseRestaurantId }` — to a PostgREST filter, which iterates its argument
 * at query-BUILD time. It threw before any request was sent. `summariseClearImpact` had 18 unit
 * tests and the staging end-to-end drove the route handler directly; the client-side query
 * between the button and the money check was the only new code neither touched, and it was the
 * only new code that could fail this way.
 *
 * That failure is invisible to anything short of a real browser: the error happens in the
 * click handler, in the page, before the network. So this spec drives the actual button.
 *
 * NO WRITES. The dialog is opened and cancelled, never confirmed. Confirming would close real
 * orders on the staging test restaurant.
 *
 * THE ASSERTION IS EXACT, NOT LOOSE. Rather than checking "a dialog appeared", the test reads
 * the same orders from the database with the service role, runs them through the same pure
 * functions the component uses, and asserts the rendered text equals that string. A loose
 * assertion would pass on a dialog showing the wrong money, and the money is the point.
 */
import { test, expect, type Page } from '@playwright/test'
import { createClient } from '@supabase/supabase-js'
import { config } from 'dotenv'
import {
  summariseClearImpact,
  clearTableConfirmationMessage,
  type ClearTableOrder,
} from '../../../lib/tables/clear-table'
import {
  NOPERMS_STORAGE_STATE,
  STAFF_STORAGE_STATE,
  TEST_ACTIVE_TABLE_NUMBER,
  TEST_RESTAURANT_ID,
} from '../constants'

/**
 * `override: false` is load-bearing, not a style choice. `.env.test` contains its own
 * `E2E_BASE_URL` pointing at the DEPLOYED staging worker. With `override: true` that silently
 * beat the `E2E_BASE_URL` exported to run against a local dev server, so this spec ran green
 * against deployed staging while the code under test sat unbuilt on disk — a browser test that
 * passes without touching the build it is supposed to be testing. Caught by a canary: renaming
 * the Cancel button locally did not fail the run.
 */
config({ path: '.env.test', override: false })

const STAGING_REF = 'mdqjpxwczrhkxkbqatqa'
const TABLE_LABEL = `Table ${TEST_ACTIVE_TABLE_NUMBER}`

/** Read-only service-role client, used to compute what the dialog OUGHT to say. */
function admin() {
  const url = process.env.SUPABASE_URL || ''
  if (!url.includes(STAGING_REF)) {
    throw new Error(`Refusing: expected staging ${STAGING_REF}, got '${url}'. Load .env.test.`)
  }
  return createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY || '', {
    auth: { persistSession: false, autoRefreshToken: false },
  })
}

/** The same rows the component's pre-flight query fetches, read independently of the browser. */
async function openOrdersForTable(tableNumber: number): Promise<ClearTableOrder[]> {
  const { data, error } = await admin()
    .from('orders')
    .select('id, payment_status, total')
    .eq('restaurant_id', TEST_RESTAURANT_ID)
    .eq('table_number', tableNumber)
    .eq('is_closed', false)
  if (error) throw new Error(`fixture read failed: ${error.message}`)
  return (data ?? []) as ClearTableOrder[]
}

/**
 * The card for one ordering point: the innermost element holding BOTH this table's heading and
 * its overflow button. Scoping to the heading alone lands on an inner wrapper that has no button;
 * scoping by text alone would match a parent holding every card and open the wrong menu.
 */
function cardFor(page: Page, label: string) {
  return page
    .locator('div')
    .filter({ has: page.getByRole('heading', { name: label, exact: true }) })
    .filter({ has: page.getByRole('button', { name: /more actions/i }) })
    .last()
}

/** Opens the row's overflow menu and clicks Clear table. */
async function openClearDialog(page: Page, label: string) {
  const card = cardFor(page, label)
  await expect(card).toBeVisible({ timeout: 20_000 })

  await card.getByRole('button', { name: /more actions/i }).click()
  await page.getByRole('menuitem', { name: /^clear table$/i }).click()
}

test.describe('staff with tables:manage', () => {
  test.use({ storageState: STAFF_STORAGE_STATE })

  test.beforeEach(async ({ page }) => {
    await page.goto('/qr-codes')
    await expect(page.getByText(TABLE_LABEL).first()).toBeVisible({ timeout: 30_000 })
  })

  /**
   * THE #176 REGRESSION TEST.
   *
   * On the bug, `handleClearRequest` throws, the catch calls `setClearTarget(null)` and raises a
   * destructive toast — so the dialog never renders and "Could not check open orders" appears
   * instead. Both halves are asserted: the dialog must be there, and that toast must not.
   */
  test('Clear table opens the confirmation dialog instead of failing to check open orders', async ({
    page,
  }) => {
    await openClearDialog(page, TABLE_LABEL)

    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible({ timeout: 15_000 })
    await expect(dialog.getByText(new RegExp(`Clear ${TABLE_LABEL}\\?`, 'i'))).toBeVisible()

    // The exact failure #176 produced. Asserted explicitly so a future regression names itself
    // rather than showing up as a timeout somewhere else.
    await expect(page.getByText(/could not check open orders/i)).toHaveCount(0)
    await expect(page.getByText(/is not iterable/i)).toHaveCount(0)

    // The count must actually ARRIVE. "Checking open orders…" is the placeholder shown while the
    // query is in flight; if the query never resolves, the dialog is open but useless.
    await expect(dialog.getByText(/checking open orders/i)).toHaveCount(0, { timeout: 15_000 })

    // The confirm button is disabled until the impact is known, so an enabled button is proof
    // the pre-flight query completed and was consumed.
    const confirm = dialog.getByRole('button', { name: /^(clear table|clear anyway)$/i })
    await expect(confirm).toBeEnabled({ timeout: 15_000 })

    await dialog.getByRole('button', { name: /^cancel$/i }).click()
    await expect(dialog).toBeHidden()
  })

  /**
   * THE MONEY PATH. Being wrong here loses money, and until now it was verified only by unit
   * test against hand-written arrays.
   */
  test('the dialog states exactly what the database says is owed', async ({ page }) => {
    const rows = await openOrdersForTable(TEST_ACTIVE_TABLE_NUMBER)
    const impact = summariseClearImpact(rows)
    const expected = clearTableConfirmationMessage(impact)

    await openClearDialog(page, TABLE_LABEL)
    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible({ timeout: 15_000 })

    // Exact text. The browser's own query must agree with the database, which is precisely the
    // agreement #176 broke.
    await expect(dialog.getByText(expected, { exact: false })).toBeVisible({ timeout: 15_000 })

    // The button and the warning must match the same verdict, in both directions.
    const confirm = dialog.getByRole('button', {
      name: impact.requiresConfirmation ? /^clear anyway$/i : /^clear table$/i,
    })
    await expect(confirm).toBeEnabled({ timeout: 15_000 })

    const warning = dialog.getByText(/this money is still owed/i)
    if (impact.requiresConfirmation) {
      await expect(warning).toBeVisible()
      await expect(dialog.getByText(/UNPAID/)).toBeVisible()
    } else {
      await expect(warning).toHaveCount(0)
    }

    await dialog.getByRole('button', { name: /^cancel$/i }).click()
  })
})

test.describe('staff without tables permissions', () => {
  // NOT COVERED while this skips. `.env.test` has no working password for the kitchen account —
  // STAGING_TEST_PASSWORD is stale for it — and resetting a staging password is an auth write
  // this change does not make. Set E2E_NOPERMS_PASSWORD to turn this on.
  test.skip(
    !process.env.E2E_NOPERMS_PASSWORD,
    'No E2E_NOPERMS_PASSWORD: the without-permissions case is NOT covered.',
  )
  test.use({ storageState: NOPERMS_STORAGE_STATE })

  /**
   * The kitchen role has no tables:* permissions, so `requireTablesPermission(TABLES_READ)` must
   * refuse the page outright. Asserted against a signed-in user, which is the case that matters:
   * `auth-routes.spec.ts` only ever covered signed-out.
   */
  test('/qr-codes is refused to a signed-in user without tables:read', async ({ page }) => {
    await page.goto('/qr-codes')
    await page.waitForLoadState('networkidle')

    const body = (await page.textContent('body')) ?? ''
    const url = page.url()

    const refused =
      !/\/qr-codes/.test(new URL(url).pathname) ||
      /don't have permission|do not have permission|unauthorized|not authorized|access denied|forbidden/i.test(
        body,
      )

    expect(
      refused,
      `expected /qr-codes to be refused without tables:read; landed on ${url}`,
    ).toBe(true)

    // Whatever the refusal looks like, the action itself must never be reachable.
    await expect(page.getByRole('button', { name: /more actions/i })).toHaveCount(0)
  })
})
