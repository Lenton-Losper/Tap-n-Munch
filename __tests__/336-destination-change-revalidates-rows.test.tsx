/**
 * @jest-environment jsdom
 *
 * #336 — A TRANSFER LINE THAT WAS POSSIBLE WHEN IT WAS PICKED CAN STOP BEING POSSIBLE.
 *
 * A transfer line only survives dispatch if its canonical item has an ACTIVE `stock_items`
 * mapping at BOTH ends. `OrganizationStockItemSelectField` enforces that AT PICK TIME and refuses
 * to select an item missing at either end. Nothing enforced it afterwards:
 *
 *   - the destination `Select` is free to move after rows are filled in,
 *   - `handleSubmit` filters rows on "has an id and a positive quantity", nothing else,
 *   - `create_transfer` (the SQL function, read off production 2026-08-27) validates only that
 *     the two restaurants share an organisation -- it never looks at the ITEMS,
 *   - so the first thing that notices is `dispatch_transfer`, which raises
 *     `organization_stock_item % has no active stock_items mapping at destination restaurant %`.
 *
 * The user therefore builds a draft, dispatches it, and only then learns the line was impossible
 * — which is precisely the "surface the constraint before dispatch" that #336 asks for.
 *
 * THIS MOUNTS THE REAL FORM rather than asserting over `isTransferableBetween` directly. The
 * predicate being right is not the thing that broke; the thing that broke is that NOTHING ASKED
 * IT a second time. A predicate-only test passes with the destination handler wired straight back
 * to `setToRestaurantId`, which is the exact regression this exists to catch — and is the exact
 * mutation it was checked against.
 *
 * The `ui/select` stub is a native `<select>`. It replaces a Radix presentational primitive that
 * needs pointer-capture APIs jsdom does not implement; it carries none of the logic under test,
 * which stays in the real `CreateTransferForm`.
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: jest.fn(), refresh: jest.fn() }),
}))

jest.mock('@/lib/stock/transfer-actions', () => ({
  createTransferAction: jest.fn(async () => ({ data: { transferId: 'transfer-1' } })),
  configureCanonicalItemAction: jest.fn(async () => ({ data: { stockItemId: 'stock-item-1' } })),
}))

jest.mock('@/components/ui/select', () => {
  const React = require('react')
  type ItemProps = { value: string; children: React.ReactNode }
  const collectItems = (node: React.ReactNode): Array<{ value: string; label: string }> => {
    const found: Array<{ value: string; label: string }> = []
    React.Children.forEach(node, (child: React.ReactNode) => {
      // `React` comes from `require`, so `isValidElement` does not narrow here. Read `props`
      // structurally instead of relying on a type guard the untyped import cannot provide.
      const element = child as { props?: Partial<ItemProps> } | null | undefined
      if (!element || typeof element !== 'object') return
      const props = element.props ?? {}
      if (typeof props.value === 'string') {
        found.push({ value: props.value, label: String(props.children) })
        return
      }
      found.push(...collectItems(props.children as React.ReactNode))
    })
    return found
  }
  return {
    Select: ({
      value,
      onValueChange,
      children,
    }: {
      value: string
      onValueChange: (next: string) => void
      children: React.ReactNode
    }) =>
      React.createElement(
        'select',
        {
          'data-testid': 'destination-select',
          value,
          onChange: (event: { target: { value: string } }) => onValueChange(event.target.value),
        },
        collectItems(children).map((item) =>
          React.createElement('option', { key: item.value, value: item.value }, item.label),
        ),
      ),
    SelectContent: ({ children }: { children: React.ReactNode }) => children,
    SelectItem: ({ children }: ItemProps) => children,
    SelectTrigger: ({ children }: { children: React.ReactNode }) => children,
    SelectValue: () => null,
  }
})

import { CreateTransferForm } from '@/components/stock/create-transfer-form'
import type { OrganizationStockItemOption } from '@/lib/stock/transfer-queries'

const SOURCE = 'rest-source'
const DEST_MAPPED = 'rest-dest-mapped'
const DEST_UNMAPPED = 'rest-dest-unmapped'

const destinations = [
  { id: DEST_MAPPED, name: 'Mapped Destination', locationType: 'BRANCH', address: null },
  { id: DEST_UNMAPPED, name: 'Unmapped Destination', locationType: 'BRANCH', address: null },
]

/** Mapped at the source and at ONE of the two destinations -- the shape #336 measured on Gosto. */
const sharedItem: OrganizationStockItemOption = {
  id: 'org-item-shared',
  name: 'Shared Item',
  baseUnitId: 'unit-1',
  baseUnitLabel: 'unit',
  isManufactured: false,
  configuredRestaurantIds: [SOURCE, DEST_MAPPED],
}

