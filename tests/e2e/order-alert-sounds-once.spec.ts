/**
 * THE INCOMING-ORDER SOUND ALERT, IN A REAL BROWSER.
 *
 * The unit tests prove the policy. They cannot prove that a browser actually drives the audio
 * graph, that the autoplay unlock works against a real autoplay policy, or that the indicator
 * tells a staff member the truth. This does, end to end, against a real realtime INSERT.
 *
 * WHAT IS MEASURED, and how. `AudioContext.prototype.createOscillator` is wrapped before the page
 * script runs, so every tone the app produces increments a counter. That is the honest instrument:
 * it proves the audio graph was built and started.
 *
 * WHAT THIS DOES NOT PROVE, stated rather than implied: that a SPEAKER made a noise. That is
 * DEVICE-level and no automated browser test reaches it — a human has to listen once.
 *
 * THE AUTOPLAY POLICY IS LEFT AT ITS DEFAULT, deliberately. Launching with
 * `--autoplay-policy=no-user-gesture-required` would make the test pass while proving nothing
 * about the unlock, which is the part most likely to be broken in front of staff.
 *
 * TWO-SIDED: exactly ONE tone for a customer order that a staff member then accepts. Zero would
 * mean the alert is dead; two is the defect this feature exists to fix.
 */
import { test, expect } from '@playwright/test'
import type { SupabaseClient } from '@supabase/supabase-js'
import { randomUUID } from 'crypto'
import { assertStagingDb, FIXTURE_RESTAURANT } from './lib/fixture'

let db: SupabaseClient
let staffUserId = ''
let staffEmail = ''
let tableId = ''
let tabId = ''
let menuItemId = ''
let requestId = ''
const password = process.env.STAGING_TEST_PASSWORD || ''
const tableNumber = 9600 + Math.floor(Math.random() * 80)

test.beforeAll(async () => {
  db = assertStagingDb()
  if (!password) {
    console.warn('[order-alert] SKIPPED — STAGING_TEST_PASSWORD unset. This is NOT a pass.')
    test.skip(true, 'STAGING_TEST_PASSWORD is unset — no staff session can be minted')
    return
  }

  staffEmail = `probe-e2e-alert-${randomUUID().slice(0, 8)}@flashtap-test.invalid`
  const { data: created, error: userErr } = await db.auth.admin.createUser({
    email: staffEmail,
    password,
    email_confirm: true,
  })
  if (userErr || !created?.user) throw new Error(`create staff user: ${userErr?.message}`)
  staffUserId = created.user.id

  await db.from('users').insert({ id: staffUserId, email: staffEmail, full_name: 'probe alert', avatar_url: null })
  const { error: memberErr } = await db
    .from('restaurant_users')
    .insert({ restaurant_id: FIXTURE_RESTAURANT, user_id: staffUserId, role: 'owner' })
  if (memberErr) throw new Error(`membership: ${memberErr.message}`)

  await db.from('restaurant_tables').delete().eq('restaurant_id', FIXTURE_RESTAURANT).eq('table_number', tableNumber)
  const { data: tbl, error: tErr } = await db
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
  tableId = tbl.id

  const { data: mi, error: mErr } = await db
    .from('menu_items')
    .insert({
      restaurant_id: FIXTURE_RESTAURANT,
      name: `alert-${randomUUID().slice(0, 6)}`,
      base_price: 40,
      status: 'available',
      track_inventory: false,
    })
    .select('id, name')
    .single()
  if (mErr) throw new Error(`seed menu item: ${mErr.message}`)
  menuItemId = mi.id
})

test.afterAll(async () => {
  if (requestId) await db.from('order_requests').delete().eq('id', requestId)
  if (tabId) {
    await db.from('orders').delete().eq('tab_id', tabId)
    await db.from('order_requests').delete().eq('tab_id', tabId)
    await db.from('customer_sessions').delete().eq('tab_id', tabId)
    await db.from('tabs').delete().eq('id', tabId)
  }
  if (tableId) await db.from('restaurant_tables').delete().eq('id', tableId)
  if (menuItemId) await db.from('menu_items').delete().eq('id', menuItemId)
  if (staffUserId) {
    await db.from('restaurant_users').delete().eq('user_id', staffUserId)
    await db.from('users').delete().eq('id', staffUserId)
    await db.auth.admin.deleteUser(staffUserId)
  }
})

