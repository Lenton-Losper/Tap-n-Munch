/**
 * @jest-environment jsdom
 *
 * #106 — an unrelated menu item edit must not silently clear menu_items.track_inventory.
 *
 * ad18db3 fixed the direction the issue's title names: saveRecipeAction now sets
 * track_inventory=true in the same branch that inserts the ingredients (lib/recipes/actions.ts).
 * The DESYNC the issue is actually about survives it, in the other direction, through the menu
 * item form:
 *
 *   menu-item-form-modal.tsx:211-255  the inventory effect sets canEditInventory FIRST, then
 *                                     loads the item's inventory state. If that load errors it
 *                                     returns early (:223-226) leaving trackInventory at its
 *                                     initial false.
 *   menu-item-form-modal.tsx:377      buildMenuPayload keys the field off canEditInventory
 *                                     alone, so it sends track_inventory: false.
 *   menu-item-db-payload.ts:45-47     writes it, because `false !== undefined`.
 *
 * Nothing consults inventoryLoadError before saving. So a merchant with RECIPE_EDIT who edits a
 * tracked item's price while that one load happens to fail turns tracking OFF for an item whose
 * recipe and ingredients are untouched. Three surfaces then disagree with the recipe rows:
 *
 *   getInventorySetupOverview   queries.ts:67 filters .eq('track_inventory', true) BEFORE
 *                               checking recipe completeness, so the item falls out of the
 *                               configured AND the missing bucket — it is invisible, which
 *                               reads exactly like "never set up".
 *   deduct_recipe_stock         20260801010000_recipes_soft_delete.sql:84 requires
 *                               `m.track_inventory IS TRUE` — stock silently stops moving.
 *   checkStockSufficiency       check-stock-sufficiency.ts:130 filters the same way — the item
 *                               stops being refused when its ingredients run out.
 *
 * The fix is not to send the field when its current value was never established. Omitting is a
 * real no-op: buildMenuItemDbPayload only writes the column when the key is present.
 *
 * Both directions are asserted. A fix that simply stopped sending track_inventory would satisfy
 * the first test and break the merchant's ability to turn tracking off, which the second and
 * third tests catch.
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MenuItemFormModal } from '@/components/menu/menu-item-form-modal'

const RESTAURANT_ID = 'a1999166-ddfa-40d1-ad1f-2f01282a1652'
const MENU_ITEM_ID = '7159368e-3e46-4546-9cd0-8874ecbb7ed2'

/** Payloads handed to the menu item write path, in order. */
let updatePayloads: Record<string, unknown>[] = []
/** What loadMenuItemInventoryAction answers this test. */
let inventoryLoadResult: Record<string, unknown> = {}

jest.mock('next/image', () => ({ __esModule: true, default: () => null }))

jest.mock('@/hooks/use-toast', () => ({
  useToast: () => ({ toast: jest.fn() }),
}))

jest.mock('@/lib/tax-rates/actions', () => ({
  getTaxRatesForMenuFormAction: async () => ({ data: [] }),
}))

jest.mock('@/lib/supabase/storage', () => ({
  uploadMenuItemImage: async () => '',
}))

jest.mock('@/lib/supabase/menu', () => ({
  updateMenuItem: async (
    _restaurantId: string,
    _categoryId: string,
    _subCategoryId: string,
    _itemId: string,
    payload: Record<string, unknown>,
  ) => {
    updatePayloads.push(payload)
    return true
  },
  createMenuItem: async (payload: Record<string, unknown>) => {
    updatePayloads.push(payload)
    return MENU_ITEM_ID
  },
}))

jest.mock('@/lib/recipes/actions', () => ({
  canEditMenuInventoryAction: async () => ({ canEdit: true }),
  loadMenuItemInventoryAction: async () => inventoryLoadResult,
  loadInventoryPickerAction: async () => ({
    data: { stockItems: [], measurementUnits: [] },
  }),
  saveRecipeAction: async () => ({ data: { recipeId: 'r1', ingredientCount: 1 } }),
}))

