/**
 * THE EDITOR COMMITS WHAT THE SCREEN SHOWS — section 3 and section 25, in a real browser.
 *
 * WHY THIS HAS TO BE A BROWSER TEST. The derivation is unit-tested to death in
 * __tests__/edit-panel-rows.test.ts, and none of that would have caught the defect this replaces:
 * the panel held TWO lists (a working quantity that `-` decremented, and an `additions` array that
 * `+` appended to), and the disagreement only existed in the wiring between them. From a stored 2,
 * pressing `+` twice and `-` three times showed 1 and committed 2. Every module involved was
 * individually correct.
 *
 * SO THE ASSERTION IS ON THE COMMITTED ROW, not on the screen. A screen-only check passes for a
 * panel that renders the right number and sends the wrong one — which is precisely the failure.
 *
 * POINT THIS AT THE BRANCH. playwright.config.ts resolves `baseURL` to the DEPLOYED staging worker
 * unless E2E_BASE_URL says otherwise, and .env.test loads too late to change it. A run without
 * that variable tests code that is not this branch and can pass with the defect reintroduced, so
 * the guard below refuses rather than reporting a false green.
 */
import { test, expect } from '@playwright/test'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  assertStagingDb,
  seedTableWithOrder,
  adoptSession,
  teardown,
  FIXTURE_RESTAURANT,
  type Fixture,
} from './lib/fixture'

/**
 * The EDITOR's row for an item, not the read-only summary above it.
 *
 * The confirmation screen prints the order twice: a summary list, and — once the editor is open —
 * an editable row per logical item. A bare text match on `2x <name>` hits both and Playwright
 * refuses it as a strict-mode violation, which is the right refusal: a test that matched the
 * SUMMARY would report the stepper working while it did nothing at all.
 *
 * Bound by the Reduce button, which exists only inside the editor row.
 */
function editorRow(page: import('@playwright/test').Page, itemName: string) {
  return page
    .locator('div.flex.items-center.justify-between')
    .filter({ has: page.getByRole('button', { name: `Reduce ${itemName}` }) })
}

let db: SupabaseClient
let fixture: Partial<Fixture> = {}

test.beforeAll(async ({ baseURL }) => {
  db = assertStagingDb()
  if (!process.env.E2E_BASE_URL) {
    throw new Error(
      'REFUSING: E2E_BASE_URL is unset, so this would run against the DEPLOYED worker rather ' +
        'than the working tree. Start `next dev` and set E2E_BASE_URL to it.',
    )
  }
  const res = await fetch(`${baseURL}/menu/${FIXTURE_RESTAURANT}/session-ended`)
  if (!res.ok) throw new Error(`the app at ${baseURL} is not serving (${res.status})`)
})

test.afterEach(async () => {
  await teardown(db, fixture)
  fixture = {}
})

/** The order's lines as STORED, which is the only account of what was actually committed. */
async function storedQuantity(orderId: string, itemName: string): Promise<number> {
  const { data, error } = await db.from('orders').select('items').eq('id', orderId).single()
  if (error) throw new Error(`read order: ${error.message}`)
  const items = (data?.items ?? []) as Array<Record<string, unknown>>
  return items
    .filter((i) => String(i.name ?? i.displayName ?? '') === itemName)
    .reduce((sum, i) => sum + (Number(i.quantity) || 1), 0)
}

