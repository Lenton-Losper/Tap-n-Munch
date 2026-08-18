/**
 * AN UNANSWERED REQUEST IS VISIBLE, AND IT RANKS FIRST.
 *
 * Production had a submission open for 477 HOURS. That is not staff ignoring a customer — nothing
 * told them. Every writer of `order_requests.status` is a human action, the every-2-minutes cron
 * sweeps `orders` only, and no surface aged or ranked a request, so an unanswered one was
 * indistinguishable from one placed thirty seconds ago until somebody scrolled.
 *
 * WHY A BROWSER TEST. The predicate and the comparator are unit-tested in
 * __tests__/overdue-request-signal.test.ts. What only a browser can show is that the aged request
 * actually reaches the top of the rendered queue and carries a visible marker — "sorted to the
 * top, not merely marked" is a render property, and a flag nobody scrolls to is the same defect in
 * a different colour.
 *
 * READ-ONLY IN SPIRIT: the dashboard change sorts and labels. This spec seeds rows to look at and
 * deletes them again; it never asserts a status change, because the change under test makes none.
 */
import { test, expect } from '@playwright/test'
import type { SupabaseClient } from '@supabase/supabase-js'
import { randomUUID } from 'crypto'
import { assertStagingDb, FIXTURE_RESTAURANT } from './lib/fixture'

let db: SupabaseClient
let requestIds: string[] = []
let tableId = ''
let tableNumber = 0
let staffUserId = ''
let staffEmail = ''

const MIN = 60 * 1000
const password = process.env.STAGING_TEST_PASSWORD || ''

test.beforeAll(async () => {
  db = assertStagingDb()
  if (!password) {
    throw new Error(
      'REFUSING: STAGING_TEST_PASSWORD is unset, so no staff session can be minted and the ' +
        'dashboard cannot be reached. This would otherwise look like "the banner is absent".',
    )
  }

  // A staff user that owns the fixture restaurant, created and torn down by this spec.
  staffEmail = `probe-e2e-overdue-${randomUUID().slice(0, 8)}@flashtap-test.invalid`
  const { data: created, error: userErr } = await db.auth.admin.createUser({
    email: staffEmail,
    password,
    email_confirm: true,
  })
  if (userErr || !created?.user) throw new Error(`create staff user: ${userErr?.message}`)
  staffUserId = created.user.id

  /**
   * A `public.users` MIRROR ROW. `restaurant_users.user_id` is FK'd to `public.users`, not to
   * `auth.users`, so creating the auth user alone fails with restaurant_users_user_id_fkey. The
   * app does this in lib/auth/ensure-public-user.ts on first sign-in; a spec that mints a user
   * out of band has to do it too.
   */
  const { error: mirrorErr } = await db
    .from('users')
    .insert({ id: staffUserId, email: staffEmail, full_name: 'probe overdue', avatar_url: null })
  if (mirrorErr) throw new Error(`create public.users mirror: ${mirrorErr.message}`)

  /**
   * `restaurant_users` is the MEMBERSHIP table. `restaurant_roles` is the role DEFINITION table
   * (restaurant_id + role_slug) and has no user_id at all — inserting a membership there fails
   * with "Could not find the 'role' column", which is how I learned the difference.
   * See getUserRole in lib/permissions/authorize.ts.
   */
  const { error: roleErr } = await db.from('restaurant_users').insert({
    restaurant_id: FIXTURE_RESTAURANT,
    user_id: staffUserId,
    role: 'owner',
  })
  if (roleErr) throw new Error(`grant staff membership: ${roleErr.message}`)

  // A table for the seeded requests to belong to, in this spec's own range.
  tableNumber = 9850 + Math.floor(Math.random() * 140)
  const { data: t, error: tErr } = await db
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
  if (tErr) throw new Error(`seed table: ${tErr.message}`)
  tableId = t.id
})

test.afterAll(async () => {
  for (const id of requestIds) await db.from('order_requests').delete().eq('id', id)
  if (tableId) await db.from('restaurant_tables').delete().eq('id', tableId)
  if (staffUserId) {
    await db.from('restaurant_users').delete().eq('user_id', staffUserId)
    await db.from('users').delete().eq('id', staffUserId)
    await db.auth.admin.deleteUser(staffUserId)
  }
})

/** A waiting_review submission placed `minutesAgo` in the past. */
async function seedWaitingRequest(minutesAgo: number, itemName: string) {
  const placedAt = new Date(Date.now() - minutesAgo * MIN).toISOString()
  const { data, error } = await db
    .from('order_requests')
    .insert({
      restaurant_id: FIXTURE_RESTAURANT,
      table_id: tableId,
      table_number: tableNumber,
      session_id: `probe-e2e-overdue-${randomUUID()}`,
      channel: 'table',
      status: 'waiting_review',
      items: [{ name: itemName, displayName: itemName, quantity: 1, unitPrice: 25, total: 25 }],
      subtotal: 21.74,
      tax: 3.26,
      total: 25,
      payment_method: 'cash',
      placed_at: placedAt,
    })
    .select('id')
    .single()
  if (error) throw new Error(`seedWaitingRequest(${minutesAgo}m): ${error.message}`)
  requestIds.push(data.id)
  return data.id
}

/**
 * SIGN IN THROUGH THE FORM.
 *
 * A first attempt injected a Supabase session straight into localStorage, the way `adoptSession`
 * does for the customer side. It did not take — the dashboard redirected to /signin, and the
 * control above caught it, which is exactly what a control is for. The storage key and encoding
 * are the auth library's private business and guessing them is a test that breaks on a dependency
 * bump for reasons unrelated to what it asserts.
 *
 * The form is slower and real. Worth it here: this spec is the only staff-side browser test, so
 * it is also the only thing proving a staff session can reach the dashboard at all.
 */