// Mocked WHOLE, not requireActual'd: the real module reaches
// lib/measurement-units/actions.ts, a 'use server' module whose next/cache import needs
// TextEncoder and fails to load under jsdom. The two helpers are pure row-shape builders and
// are reproduced here; neither is what these tests are about.
jest.mock('@/components/menu/menu-item-inventory-tab', () => {
  let seq = 0
  const emptyIngredientRow = () => ({ key: `row-${seq++}`, stockItemId: '', quantity: '', unitId: '' })
  return {
    MenuItemInventoryTab: () => null,
    emptyIngredientRow,
    toIngredientRowsFromLoaded: (
      ingredients: Array<{ stockItemId: string; quantity: number; unitId: string }>,
    ) =>
      ingredients.length === 0
        ? [emptyIngredientRow()]
        : ingredients.map((row) => ({
            key: `row-${seq++}`,
            stockItemId: row.stockItemId,
            quantity: String(row.quantity),
            unitId: row.unitId,
          })),
  }
})

const EDITING_ITEM = {
  id: MENU_ITEM_ID,
  name: 'Red Bull',
  description: '',
  base_price: 25,
  // itemToForm reads menu_category_id, not category_id.
  menu_category_id: 'cat-1',
  sub_category_id: '',
  image_url: '',
  status: 'available',
  is_popular: false,
  has_sizes: false,
  has_addons: false,
  allow_special_instructions: false,
} as never

let container: HTMLDivElement
let root: Root

async function renderModal() {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root.render(
      <MenuItemFormModal
        open
        onOpenChange={() => {}}
        editingItem={EDITING_ITEM}
        restaurantId={RESTAURANT_ID}
        categoryId="cat-1"
        categoryOptions={[{ id: 'cat-1', name: 'Drinks' }]}
        subCategoryOptions={[]}
        existingItems={[]}
        onSaved={() => {}}
      />,
    )
  })
}

/** Radix renders the dialog into a portal, so search the whole document. */
function findButton(label: string): HTMLButtonElement {
  const match = Array.from(document.querySelectorAll('button')).find(
    (b) => (b.textContent ?? '').trim() === label,
  )
  if (!match) {
    throw new Error(
      `button "${label}" not found. Buttons present: ${Array.from(document.querySelectorAll('button'))
        .map((b) => JSON.stringify((b.textContent ?? '').trim()))
        .join(', ')}`,
    )
  }
  return match as HTMLButtonElement
}

async function clickSave() {
  const save = findButton('Update')
  await act(async () => {
    save.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

/** The Track Inventory switch, on the General tab, so no tab change is needed. */
function trackingSwitch(): HTMLElement {
  const el = document.querySelector('#track-inventory-general')
  if (!el) throw new Error('tracking switch #track-inventory-general not found')
  return el as HTMLElement
}

beforeEach(() => {
  ;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
  updatePayloads = []
  inventoryLoadResult = {}
})

afterEach(async () => {
  await act(async () => {
    root.unmount()
  })
  container.remove()
})

describe('menu item edit vs menu_items.track_inventory', () => {
  it('does not send track_inventory when the inventory state could not be loaded', async () => {
    // The one load this depends on fails. Everything else about the edit is ordinary.
    inventoryLoadResult = { error: 'Failed to load inventory.' }

    await renderModal()
    await clickSave()

    expect(updatePayloads).toHaveLength(1)
    // Not `toBe(false)` — the field must be ABSENT. buildMenuItemDbPayload writes the column
    // whenever the key is present, so sending false is what clears a tracked item.
    expect(updatePayloads[0]).not.toHaveProperty('track_inventory')
  })

  it('still sends the loaded value when the inventory state IS known', async () => {
    inventoryLoadResult = {
      data: { trackInventory: true, hasInventory: true, ingredients: [], stockItems: [], measurementUnits: [] },
    }

    await renderModal()
    await clickSave()

    expect(updatePayloads[0].track_inventory).toBe(true)
  })

  it('still lets a merchant turn tracking off', async () => {
    // The control that stops the fix becoming "never write the column". A merchant switching
    // tracking off must still be obeyed.
    inventoryLoadResult = {
      data: { trackInventory: true, hasInventory: true, ingredients: [], stockItems: [], measurementUnits: [] },
    }

    await renderModal()
    await act(async () => {
      trackingSwitch().dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await clickSave()

    expect(updatePayloads[0].track_inventory).toBe(false)
  })
})
