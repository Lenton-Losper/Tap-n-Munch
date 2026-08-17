/**
 * The Active Order Banner is a PERSONAL surface. It must never show a stranger's order.
 *
 * WHY THIS EXISTS, and why it has to be a browser test. #302/#305 made
 * `redactGuestOrderMemberIds` strip `session_id` from rows the caller does not own.
 * `fetchGuestActiveTableOrders` is a TABLE-WIDE read, and `hooks/useActiveOrders` filtered it with:
 *
 *     if (orderSession && orderSession !== scopedSessionId) return false
 *
 * Once the field is redacted, `orderSession` is '', the whole condition is falsy, the guard is
 * SKIPPED, and another diner's order — number, items and total — reaches `setActiveOrder`. A fix
 * for a disclosure defect introduced a disclosure defect. It shipped to production and was rolled
 * back within the hour.
 *
 * NOTHING SERVER-SIDE COULD SEE IT. The chain probe and the production read-only probe both read
 * JSON and assert on the response body; the response was CORRECT — the ids were properly stripped.
 * The defect was entirely in what the client did with the absence. Only a browser can observe a
 * client-side filter, which is why this check is here rather than in a probe.
 *
 * THE POSITIVE CONTROL IS THE WHOLE POINT. "Phone B does not show Order #123" is also true when
 * the banner never renders at all, when the fixture is stale, when the table number is wrong, and
 * when the selector is broken. So phone A — the actual owner — must SHOW the same order in the
 * same run. Without that, this test passes for the wrong reason forever.
 *
 * Seen to fail: against `14b32cc` (the rolled-back production commit) and against
 * `cloudflare-staging` before the guard was fixed, phone B rendered phone A's order number.
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

test.beforeAll(async ({ baseURL }) => {
  db = assertStagingDb()
  await assertServedAppUsesStaging(baseURL!)
})

test.afterEach(async () => {
  await teardown(db, fixture)
  fixture = {}
})

/**
 * The banner prints `orderIdentityLabel(order)` since #308: `Order #<n>` when a number was
 * allocated, and the signed-off not-yet-numbered phrase when none was.
 *
 * This used to compute `id.slice(-6).toUpperCase()`, which is the derivation #308 REMOVED - the
 * spec had the defect written into its own expectation, so it broke the moment the defect was
 * fixed. The fixture now allocates a real number, which is what a banner-visibility test needs
 * anyway: a stable identifier to assert on.
 */
function bannerLabelFor(order: { order_number: number }): string {
  return String(order.order_number)
}

test.describe('the Active Order Banner shows only the caller’s own order', () => {
  test('a second diner at the same table does not see the first diner’s order', async ({
    browser,
    baseURL,
  }) => {
    const f = await seedTableWithOrder(db)
    fixture = f

    // Phone A owns the seeded order. Phone B is a different diner at the same table, with a
    // session that owns nothing.
    // Allocate a real order number. seedTableWithOrder leaves it null, and since #308 an
    // unnumbered order deliberately shows no identifier at all - which would leave this test's
    // positive control with nothing to look for.
    const allocated = 900000 + Math.floor(Math.random() * 99999)
    const { error: numErr } = await db
      .from('orders')
      .update({ order_number: allocated })
      .eq('id', f.orderId)
    if (numErr) throw new Error(`allocate order_number: ${numErr.message}`)

    const label = bannerLabelFor({ order_number: allocated })
    const strangerSessionId = `probe-e2e-stranger-${randomUUID()}`

    const ctxA = await browser.newContext()
    const ctxB = await browser.newContext()
    await adoptSession(ctxA, baseURL!, f)
    // Same tab and table — only the session differs. This is the shared-table case, not an
    // attacker: two ordinary diners scanning the same QR code.
    await adoptSession(ctxB, baseURL!, { ...f, sessionId: strangerSessionId })

    const pageA = await ctxA.newPage()
    const pageB = await ctxB.newPage()
    /**
     * `/v2`, not `/browse`. The banner is mounted by `v2/page.tsx` on BOTH branches — the redesign
     * moved it off `browse`, where only a comment about it remains. Pointing this at `browse` made
     * the positive control fail, which is how I learned the difference rather than writing a
     * passing test against a screen that renders no banner at all.
     */
    const url = `${baseURL}/menu/${FIXTURE_RESTAURANT}/v2?table=${f.tableNumber}`

    await Promise.all([
      pageA.goto(url, { waitUntil: 'domcontentloaded' }),
      pageB.goto(url, { waitUntil: 'domcontentloaded' }),
    ])

    /**
     * THE POSITIVE CONTROL. The owner must see their own order, or the negative assertion below
     * is measuring an empty screen. Generous timeout: the banner polls rather than rendering on
     * first paint.
     */
    const ownerBanner = pageA.getByText(new RegExp(`Order\\s*#\\s*${label}\\b`, 'i')).first()
    await expect(
      ownerBanner,
      `[control] phone A owns order ${f.orderId} and must see "Order #${label}" in its banner. ` +
        'If this fails the negative assertion below proves nothing — fix the fixture, not the guard.',
    ).toBeVisible({ timeout: 30_000 })

    // THE ASSERTION. Give phone B at least as long as phone A took, so this is not just a race
    // that phone B happened to lose.
    await pageB.waitForTimeout(6_000)
    const strangerText = (await pageB.locator('body').innerText()).replace(/\s+/g, ' ')

    expect(
      strangerText,
      `phone B holds a session that owns nothing and must NOT see order ${f.orderId} ` +
        `("Order #${label}"). Screen read: ${strangerText.slice(0, 400)}`,
    ).not.toMatch(new RegExp(`Order\\s*#\\s*${label}\\b`, 'i'))

    await ctxA.close()
    await ctxB.close()
  })
})
