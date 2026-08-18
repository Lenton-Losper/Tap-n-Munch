/**
 * THE THREE-DOT MENU ON A TABLE CARD MUST OPEN AGAIN AFTER IT HAS BEEN USED.
 *
 * Reported from production: open the `…` on a Dining Tables card, use Clear table, and the `…`
 * cannot be opened again. A full page refresh is the only way back. Staff clearing several tables
 * in a row refresh between each one.
 *
 * WHY A BROWSER TEST. Every candidate cause is a DOM or focus-management state that only exists in
 * a running browser: React state not reset, a promise that never settles, an error swallowed
 * before cleanup, the menu unmounting mid-action, or — the one the source reading points at —
 * `pointer-events: none` left on `document.body` by the Radix Dialog/DropdownMenu interaction.
 * A unit test cannot tell those apart. This one MEASURES which, by reading the body's computed
 * style and the trigger's own state at the moment it is stuck.
 *
 * IT MUST FAIL AGAINST THE CURRENT BUILD before it passes.
 *
 * SEVERITY SPLIT, which the report needs: this also asserts the ACTION SUCCEEDED. "Clear table
 * works and only the control is dead" is a different problem from "the action silently failed",
 * and the two are indistinguishable from the screen.
 */
import { test, expect } from '@playwright/test'
import type { SupabaseClient } from '@supabase/supabase-js'
import { randomUUID } from 'crypto'
import { assertStagingDb, FIXTURE_RESTAURANT } from './lib/fixture'

let db: SupabaseClient
let tableIds: string[] = []
let staffUserId = ''
let staffEmail = ''
const password = process.env.STAGING_TEST_PASSWORD || ''

test.beforeAll(async () => {
  db = assertStagingDb()
  if (!password) {
    console.warn('[table-card-menu-reopens] SKIPPED — STAGING_TEST_PASSWORD unset. NOT a pass.')
    test.skip(true, 'STAGING_TEST_PASSWORD is unset — no staff session can be minted')
    return
  }

  staffEmail = `probe-e2e-menu-${randomUUID().slice(0, 8)}@flashtap-test.invalid`
  const { data: created, error: userErr } = await db.auth.admin.createUser({
    email: staffEmail,
    password,
    email_confirm: true,
  })
  if (userErr || !created?.user) throw new Error(`create staff user: ${userErr?.message}`)
  staffUserId = created.user.id

  // public.users mirror, then membership — restaurant_users.user_id is FK'd to public.users.
  const { error: mirrorErr } = await db
    .from('users')
    .insert({ id: staffUserId, email: staffEmail, full_name: 'probe menu', avatar_url: null })
  if (mirrorErr) throw new Error(`users mirror: ${mirrorErr.message}`)
  const { error: memberErr } = await db
    .from('restaurant_users')
    .insert({ restaurant_id: FIXTURE_RESTAURANT, user_id: staffUserId, role: 'owner' })
  if (memberErr) throw new Error(`membership: ${memberErr.message}`)

  /**
   * Two tables, because the reported symptom is "clearing several in a row".
   *
   * The number is cleared first. On a RETRY, `afterAll` has not run yet — Playwright retries the
   * test, not the file — so the previous attempt's rows are still there and a plain insert dies on
   * restaurant_tables_restaurant_id_table_number_key. That turned a real failure into a confusing
   * seed error on the retry line, hiding which assertion actually broke.
   */
  for (let i = 0; i < 2; i++) {
    const tableNumber = 9860 + Math.floor(Math.random() * 30) + i * 40
    await db
      .from('restaurant_tables')
      .delete()
      .eq('restaurant_id', FIXTURE_RESTAURANT)
      .eq('table_number', tableNumber)
    const { data, error } = await db
      .from('restaurant_tables')
      .insert({
        restaurant_id: FIXTURE_RESTAURANT,
        table_number: tableNumber,
        active: true,
        is_view_only: false,
        is_kiosk: false,
        status: 'available',
      })
      .select('id')
      .single()
    if (error) throw new Error(`seed table ${i} (number ${tableNumber}): ${error.message}`)
    tableIds.push(data.id)
  }
})

