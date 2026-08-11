/**
 * #106 — buildMenuItemDbPayload must not write track_inventory unless it was asked to.
 *
 * This pins the LINCHPIN the #106 form fix rests on. 3b0656c stopped
 * components/menu/menu-item-form-modal.tsx:394 from sending the field when the item's
 * tracking state was never established, and that fix is a no-op ONLY because
 * lib/menu-item-db-payload.ts:45 writes the column exclusively when the key is present.
 * Collapse that guard to an unconditional `payload.track_inventory = Boolean(...)` -- the
 * shape every neighbouring line already has, so it reads like a tidy-up -- and 3b0656c
 * silently reverts: an absent key becomes `false`, and a tracked item is cleared by an edit
 * that never mentioned tracking.
 *
 * Nothing pinned it directly. __tests__/menu-item-edit-preserves-tracking.test.tsx asserts the
 * same guarantee, but through a mounted Radix modal under jsdom, so it fails for a dozen
 * reasons that have nothing to do with this rule and it does not cover the OTHER caller at all.
 *
 * That other caller is the reason this is worth its own suite. app/api/admin/menu/items/route.ts
 * builds the payload from `{ ...body }` -- the RAW REQUEST BODY -- at :191 (POST) and :287
 * (PATCH). So this one guard is also what stops an admin PATCH that never mentioned tracking
 * from clearing it, and no test exercised that surface. The consequences of clearing it are
 * not cosmetic (see lib/recipes/queries.ts:67 and :148,
 * lib/orders/check-stock-sufficiency.ts:130, and `m.track_inventory IS TRUE` in
 * supabase/migrations/20260801010000_recipes_soft_delete.sql:85): the item goes invisible in
 * the setup UI and stock silently stops being deducted for it on every sale.
 *
 * menu_items.track_inventory is `boolean NOT NULL DEFAULT false`
 * (20260704120000_menu_items_track_inventory.sql:3), so there is no NULL third state to model:
 * the column is written or it is not, and "not written" is the only way to leave a value alone.
 */
import { buildMenuItemDbPayload } from '@/lib/menu-item-db-payload'

describe('buildMenuItemDbPayload — track_inventory', () => {
  it('omits the column entirely when the key is absent', () => {
    const payload = buildMenuItemDbPayload({ name: 'Red Bull', base_price: 25 })

    // Not `toBe(false)` -- absence is the whole point. A `false` here is a WRITE that clears
    // tracking on an item whose recipe and ingredients were never touched.
    expect(payload).not.toHaveProperty('track_inventory')
  })

  it('writes false when false was actually asked for', () => {
    // The merchant turning the switch off must still be obeyed. A fix that just stopped
    // sending the column would pass the test above and break this one.
    const payload = buildMenuItemDbPayload({ name: 'Red Bull', track_inventory: false })

    expect(payload).toHaveProperty('track_inventory', false)
  })

  it('writes true when true was asked for', () => {
    const payload = buildMenuItemDbPayload({ name: 'Red Bull', track_inventory: true })

    expect(payload).toHaveProperty('track_inventory', true)
  })

  it('does not invent the column from an unrelated admin PATCH body', () => {
    // app/api/admin/menu/items/route.ts:287 spreads the raw request body. A price edit from
    // any client is exactly this shape, and it must leave tracking alone.
    const payload = buildMenuItemDbPayload({
      ...{ name: 'Red Bull', base_price: 30, status: 'available', is_popular: true },
      category_id: 'cat-1',
      subcategory_id: null,
    })

    expect(payload).not.toHaveProperty('track_inventory')
    // The edit itself still goes through -- this is not "the payload came out empty".
    expect(payload).toMatchObject({ name: 'Red Bull', base_price: 30, status: 'available' })
  })

  it('treats an explicit undefined the same as absent', () => {
    // `{ ...body }` on a body that carries the key as undefined, which is what a client
    // serialising an optional field can produce.
    const payload = buildMenuItemDbPayload({ name: 'Red Bull', track_inventory: undefined })

    expect(payload).not.toHaveProperty('track_inventory')
  })
})
