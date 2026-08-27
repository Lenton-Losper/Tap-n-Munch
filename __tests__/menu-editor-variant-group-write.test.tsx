/**
 * @jest-environment jsdom
 *
 * #229 through the ACTUAL editor -- the writer the ruling names.
 *
 * __tests__/variant-group-write-shape.test.ts pins the shared rules. This suite pins that the
 * menu item form is running them, because the two defects it fixes are both invisible from the
 * unit level:
 *
 *   1. The form rendered a stored option's label from `label` alone. Every production option
 *      spells it `name`, so a staff member opening one of the five FNB ChowNow coffees saw a
 *      group called "Size" with three EMPTY text boxes under it -- the one screen they would use
 *      to repair the row was also the screen hiding what was in it.
 *
 *   2. The form's private sanitiser DISCARDED any group it could not clean, and a production
 *      group cleans to nothing. On an item carrying a legacy group beside a good one, saving an
 *      unrelated field wrote back only the good one. No error, no toast, nothing on screen: the
 *      staff member's other variant group was gone.
 *
 * The fixture is the production `variant_groups` value verbatim, plus a second, well-formed
 * group so the silent-deletion case is reachable at all.
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MenuItemFormModal } from '@/components/menu/menu-item-form-modal'

const RESTAURANT_ID = 'a1999166-ddfa-40d1-ad1f-2f01282a1652'
const MENU_ITEM_ID = 'e184dfe6-a077-4976-b9f3-286fd48d568b'

let updatePayloads: Record<string, unknown>[] = []

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
  canEditMenuInventoryAction: async () => ({ canEdit: false }),
  loadMenuItemInventoryAction: async () => ({}),
  loadInventoryPickerAction: async () => ({ data: { stockItems: [], measurementUnits: [] } }),
  saveRecipeAction: async () => ({ data: { recipeId: 'r1', ingredientCount: 0 } }),
}))

// See the note in __tests__/menu-item-edit-preserves-tracking.test.tsx: the real module reaches
// a 'use server' module that will not load under jsdom, and neither helper is the subject here.
jest.mock('@/components/menu/menu-item-inventory-tab', () => {
  let seq = 0
  const emptyIngredientRow = () => ({ key: `row-${seq++}`, stockItemId: '', quantity: '', unitId: '' })
  return {
    MenuItemInventoryTab: () => null,
    emptyIngredientRow,
    toIngredientRowsFromLoaded: () => [emptyIngredientRow()],
  }
})

/** Verbatim from production menu_items row e184dfe6-…, "Cappucinno" (FNB ChowNow). */
const PROD_REQUIRED_GROUP = {
  id: 'size',
  name: 'Size',
  options: [
    { id: '250ml', name: '250ml', price_modifier: 0 },
    { id: '350ml', name: '350ml', price_modifier: 10 },
    { id: '500ml', name: '500ml', price_modifier: 15 },
  ],
  required: true,
}

const GOOD_GROUP = {
  name: 'Milk',
  required: false,
  type: 'text',
  options: ['Oat', 'Soy'],
}

const EDITING_ITEM = {
  id: MENU_ITEM_ID,
  name: 'Cappucinno',
  description: '',
  base_price: 45,
  tax_rate_id: 'rate-standard-15',
  menu_category_id: 'cat-1',
  sub_category_id: '',
  image_url: '',
  status: 'available',
  is_popular: false,
  has_sizes: false,
  has_addons: false,
  allow_special_instructions: false,
  // itemToForm reads the camelCase spelling, which is what normalizeMenuItemForClient produces
  // from the snake_case column (lib/supabase/menu.ts:24).
  variantGroups: [PROD_REQUIRED_GROUP, GOOD_GROUP],
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

/** Radix portals the dialog, so search the whole document. */
function findByText(selector: string, label: string): HTMLElement {
  const match = Array.from(document.querySelectorAll(selector)).find(
    (el) => (el.textContent ?? '').trim() === label,
  )
  if (!match) throw new Error(`${selector} "${label}" not found`)
  return match as HTMLElement
}

async function click(el: Element) {
  await act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

/**
 * The variant group editor lives on the Pricing tab, which Radix does not mount until opened.
 * Radix's TabsTrigger activates on mousedown, not click, so a plain click event changes nothing
 * and the assertions below would read an unmounted tab as a missing element.
 */
async function openPricingTab() {
  const trigger = findByText('button', 'Pricing')
  await act(async () => {
    trigger.dispatchEvent(
      new MouseEvent('mousedown', { bubbles: true, button: 0, ctrlKey: false }),
    )
    trigger.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  if (trigger.getAttribute('data-state') !== 'active') {
    throw new Error(
      `Pricing tab did not open (data-state=${trigger.getAttribute('data-state')}); ` +
        'the rest of this suite would silently assert on an unmounted tab.',
    )
  }
}

function optionInputValues(): string[] {
  return Array.from(document.querySelectorAll('input'))
    .filter((input) => {
      const placeholder = input.getAttribute('placeholder')
      return placeholder === 'Option value' || placeholder === 'Option label'
    })
    .map((input) => (input as HTMLInputElement).value)
}

beforeEach(() => {
  ;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
  updatePayloads = []
})

afterEach(async () => {
  await act(async () => {
    root.unmount()
  })
  container.remove()
})

describe('#229 the menu item editor stops hiding, and stops deleting, a stored variant group', () => {
  it('shows the stored option labels, which production spells `name` and not `label`', async () => {
    await renderModal()
    await openPricingTab()

    // Before the fix these three came out '' and the staff member saw empty boxes.
    expect(optionInputValues()).toEqual(
      expect.arrayContaining(['250ml', '350ml', '500ml', 'Oat', 'Soy']),
    )
  })

  it('says out loud that the group is not reaching customers', async () => {
    await renderModal()
    await openPricingTab()

    const notice = document.querySelector('[data-testid="variant-group-unconvertible"]')
    expect(notice).not.toBeNull()
    // PLACEHOLDER COPY, pending owner sign-off — only the group name is asserted, so the
    // wording can be replaced without touching this test.
    expect(notice?.textContent).toContain('Size')
  })

  it('REGRESSION: saving preserves BOTH groups instead of writing back only the clean one', async () => {
    await renderModal()
    await click(findByText('button', 'Update'))

    expect(updatePayloads).toHaveLength(1)
    const written = updatePayloads[0].variantGroups as unknown[]

    // Old behaviour: [GOOD_GROUP] only — the production group silently destroyed.
    expect(written).toHaveLength(2)
    expect(written[0]).toEqual(PROD_REQUIRED_GROUP)
    expect(written[1]).toEqual(GOOD_GROUP)
  })

  it('MONEY GUARD: the saved group keeps its price_modifier and gains no `price`', async () => {
    await renderModal()
    await click(findByText('button', 'Update'))

    const written = updatePayloads[0].variantGroups as Array<{
      options: Array<Record<string, unknown>>
    }>
    for (const option of written[0].options) {
      expect(option).not.toHaveProperty('price')
    }
    expect(written[0].options.map((o) => o.price_modifier)).toEqual([0, 10, 15])
  })
})