test.describe('the order editor', () => {
  /**
   * SECTION 3, THE SEQUENCE THAT WAS WRONG. Two stored, press `+` twice and `-` three times, and
   * the order must end up holding ONE.
   *
   * Before the rewrite this committed TWO: the three `-` presses reduced `keep` to nothing while
   * both `+` presses sat untouched in a separate additions list.
   */
  test('2 -> 4 -> 1 commits ONE, not two', async ({ page, baseURL }) => {
    const f = await seedTableWithOrder(db, { price: 25 })
    fixture = f

    // Two of the item, in one stored line.
    const { error: seedErr } = await db
      .from('orders')
      .update({
        items: [
          {
            menuItemId: f.menuItemIds[0],
            name: f.itemName,
            displayName: f.itemName,
            quantity: 2,
            unitPrice: 25,
            subtotal: 43.48,
            tax: 6.52,
            total: 50,
            size: null,
            addons: [],
            selectedVariants: {},
            specialInstructions: '',
          },
        ],
        subtotal: 43.48,
        tax: 6.52,
        total: 50,
        status: 'accepted',
        payment_status: 'pending',
      })
      .eq('id', f.orderId)
    if (seedErr) throw new Error(`seed two: ${seedErr.message}`)

    const context = page.context()
    await adoptSession(context, baseURL!, f)
    await page.goto(
      `${baseURL}/menu/${FIXTURE_RESTAURANT}/order-confirmation/${f.orderId}?table=${f.tableNumber}`,
      { waitUntil: 'domcontentloaded' },
    )

    // Open the editor.
    await page.getByRole('button', { name: /change|edit/i }).first().click()

    const plus = page.getByRole('button', { name: new RegExp(`— ${f.itemName}$`) }).first()
    const minus = page.getByRole('button', { name: `Reduce ${f.itemName}` })

    /**
     * THE POSITIVE CONTROL. If the stepper is not wired at all, every press is a no-op and the
     * order stays at 2 — which is ALSO not 2-after-the-sequence, so the assertion below would be
     * measuring a dead control. Prove one press moves the screen before pressing seven.
     */
    await expect(editorRow(page, f.itemName)).toContainText('2×', { timeout: 20_000 })
    await plus.click()
    await expect(
      editorRow(page, f.itemName),
      '[control] one press of + must move the number on screen from 2 to 3. If this fails the ' +
        'sequence below proves nothing about the derivation — fix the wiring, not the assertion.',
    ).toContainText('3×', { timeout: 10_000 })

    await plus.click() // 4
    await minus.click() // 3
    await minus.click() // 2
    await minus.click() // 1
    await expect(editorRow(page, f.itemName)).toContainText('1×')

    await page.getByRole('button', { name: /^save/i }).click()

    /**
     * Wait for the EDITOR TO CLOSE, not for the confirmation sentence.
     *
     * The commit spends the lock and the panel collapses back to "Change this order", so the
     * notice the route returns is transient — asserting on it made this test fail while the save
     * had in fact landed correctly. The editor row disappearing is the stable signal that the
     * request completed, and the committed row below is the actual assertion.
     */
    await expect(editorRow(page, f.itemName)).toHaveCount(0, { timeout: 20_000 })

    // THE ASSERTION: what was COMMITTED, not what was rendered.
    await expect
      .poll(() => storedQuantity(f.orderId, f.itemName), { timeout: 15_000 })
      .toBe(1)
  })

  /**
   * SECTION 3 AGAIN: down and back up is a NO-OP. The screen returns to where it started and Save
   * must have nothing to send — not a reduction cancelled by an addition, which would reprice the
   * line at today's menu price for no reason and split it into two stored lots.
   */
  test('2 -> 1 -> 2 leaves the order in ONE lot, unchanged', async ({ page, baseURL }) => {
    const f = await seedTableWithOrder(db, { price: 25 })
    fixture = f

    const { error: seedErr } = await db
      .from('orders')
      .update({
        items: [
          {
            menuItemId: f.menuItemIds[0],
            name: f.itemName,
            displayName: f.itemName,
            quantity: 2,
            unitPrice: 25,
            subtotal: 43.48,
            tax: 6.52,
            total: 50,
            size: null,
            addons: [],
            selectedVariants: {},
            specialInstructions: '',
          },
        ],
        subtotal: 43.48,
        tax: 6.52,
        total: 50,
        status: 'accepted',
        payment_status: 'pending',
      })
      .eq('id', f.orderId)
    if (seedErr) throw new Error(`seed two: ${seedErr.message}`)

    await adoptSession(page.context(), baseURL!, f)
    await page.goto(
      `${baseURL}/menu/${FIXTURE_RESTAURANT}/order-confirmation/${f.orderId}?table=${f.tableNumber}`,
      { waitUntil: 'domcontentloaded' },
    )
    await page.getByRole('button', { name: /change|edit/i }).first().click()
    await expect(editorRow(page, f.itemName)).toContainText('2×', { timeout: 20_000 })

    await page.getByRole('button', { name: `Reduce ${f.itemName}` }).click()
    await expect(editorRow(page, f.itemName)).toContainText('1×')
    await page.getByRole('button', { name: new RegExp(`— ${f.itemName}$`) }).first().click()
    await expect(editorRow(page, f.itemName)).toContainText('2×')

    /**
     * SAVE MUST BE DISABLED. This is the whole assertion, and an earlier version of this test got
     * it wrong in a way worth recording: it read the order back from the database and checked it
     * was unchanged, WITHOUT pressing Save. That passes for any implementation whatsoever — the
     * order is unchanged because nothing was sent. A deliberately broken derivation was run
     * against it and it still went green.
     *
     * `unchanged` is the property under test: down and back up is a NO-OP, not a reduction
     * cancelled by an addition. An implementation that emitted `add: 1` alongside `keep: 1` would
     * enable this button, and would split one lot into two at today's menu price on commit.
     */
    await expect(
      page.getByRole('button', { name: /^save/i }),
      'after 2 -> 1 -> 2 the order is exactly as it was, so there must be nothing to send',
    ).toBeDisabled()

    const { data } = await db.from('orders').select('items').eq('id', f.orderId).single()
    const items = (data?.items ?? []) as Array<Record<string, unknown>>
    expect(items).toHaveLength(1)
    expect(Number(items[0].quantity)).toBe(2)
  })
})

