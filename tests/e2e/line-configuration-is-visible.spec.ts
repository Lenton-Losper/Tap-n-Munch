/**
 * #298 -- two lines of the same item in different configurations must be distinguishable.
 *
 * Reproduces #297 exactly: one Beef Burger with `Extra patty` (+35) and one with `Cheese` (+12),
 * on one submission. Before the fix the screen showed the item NAME twice at two prices, which
 * reads as the same burger charged two different amounts.
 */
import { test, expect } from '@playwright/test'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  assertServedAppUsesStaging,
  assertStagingDb,
  adoptSession,
  seedTableWithOrder,
  teardown,
  inclusiveSplit,
  FIXTURE_RESTAURANT,
  type Fixture,
} from './lib/fixture'

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

test('two configurations of one item are told apart on the confirmation screen', async ({
  page,
  baseURL,
}) => {
  const f = await seedTableWithOrder(db, { price: 95 })
  fixture = f

  const withPatty = inclusiveSplit(130)
  const withCheese = inclusiveSplit(107)
  const line = (name: string, money: ReturnType<typeof inclusiveSplit>, addon: string, price: number) => ({
    name,
    displayName: name,
    quantity: 1,
    unitPrice: money.total,
    basePrice: 95,
    subtotal: money.subtotal,
    tax: money.tax,
    total: money.total,
    taxRatePercentage: 15,
    taxInclusive: true,
    selectedVariants: {},
    size: null,
    addons: [{ name: addon, price }],
    specialInstructions: '',
  })

  await db
    .from('orders')
    .update({
      items: [
        line(f.itemName, withPatty, 'Extra patty', 35),
        line(f.itemName, withCheese, 'Cheese', 12),
      ],
      subtotal: withPatty.subtotal + withCheese.subtotal,
      tax: withPatty.tax + withCheese.tax,
      total: 237,
    })
    .eq('id', f.orderId)

  await adoptSession(page.context(), baseURL!, f)
  await page.goto(
    `${baseURL}/menu/${FIXTURE_RESTAURANT}/order-confirmation/${f.orderId}?table=${f.tableNumber}`,
    { waitUntil: 'domcontentloaded' },
  )
  await page.waitForFunction(() => document.body.innerText.trim().length > 20, null, {
    timeout: 25_000,
  })
  await expect(page.getByText(f.itemName, { exact: false }).first()).toBeVisible({ timeout: 20_000 })

  const text = (await page.innerText('body')).replace(/\s+/g, ' ').trim()
  expect(text, `both prices must be on screen. Saw: ${text}`).toContain('130.00')
  expect(text).toContain('107.00')
  // The whole point: the thing that makes them different has to be visible.
  expect(text, `the add-on distinguishing the two lines is not rendered. Saw: ${text}`).toContain(
    'Extra patty',
  )
  expect(text).toContain('Cheese')
})