/**
 * Mapped at both destinations but NOT at the source -- the mirror-image gap, which raises
 * `... has no active stock_items mapping at source restaurant %` instead.
 *
 * This fixture exists because of a mutation that SURVIVED. With the whole source-end branch of
 * `unconfiguredTransferEnd` replaced by `if (false)`, every other test in this file still passed:
 * they all vary the destination and hold the source configured, so nothing anywhere in the repo
 * noticed that the picker had stopped checking the near end at all. The guard was real; the
 * coverage of it was decoration. The two tests using this fixture are what kill that mutation.
 */
const notAtSourceItem: OrganizationStockItemOption = {
  id: 'org-item-not-at-source',
  name: 'Not At Source Item',
  baseUnitId: 'unit-1',
  baseUnitLabel: 'unit',
  isManufactured: false,
  configuredRestaurantIds: [DEST_MAPPED, DEST_UNMAPPED],
}

let container: HTMLDivElement
let root: Root

/**
 * jsdom ships `crypto` without `randomUUID`, and `emptyRow()` calls it on every mount. Counter,
 * not random, so a failure names a stable row key.
 */
beforeAll(() => {
  if (typeof globalThis.crypto?.randomUUID !== 'function') {
    let n = 0
    Object.defineProperty(globalThis.crypto ?? (globalThis.crypto = {} as Crypto), 'randomUUID', {
      configurable: true,
      value: () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}` as `${string}-${string}-${string}-${string}-${string}`,
    })
  }
})

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  act(() => {
    root = createRoot(container)
  })
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

function mountForm() {
  act(() => {
    root.render(
      <CreateTransferForm
        sourceRestaurantId={SOURCE}
        sourceRestaurantName="Source Venue"
        destinations={destinations}
        orgItems={[sharedItem]}
      />,
    )
  })
}

function itemInput(): HTMLInputElement {
  const inputs = Array.from(container.querySelectorAll('input'))
  const found = inputs.find((input) => input.getAttribute('placeholder') === 'Search items...')
  if (!found) throw new Error('item picker input not found')
  return found as HTMLInputElement
}

function quantityInput(): HTMLInputElement {
  const found = container.querySelector('input[type="number"]')
  if (!found) throw new Error('quantity input not found')
  return found as HTMLInputElement
}

function destinationSelect(): HTMLSelectElement {
  const found = container.querySelector('[data-testid="destination-select"]')
  if (!found) throw new Error('destination select not found')
  return found as HTMLSelectElement
}

/** Opens the picker and returns the option button for `name`, without clicking it. */
function openPickerAndFind(name: string): HTMLButtonElement {
  act(() => {
    itemInput().dispatchEvent(new FocusEvent('focusin', { bubbles: true }))
  })
  const option = Array.from(container.querySelectorAll('button')).find((button) =>
    button.textContent?.includes(name),
  )
  if (!option) throw new Error(`item option "${name}" not offered by the picker`)
  return option as HTMLButtonElement
}

/** Drives the real picker: focus opens the list, then the item's own button is clicked. */
function pickItem(name: string) {
  const option = openPickerAndFind(name)
  act(() => {
    option.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

function pickSharedItem() {
  pickItem(sharedItem.name)
}

function setNativeValue(element: HTMLInputElement | HTMLSelectElement, value: string) {
  const prototype = Object.getPrototypeOf(element)
  const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set
  setter?.call(element, value)
}

function selectDestination(restaurantId: string) {
  act(() => {
    setNativeValue(destinationSelect(), restaurantId)
    destinationSelect().dispatchEvent(new Event('change', { bubbles: true }))
  })
}

describe('#336 create transfer form re-validates rows against the destination', () => {
  it('offers and keeps an item that is mapped at the destination chosen at pick time', () => {
    mountForm()
    expect(destinationSelect().value).toBe(DEST_MAPPED)

    pickSharedItem()

    expect(itemInput().value).toBe(sharedItem.name)
  })

  it('drops a selected item once the destination moves to a location it is not mapped at', () => {
    mountForm()
    pickSharedItem()
    expect(itemInput().value).toBe(sharedItem.name)

    selectDestination(DEST_UNMAPPED)

    // The line would have dispatched into
    // `... has no active stock_items mapping at destination restaurant ...`.
    expect(itemInput().value).toBe('')
  })

  it('keeps a selected item when the destination moves to another location it IS mapped at', () => {
    // Pins that the fix drops only what became impossible. A handler that cleared every row on
    // any destination change would satisfy the test above and destroy work for no reason.
    const bothMapped: OrganizationStockItemOption = {
      ...sharedItem,
      configuredRestaurantIds: [SOURCE, DEST_MAPPED, DEST_UNMAPPED],
    }
    act(() => {
      root.render(
        <CreateTransferForm
          sourceRestaurantId={SOURCE}
          sourceRestaurantName="Source Venue"
          destinations={destinations}
          orgItems={[bothMapped]}
        />,
      )
    })

    pickSharedItem()
    expect(itemInput().value).toBe(bothMapped.name)

    selectDestination(DEST_UNMAPPED)

    expect(itemInput().value).toBe(bothMapped.name)
  })

  it('refuses to select an item that is not stocked at the SOURCE, whatever the destination', () => {
    // Kills the mutation that survived every other test here: the source-end branch of
    // `unconfiguredTransferEnd` replaced by `if (false)`. Without this, the near end could stop
    // being checked entirely and the suite would stay green.
    act(() => {
      root.render(
        <CreateTransferForm
          sourceRestaurantId={SOURCE}
          sourceRestaurantName="Source Venue"
          destinations={destinations}
          orgItems={[notAtSourceItem]}
        />,
      )
    })

    pickItem(notAtSourceItem.name)

    // Nothing selected: `dispatch_transfer` would have raised
    // `... has no active stock_items mapping at source restaurant ...`.
    expect(itemInput().value).toBe('')
  })

  it('names the SOURCE venue, not the destination, when the near end is the missing one', () => {
    // The picker reports the end nearest the user first. Both destinations here DO have the item,
    // so a source-blind picker would report nothing missing at all.
    act(() => {
      root.render(
        <CreateTransferForm
          sourceRestaurantId={SOURCE}
          sourceRestaurantName="Source Venue"
          destinations={destinations}
          orgItems={[notAtSourceItem]}
        />,
      )
    })

    const option = openPickerAndFind(notAtSourceItem.name)

    expect(option.textContent).toContain('Source Venue')
    expect(option.textContent).not.toContain('Mapped Destination')
  })

  it('leaves the quantity alone when it drops the item, so only the impossible half is lost', () => {
    mountForm()
    pickSharedItem()
    act(() => {
      setNativeValue(quantityInput(), '7')
      quantityInput().dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(quantityInput().value).toBe('7')

    selectDestination(DEST_UNMAPPED)

    expect(itemInput().value).toBe('')
    expect(quantityInput().value).toBe('7')
  })

  it('re-offers the dropped item through the picker, with the configure affordance the component already owns', () => {
    // The recovery path. After the drop the item is still listed; the picker marks it as not
    // configured at the new destination and routes the tap to the configure dialog rather than
    // selecting it. This is why the fix introduces no wording of its own.
    mountForm()
    pickSharedItem()
    selectDestination(DEST_UNMAPPED)

    act(() => {
      itemInput().dispatchEvent(new FocusEvent('focusin', { bubbles: true }))
    })
    const option = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes(sharedItem.name),
    )
    expect(option).toBeDefined()
    expect(option?.textContent).toContain('Unmapped Destination')

    act(() => {
      option?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(itemInput().value).toBe('')
  })
})