/**
 * SECTION 20 — the controls are reachable with a thumb, and section 3's cap stop.
 *
 * 44 CSS pixels is not a number picked here: it is what the CART's own stepper uses
 * (components/menu/item-detail-modal.tsx, `h-11 w-11`). The editor's controls were 28px, so the
 * same customer met two different targets for the same gesture on two screens.
 *
 * The cap stop is measured in the same test because it is the same button: #307 made the ceiling
 * apply to the RESULTING quantity of a logical item, which is exactly what a row holds, and the
 * cart disables `+` there rather than letting a customer build an edit the server will refuse
 * after they have committed to it.
 */
test.describe('the editor’s controls', () => {
  test('are at least 44px, and the raise stops at the cap', async ({ page, baseURL }) => {
    const f = await seedTableWithOrder(db, { price: 5 })
    fixture = f

    const { error: seedErr } = await db
      .from('orders')
      .update({
        items: [
          {
            menuItemId: f.menuItemIds[0],
            name: f.itemName,
            displayName: f.itemName,
            quantity: 19,
            unitPrice: 5,
            subtotal: 82.61,
            tax: 12.39,
            total: 95,
            size: null,
            addons: [],
            selectedVariants: {},
            specialInstructions: '',
          },
        ],
        subtotal: 82.61,
        tax: 12.39,
        total: 95,
        status: 'accepted',
        payment_status: 'pending',
      })
      .eq('id', f.orderId)
    if (seedErr) throw new Error(`seed nineteen: ${seedErr.message}`)

    await adoptSession(page.context(), baseURL!, f)
    await page.goto(
      `${baseURL}/menu/${FIXTURE_RESTAURANT}/order-confirmation/${f.orderId}?table=${f.tableNumber}`,
      { waitUntil: 'domcontentloaded' },
    )
    await page.getByRole('button', { name: /change|edit/i }).first().click()
    await expect(editorRow(page, f.itemName)).toContainText('19×', { timeout: 20_000 })

    for (const control of [`Reduce ${f.itemName}`, `Remove ${f.itemName}`]) {
      const box = await page.getByRole('button', { name: control }).boundingBox()
      expect(box, `${control} must be on screen to be measured`).not.toBeNull()
      expect(box!.width, `${control} width`).toBeGreaterThanOrEqual(44)
      expect(box!.height, `${control} height`).toBeGreaterThanOrEqual(44)
    }

    // THE CAP. 19 -> 20 is allowed; 20 -> 21 is not, and the control says so rather than going
    // dead silently.
    const plus = page.getByRole('button', { name: new RegExp(`— ${f.itemName}$`) }).first()
    await expect(plus, '[control] at 19 the raise must still be offered').toBeEnabled()
    await plus.click()
    await expect(editorRow(page, f.itemName)).toContainText('20×')
    await expect(page.getByRole('button', { name: /Maximum 20 per item/ })).toBeDisabled()
  })
})
