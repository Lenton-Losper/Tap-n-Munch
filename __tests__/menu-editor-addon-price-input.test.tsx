/**
 * @jest-environment jsdom
 *
 * The add-on price box had the variant price box's bug (menu-editor-variant-price-input.test.tsx).
 *
 * handleUpdateAddon stored `Number(value) || 0`, so emptying the box wrote 0 and the controlled
 * input re-rendered "0"; a new add-on also started at 0 when the base price was blank. Add-ons are
 * written to the item as they stand (no sanitiser), so once the box can be empty, Save has to
 * decide what an empty price means -- these pin that it refuses rather than writing a null price.
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MenuItemFormModal } from '@/components/menu/menu-item-form-modal'

const RESTAURANT_ID = 'a1999166-ddfa-40d1-ad1f-2f01282a1652'
const MENU_ITEM_ID = 'e184dfe6-a077-4976-b9f3-286fd48d568b'

let updatePayloads: Record<string, unknown>[] = []
const toastMock = jest.fn()

jest.mock('next/image', () => ({ __esModule: true, default: () => null }))

jest.mock('@/hooks/use-toast', () => ({
  useToast: () => ({ toast: toastMock }),
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

function editingItem(
  addons: Array<{ name: string; price: number }>,
  { basePrice = 45, hasAddons = true }: { basePrice?: number; hasAddons?: boolean } = {},
) {
  return {
    id: MENU_ITEM_ID,
    name: 'Cappucinno',
    description: '',
    base_price: basePrice,
    tax_rate_id: 'rate-standard-15',
    menu_category_id: 'cat-1',
    sub_category_id: '',
    image_url: '',
    status: 'available',
    is_popular: false,
    has_sizes: false,
    has_addons: hasAddons,
    addons,
    allow_special_instructions: false,
    variantGroups: [],
  } as never
}

let container: HTMLDivElement
let root: Root

async function renderModal(item: unknown) {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root.render(
      <MenuItemFormModal
        open
        onOpenChange={() => {}}
        editingItem={item as never}
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

async function openOptionsTab() {
  const trigger = findByText('button', 'Options')
  await act(async () => {
    trigger.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, ctrlKey: false }))
    trigger.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  if (trigger.getAttribute('data-state') !== 'active') {
    throw new Error('Options tab did not open; the rest of this suite would assert on nothing.')
  }
}

/** The add-on rows' price boxes, found through each row's name box. */
function addonPriceInputs(): HTMLInputElement[] {
  return Array.from(document.querySelectorAll('input[placeholder="Add-on name"]')).map((name) => {
    const price = name.parentElement?.querySelector('input[type="number"]')
    if (!price) throw new Error('add-on row has no price input')
    return price as HTMLInputElement
  })
}