async function signInAsStaff(page: import('@playwright/test').Page, baseURL: string) {
  await page.goto(`${baseURL}/signin`, { waitUntil: 'domcontentloaded' })
  await page.locator('input[type="email"]').first().fill(staffEmail)
  await page.locator('input[type="password"]').first().fill(password)
  await page.getByRole('button', { name: /sign in|log in|continue/i }).first().click()
  await page.waitForURL((u) => !/\/signin/i.test(u.pathname), { timeout: 40_000 })
}

async function openWaitingForReview(page: import('@playwright/test').Page, baseURL: string) {
  await page.goto(`${baseURL}/dashboard`, { waitUntil: 'domcontentloaded' })
  await expect(
    page.getByRole('button', { name: /waiting for review/i }).first(),
    '[control] the dashboard must render its tabs — if it redirected to sign-in, nothing below ' +
      'is about the queue',
  ).toBeVisible({ timeout: 40_000 })
  await page.getByRole('button', { name: /waiting for review/i }).first().click()
}

test.describe('the Waiting for Review queue', () => {
  test('an aged request is flagged and ranks above a fresh one', async ({ page, baseURL }) => {
    const stale = `overdue-${randomUUID().slice(0, 6)}`
    const fresh = `fresh-${randomUUID().slice(0, 6)}`
    // Seeded fresh-FIRST and aged-second, so passing cannot be an artefact of insertion order.
    await seedWaitingRequest(1, fresh)
    await seedWaitingRequest(240, stale)

    await signInAsStaff(page, baseURL!)
    await openWaitingForReview(page, baseURL!)

    // POSITIVE CONTROL: both must be on screen. "The aged one is first" is also true of a queue
    // showing only the aged one, or of an empty queue.
    const cards = page.locator('.grid.gap-4 > div')
    await expect(page.getByText(stale, { exact: false })).toHaveCount(1, { timeout: 30_000 })
    await expect(page.getByText(fresh, { exact: false })).toHaveCount(1)

    /**
     * SCOPED TO THIS SPEC'S OWN CARDS, not counted globally.
     *
     * The staging fixture restaurant carries REAL aged debris — the first run of this test found
     * TEN already-overdue requests sitting there, which is the same finding as production one
     * environment down. A global `toHaveCount(1)` asserted that the world contains exactly one
     * overdue request, which is not what this test is about.
     */
    const cardFor = (name: string) =>
      page.locator('.grid.gap-4 > div').filter({ hasText: new RegExp(name, 'i') })

    await expect(
      cardFor(stale).locator('[data-testid="request-overdue"]'),
      'the aged request must carry the marker',
    ).toHaveCount(1)
    await expect(cardFor(stale).locator('[data-testid="request-overdue"]')).toContainText(
      /waiting \d+ min/i,
    )
    await expect(
      cardFor(fresh).locator('[data-testid="request-overdue"]'),
      'a one-minute-old request must NOT be marked',
    ).toHaveCount(0)

    // THE QUEUE-LEVEL COUNT, which is what someone sees before scrolling at all. Asserted on its
    // SHAPE rather than an exact number, for the same debris reason.
    const banner = page.locator('[data-testid="overdue-requests-banner"]')
    await expect(banner).toBeVisible()
    await expect(banner).toContainText(/waiting more than 15 minutes with no answer/i)
    await expect(banner).toContainText(/at the top of this list/i)

    // THE RANKING. Read the rendered order and require the aged one strictly above the fresh one.
    const text = (await page.locator('body').innerText()).replace(/\s+/g, ' ')
    const staleAt = text.indexOf(stale)
    const freshAt = text.indexOf(fresh)
    expect(staleAt, '[control] the aged request must appear in the page text').toBeGreaterThan(-1)
    expect(freshAt, '[control] the fresh request must appear in the page text').toBeGreaterThan(-1)
    expect(
      staleAt,
      `the aged request must be ABOVE the fresh one — sorted to the top, not merely marked. ` +
        `aged at ${staleAt}, fresh at ${freshAt}`,
    ).toBeLessThan(freshAt)
    void cards
  })

  test('a queue of only fresh requests is not flagged at all', async ({ page, baseURL }) => {
    // The other side, and the one that matters most: a signal that fires on ordinary service is
    // ignored, which is the failure this exists to fix.
    const a = `recent-a-${randomUUID().slice(0, 6)}`
    const b = `recent-b-${randomUUID().slice(0, 6)}`
    await seedWaitingRequest(2, a)
    await seedWaitingRequest(9, b)

    await signInAsStaff(page, baseURL!)
    await openWaitingForReview(page, baseURL!)

    await expect(
      page.getByText(a, { exact: false }),
      '[control] the fresh requests must be on screen, or "no banner" proves nothing',
    ).toHaveCount(1, { timeout: 30_000 })
    await expect(page.getByText(b, { exact: false })).toHaveCount(1)

    /**
     * Neither fresh row may be marked. Asserted per-card rather than as "no marker anywhere",
     * because the fixture restaurant genuinely holds other overdue requests — see above.
     */
    const cardFor = (name: string) =>
      page.locator('.grid.gap-4 > div').filter({ hasText: new RegExp(name, 'i') })
    await expect(cardFor(a).locator('[data-testid="request-overdue"]')).toHaveCount(0)
    await expect(cardFor(b).locator('[data-testid="request-overdue"]')).toHaveCount(0)
  })
})
