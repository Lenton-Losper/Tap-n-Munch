/**
 * @jest-environment jsdom
 *
 * #159 — the recipe quantity warning must actually reach the screen.
 *
 * The detector itself is covered by __tests__/recipe-quantity-sanity.test.ts. This suite exists
 * because a correct detector wired up wrongly is indistinguishable from no detector at all: the
 * unit tests stay green, tsc stays green, and the merchant sees nothing. So everything below is
 * asserted against the MOUNTED tab, reading the rendered DOM.
 *
 * The two select fields are stubbed. They pull in the stock-item and measurement-unit pickers,
 * neither of which has anything to do with what is being asserted, and the stub keeps the
 * quantity input and its warning as the only things under test.
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

jest.mock('@/components/stock/searchable-stock-item-select-field', () => ({
  SearchableStockItemSelectField: () => null,
}))
jest.mock('@/components/stock/measurement-unit-select-field', () => ({
  MeasurementUnitSelectField: () => null,
}))
jest.mock('@/components/stock/stock-item-select-field', () => ({
  StockItemSelectField: () => null,
}))
jest.mock('next/navigation', () => ({ useRouter: () => ({ refresh: jest.fn() }) }))
jest.mock('@/lib/recipes/actions', () => ({
  saveRecipeAction: jest.fn(),
  removeRecipeLinkAction: jest.fn(),
}))

import { MenuItemInventoryTab } from '@/components/menu/menu-item-inventory-tab'
import { RecipeEditorForm } from '@/components/recipes/recipe-editor-form'

let container: HTMLDivElement
let root: Root

// jsdom ships no crypto.randomUUID, and both editors mint React keys with it. Counter-based so
// the ids are stable across a run and a failure diff reads the same twice.
let uuidCounter = 0
if (!globalThis.crypto) (globalThis as any).crypto = {}
if (!globalThis.crypto.randomUUID) {
  ;(globalThis.crypto as any).randomUUID = () =>
    `00000000-0000-4000-8000-${String(++uuidCounter).padStart(12, '0')}`
}

beforeEach(() => {
  ;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

const UNITS = [{ id: 'u1', name: 'each', symbol: 'ea' }] as never

function renderTab(options: {
  menuItemName: string
  quantity: string
  stockItemName: string
  currentStock: number
  trackInventory?: boolean
}) {
  const stockItems = [
    {
      id: 'stock-1',
      name: options.stockItemName,
      unit_id: 'u1',
      unit_label: 'each',
      currentStock: options.currentStock,
    },
  ]
  act(() => {
    root.render(
      <MenuItemInventoryTab
        trackInventory={options.trackInventory ?? true}
        menuItemName={options.menuItemName}
        rows={[{ key: 'r1', stockItemId: 'stock-1', quantity: options.quantity, unitId: 'u1' }]}
        onRowsChange={() => {}}
        stockItems={stockItems}
        onStockItemsChange={() => {}}
        measurementUnits={UNITS}
      />,
    )
  })
}

/** The warning element the quantity input points at, or null when none is shown. */
function warningText(): string | null {
  const input = container.querySelector('input[type="number"]')
  const describedBy = input?.getAttribute('aria-describedby')
  if (!describedBy) return null
  return container.querySelector(`#${describedBy}`)?.textContent ?? null
}