test.describe('the incoming-order sound alert', () => {
  test('arms explicitly, then sounds ONCE for an order that is submitted and accepted', async ({
    page,
    baseURL,
  }) => {
    // Count every tone the app produces, before any page script runs.
    await page.addInitScript(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const w = window as any
      w.__toneCount = 0
      const Ctx = w.AudioContext || w.webkitAudioContext
      if (!Ctx) return
      const original = Ctx.prototype.createOscillator
      Ctx.prototype.createOscillator = function patched(this: AudioContext) {
        w.__toneCount += 1
        return original.call(this)
      }
    })

    await page.goto(`${baseURL}/signin`, { waitUntil: 'domcontentloaded' })
    await page.locator('input[type="email"]').first().fill(staffEmail)
    await page.locator('input[type="password"]').first().fill(password)
    await page.getByRole('button', { name: /sign in|log in|continue/i }).first().click()
    await page.waitForURL((u) => !/\/signin/i.test(u.pathname), { timeout: 40_000 })

    await page.goto(`${baseURL}/dashboard`, { waitUntil: 'domcontentloaded' })

    const indicator = page.getByTestId('order-alert-indicator')
    await expect(indicator, '[control] the sound indicator must be on screen at all').toBeVisible({
      timeout: 40_000,
    })

    /**
     * BEFORE ANY INTERACTION it must not claim to be armed. This is the constraint that matters
     * most: a dashboard that says sound is on while the browser is blocking it is worse than one
     * that says nothing, because staff stop watching the screen.
     */
    expect(
      await indicator.getAttribute('data-alert-state'),
      'must not claim to be armed before the browser has granted audio',
    ).not.toBe('armed')

    // The click IS the gesture the autoplay policy is waiting for.
    await indicator.click()
    await expect(
      indicator,
      'clicking the indicator must actually arm the audio, not just relabel it',
    ).toHaveAttribute('data-alert-state', 'armed', { timeout: 15_000 })

    const before = await page.evaluate(() => (window as unknown as { __toneCount: number }).__toneCount)

    // ---- a real customer submission, over real realtime
    const sessionId = `probe-alert-${randomUUID()}`
    const { data: tab, error: tabErr } = await db
      .from('tabs')
      .insert({
        restaurant_id: FIXTURE_RESTAURANT,
        table_id: tableId,
        table_number: tableNumber,
        status: 'open',
        session_version: 1,
      })
      .select('id')
      .single()
    if (tabErr) throw new Error(`seed tab: ${tabErr.message}`)
    tabId = tab.id

    const { data: req, error: reqErr } = await db
      .from('order_requests')
      .insert({
        restaurant_id: FIXTURE_RESTAURANT,
        tab_id: tabId,
        table_number: tableNumber,
        session_id: sessionId,
        member_session_id: sessionId,
        channel: 'table',
        status: 'waiting_review',
        items: [{ menuItemId, name: 'alert item', displayName: 'alert item', quantity: 1, unitPrice: 40, subtotal: 34.78, tax: 5.22, total: 40 }],
        subtotal: 34.78,
        tax: 5.22,
        total: 40,
        placed_at: new Date().toISOString(),
      })
      .select('id')
      .single()
    if (reqErr) throw new Error(`seed request: ${reqErr.message}`)
    requestId = req.id

    // The request must reach the screen, or nothing below is about sound.
    await expect(
      page.getByText(/waiting for review/i).first(),
      '[control] the realtime INSERT must reach this dashboard',
    ).toBeVisible({ timeout: 40_000 })

    await expect
      .poll(
        async () => page.evaluate(() => (window as unknown as { __toneCount: number }).__toneCount),
        { timeout: 20_000, message: 'the customer submission must produce exactly one tone' },
      )
      .toBe(before + 2) // a two-tone chime is two oscillators — see playNewOrderSound

    /**
     * ---- staff accept it: createOrder writes an `orders` row at status 'pending'
     *
     * SCOPED TO THIS TEST'S OWN REQUEST, and that is not fussiness. The first run used
     * `getByRole('button', {name: /accept order/i}).first()` and the staging fixture restaurant
     * had FIVE waiting-review requests on it — shared debris from other work — so it accepted
     * somebody else's order and then waited for a toast about it. Two defects in one line: the
     * assertion tested nothing, and the test mutated data it did not own.
     */
    const myCard = page.locator(`[data-request-id="${requestId}"]`)
    const acceptBtn = myCard.getByRole('button', { name: /accept order/i }).first()
    await expect(
      acceptBtn,
      `[control] the Accept control on THIS test's own request (${requestId}) must be present`,
    ).toBeVisible({ timeout: 20_000 })
    await acceptBtn.click()

    /**
     * The request LEAVING the review list is the success signal, not a toast. A toast auto-
     * dismisses, so waiting 30s for one is a race the test can lose while the accept succeeded —
     * which is exactly what happened on the first run.
     */
    await expect
      .poll(
        async () => {
          const { data } = await db.from('order_requests').select('status').eq('id', requestId).single()
          return String(data?.status ?? 'gone')
        },
        { timeout: 40_000, message: 'the accept must actually land, or the silence below is for the wrong reason' },
      )
      .toBe('accepted')

    /**
     * THE ASSERTION. The accepted order arrives back over realtime as an `orders` INSERT at
     * status 'pending' — the second chime this feature exists to remove. Waiting a fixed moment
     * rather than polling, because the claim is that NOTHING happens, and a poll that succeeds
     * immediately would prove nothing.
     */
    await page.waitForTimeout(6_000)
    const after = await page.evaluate(() => (window as unknown as { __toneCount: number }).__toneCount)
    expect(
      after,
      'accepting an order must not chime at the staff member who accepted it',
    ).toBe(before + 2)
  })
})