/** What a keystroke does: the browser sets the value, then fires 'input', which React maps to onChange. */
async function typeInto(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  await act(async () => {
    setter.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

async function save() {
  await click(findByText('button', 'Update'))
}

function writtenAddons(): unknown {
  expect(updatePayloads).toHaveLength(1)
  return updatePayloads[0].addons
}

beforeEach(() => {
  ;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
  updatePayloads = []
  toastMock.mockClear()
})

afterEach(async () => {
  await act(async () => {
    root.unmount()
  })
  container.remove()
})

describe('add-on price box: the existing value can be replaced', () => {
  it('REGRESSION: clearing the box leaves it empty instead of snapping back to 0', async () => {
    await renderModal(editingItem([{ name: 'Extra shot', price: 0 }]))
    await openOptionsTab()
    const [price] = addonPriceInputs()
    expect(price.value).toBe('0')

    await typeInto(price, '')
    // Old behaviour: '0' -- `Number('') || 0` put the zero straight back.
    expect(price.value).toBe('')

    await typeInto(price, '5')
    expect(price.value).toBe('5')

    await save()
    expect(writtenAddons()).toEqual([{ name: 'Extra shot', price: 5 }])
  })

  it('selects the whole value on focus, so the first keystroke replaces it', async () => {
    await renderModal(editingItem([{ name: 'Extra shot', price: 5 }]))
    await openOptionsTab()
    const [price] = addonPriceInputs()

    const select = jest.spyOn(HTMLInputElement.prototype, 'select')
    try {
      await act(async () => {
        price.focus()
      })
      expect(select.mock.instances).toContain(price)
    } finally {
      select.mockRestore()
    }
  })

  it('replaces 5 with 8', async () => {
    await renderModal(editingItem([{ name: 'Extra shot', price: 5 }]))
    await openOptionsTab()
    const [price] = addonPriceInputs()

    await typeInto(price, '8')
    expect(price.value).toBe('8')
    await save()
    expect(writtenAddons()).toEqual([{ name: 'Extra shot', price: 8 }])
  })

  it('keeps decimal prices: 12.50 saves as 12.5', async () => {
    await renderModal(editingItem([{ name: 'Extra shot', price: 5 }]))
    await openOptionsTab()
    const [price] = addonPriceInputs()

    await typeInto(price, '')
    await typeInto(price, '12.50')
    expect(price.value).toBe('12.50')
    await save()
    expect(writtenAddons()).toEqual([{ name: 'Extra shot', price: 12.5 }])
  })

  it('a new add-on row starts blank, not 0, when there is no base price', async () => {
    await renderModal(editingItem([{ name: 'Extra shot', price: 5 }], { basePrice: 0 }))
    await openOptionsTab()
    await click(findByText('button', 'Add Add-on'))
    const prices = addonPriceInputs()
    expect(prices).toHaveLength(2)
    expect(prices[1].value).toBe('')
  })

  it('refuses a negative price at the input', async () => {
    await renderModal(editingItem([{ name: 'Extra shot', price: 5 }]))
    await openOptionsTab()
    const [price] = addonPriceInputs()
    expect(price.getAttribute('min')).toBe('0')
  })
})

describe('add-on price box: Save validates the final value', () => {
  it('blocks Save when a named add-on is left with an empty price, instead of writing null', async () => {
    await renderModal(editingItem([{ name: 'Extra shot', price: 5 }]))
    await openOptionsTab()
    const [price] = addonPriceInputs()

    await typeInto(price, '')
    await save()

    expect(updatePayloads).toHaveLength(0)
    expect(toastMock).toHaveBeenCalledWith(
      expect.objectContaining({
        variant: 'destructive',
        description: expect.stringContaining('Extra shot'),
      }),
    )
  })

  it('blocks Save when an add-on price is negative', async () => {
    await renderModal(editingItem([{ name: 'Extra shot', price: 5 }]))
    await openOptionsTab()
    const [price] = addonPriceInputs()

    await typeInto(price, '-5')
    await save()

    expect(updatePayloads).toHaveLength(0)
    expect(toastMock).toHaveBeenCalledWith(expect.objectContaining({ variant: 'destructive' }))
  })

  it('does not write a row that is entirely blank (no name, no price)', async () => {
    // A real base price (Save refuses an item without one); the new row starts at it, so clear it.
    await renderModal(editingItem([{ name: 'Extra shot', price: 5 }]))
    await openOptionsTab()
    await click(findByText('button', 'Add Add-on'))
    const prices = addonPriceInputs()
    expect(prices[1].value).toBe('45')
    await typeInto(prices[1], '')
    await save()
    expect(writtenAddons()).toEqual([{ name: 'Extra shot', price: 5 }])
  })

  it('still saves add-ons whose prices are all valid, including an explicit 0', async () => {
    await renderModal(
      editingItem([
        { name: 'Extra shot', price: 10 },
        { name: 'Oat milk', price: 7.5 },
        { name: 'Cinnamon', price: 0 },
      ]),
    )
    await save()
    expect(writtenAddons()).toEqual([
      { name: 'Extra shot', price: 10 },
      { name: 'Oat milk', price: 7.5 },
      { name: 'Cinnamon', price: 0 },
    ])
  })

  it('an item with add-ons switched off still writes none', async () => {
    await renderModal(editingItem([], { hasAddons: false }))
    await save()
    expect(writtenAddons()).toEqual([])
  })
})