test.afterAll(async () => {
  for (const id of tableIds) await db.from('restaurant_tables').delete().eq('id', id)
  tableIds = []
  if (staffUserId) {
    await db.from('restaurant_users').delete().eq('user_id', staffUserId)
    await db.from('users').delete().eq('id', staffUserId)
    await db.auth.admin.deleteUser(staffUserId)
  }
})

async function signInAsStaff(page: import('@playwright/test').Page, baseURL: string) {
  await page.goto(`${baseURL}/signin`, { waitUntil: 'domcontentloaded' })
  await page.locator('input[type="email"]').first().fill(staffEmail)
  await page.locator('input[type="password"]').first().fill(password)
  await page.getByRole('button', { name: /sign in|log in|continue/i }).first().click()
  await page.waitForURL((u) => !/\/signin/i.test(u.pathname), { timeout: 40_000 })
}

test.describe('the table card three-dot menu', () => {
  test('opens again after Clear table, with no reload', async ({ page, baseURL }) => {
    await signInAsStaff(page, baseURL!)
    await page.goto(`${baseURL}/qr-codes`, { waitUntil: 'domcontentloaded' })

    const triggers = page.getByRole('button', { name: 'More actions' })
    await expect(
      triggers.first(),
      '[control] at least one table card with a … menu must be on screen',
    ).toBeVisible({ timeout: 40_000 })

    // FIRST USE.
    await triggers.first().click()
    const clear = page.getByRole('menuitem', { name: /clear table/i })
    await expect(clear, '[control] the menu must open and offer Clear table').toBeVisible({
      timeout: 15_000,
    })
    await clear.click()

    const confirm = page.getByRole('button', { name: /^clear table$/i }).last()
    await expect(confirm, '[control] the confirmation dialog must appear').toBeVisible({
      timeout: 15_000,
    })
    await expect(confirm).toBeEnabled({ timeout: 20_000 })
    await confirm.click()

    // THE ACTION MUST HAVE SUCCEEDED — a dead control and a failed action are different problems.
    await expect(
      page.getByText(/cleared|fresh session/i).first(),
      'the action itself must succeed; if it did not, the stuck menu is the smaller half',
    ).toBeVisible({ timeout: 30_000 })

    /**
     * THE MEASUREMENT. Read what is actually stuck rather than inferring it from the symptom.
     * Radix locks pointer events on the body while a modal is open, and leaves the lock behind
     * when a Dialog is opened from a DropdownMenuItem.
     *
     * WAIT FOR THE DIALOG TO GO FIRST. Taken immediately after the toast, the snapshot caught
     * `openDialogs: 1` — the dialog was still unmounting and still legitimately owned the lock, so
     * the reading said "locked" in both the broken and the fixed build and discriminated nothing.
     * A lock is only evidence once there is nothing left to own it.
     */
    await expect(page.locator('[role="dialog"]')).toHaveCount(0, { timeout: 15_000 })
    const diag = await page.evaluate(() => {
      const body = document.body
      const cs = getComputedStyle(body)
      const trig = document.querySelector('[aria-label="More actions"]') as HTMLElement | null
      return {
        bodyInlinePointerEvents: body.style.pointerEvents || '(none set)',
        bodyComputedPointerEvents: cs.pointerEvents,
        bodyDataScrollLocked: body.getAttribute('data-scroll-locked') ?? '(absent)',
        bodyAriaHidden: body.getAttribute('aria-hidden') ?? '(absent)',
        openDialogs: document.querySelectorAll('[role="dialog"]').length,
        triggerDisabled: trig?.hasAttribute('disabled') ?? null,
        triggerAriaExpanded: trig?.getAttribute('aria-expanded') ?? '(absent)',
        triggerPointerEvents: trig ? getComputedStyle(trig).pointerEvents : '(no trigger)',
      }
    })
    console.log('  MEASURED AFTER THE ACTION:', JSON.stringify(diag, null, 2))

    // THE ASSERTION: the menu opens a SECOND time, without a reload.
    await triggers.first().click()
    await expect(
      page.getByRole('menuitem').first(),
      'the … menu must open again after being used once — staff clearing several tables in a row ' +
        `must not have to reload. Measured state when stuck: ${JSON.stringify(diag)}`,
    ).toBeVisible({ timeout: 10_000 })
  })
})