describe('the quantity warning reaches the screen', () => {
  it('shows a warning for Sausage roll 20 against 20 on hand', () => {
    // The real Mingle row: received 20 on 08-06, recipe quantity typed as 20.
    renderTab({
      menuItemName: 'Sausage roll',
      quantity: '20',
      stockItemName: 'Sausage roll',
      currentStock: 20,
    })
    const text = warningText()
    expect(text).not.toBeNull()
    // 'the whole lot' is the distinguishing clause of the signed equals_on_hand string;
    // __tests__/recipe-quantity-copy-signed-off.test.ts owns the exact wording.
    expect(text).toContain('the whole lot')
  })

  it('shows a warning when the quantity is more than the amount on hand', () => {
    // Wedge biscuits as it stands today: quantity 30, balance 12.
    renderTab({
      menuItemName: 'Wedge biscuits',
      quantity: '30',
      stockItemName: 'Wedge biscuits',
      currentStock: 12,
    })
    // 'below zero' is pinned by the signed-copy lock test; this asserts WHICH warning reached
    // the screen, and that file owns the wording.
    expect(warningText()).toContain('below zero')
  })

  it('shows NOTHING for a correct one-per-sale recipe', () => {
    renderTab({ menuItemName: 'Coke', quantity: '1', stockItemName: 'Coke', currentStock: 100 })
    expect(warningText()).toBeNull()
    expect(container.textContent).not.toContain('PLACEHOLDER')
  })

  it('shows NOTHING for FNB ChowNow Chicken Wings at 5 per portion', () => {
    renderTab({
      menuItemName: 'Chicken Wings',
      quantity: '5',
      stockItemName: 'Chicken Wings',
      currentStock: 35,
    })
    expect(warningText()).toBeNull()
  })

  it('renders no ingredient fields at all when the item is not tracked', () => {
    // Nothing in this tab may appear for an untracked item, warning included.
    renderTab({
      menuItemName: 'Sausage roll',
      quantity: '20',
      stockItemName: 'Sausage roll',
      currentStock: 20,
      trackInventory: false,
    })
    expect(container.querySelector('input[type="number"]')).toBeNull()
    expect(warningText()).toBeNull()
  })

  it('shows NOTHING for an ingredient whose stock item has not loaded', () => {
    // The row points at a stock item that is not in the loaded list, so its balance is UNKNOWN.
    // Reading that as a balance of zero would fire "more than you have" on every such row, and
    // the picker loads asynchronously — this is the state the tab is in while it opens.
    act(() => {
      root.render(
        <MenuItemInventoryTab
          trackInventory
          menuItemName="Sausage roll"
          rows={[{ key: 'r1', stockItemId: 'not-loaded-yet', quantity: '20', unitId: 'u1' }]}
          onRowsChange={() => {}}
          stockItems={[]}
          onStockItemsChange={() => {}}
          measurementUnits={UNITS}
        />,
      )
    })
    expect(warningText()).toBeNull()
  })

  it('labels the quantity field as a per-sale amount, not a bare "Quantity"', () => {
    renderTab({ menuItemName: 'Coke', quantity: '1', stockItemName: 'Coke', currentStock: 100 })
    const label = container.querySelector('label[for^="ingredient-qty-"]')
    expect(label?.textContent).toContain('per single sale')
  })
})

/**
 * The standalone recipe editor is the OTHER surface onto the same field, and it does not load
 * ledger balances. Only the name-based fallback signal can fire there, which is exactly why it
 * needs its own assertions: the modal tab's tests cannot reach that branch at all.
 */
describe('the standalone recipe editor warns too', () => {
  function renderEditor(menuItemName: string, quantity: number, stockItemName: string) {
    act(() => {
      root.render(
        <RecipeEditorForm
          canEdit
          data={{
            menuItemId: 'm1',
            menuItemName,
            recipeId: 'rec1',
            ingredients: [
              {
                stockItemId: 'stock-1',
                stockItemName,
                stockItemUnitId: 'u1',
                quantity,
                unitId: 'u1',
                unitLabel: 'each',
              },
            ],
          }}
          stockItems={[
            { id: 'stock-1', name: stockItemName, unit_id: 'u1', unit_label: 'each' },
          ]}
          measurementUnits={UNITS}
        />,
      )
    })
    const input = container.querySelector('input[type="number"]')
    const describedBy = input?.getAttribute('aria-describedby')
    if (!describedBy) return null
    return container.querySelector(`#${describedBy}`)?.textContent ?? null
  }

  it('warns when the only ingredient is the item itself at a quantity other than 1', () => {
    // Mingle's "Sausage roll" recipe, which consumes 20 Sausage rolls per Sausage roll sold.
    expect(renderEditor('Sausage roll', 20, 'Sausage roll')).toContain('the same item being sold')
  })

  it('stays silent once that recipe is corrected to 1', () => {
    expect(renderEditor('Sausage roll', 1, 'Sausage roll')).toBeNull()
  })

  it('stays silent for an ingredient that is a different thing from the menu item', () => {
    // "Bacon, cheese, tomato Croissant" consumes a Croissant. Different names, so nothing here
    // establishes that one sale must consume exactly one.
    expect(renderEditor('Bacon, cheese, tomato Croissant', 2, 'Croissant')).toBeNull()
  })

  it('labels its quantity field as a per-sale amount too', () => {
    renderEditor('Coke', 1, 'Coke')
    const label = container.querySelector('label[for^="quantity-"]')
    expect(label?.textContent).toContain('per single sale')
  })
})
