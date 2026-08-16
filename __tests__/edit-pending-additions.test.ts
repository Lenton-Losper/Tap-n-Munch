/**
 * @jest-environment jsdom
 *
 * Binds to lib/orders/edit-pending-additions.ts — the state that survives "+ Add something".
 *
 * WHY THIS MODULE IS TESTED AT ALL, when it is "just sessionStorage": the ruling is *"nothing
 * commits until Save"*, and this is the only thing standing between a customer's pick and either
 * (a) being lost when the menu unmounts the editor, or (b) leaking into the CART, which would
 * place a second order for what they meant as a change to the first. Both failure modes are
 * silent.
 *
 * The per-order keying is the other half: two orders being edited must not see each other's
 * picks, and an abandoned pick on one must not appear on another.
 */
import {
  EDIT_PENDING_ADDITIONS_PREFIX,
  EDIT_PICK_PARAM,
  appendPendingAddition,
  clearPendingAdditions,
  readPendingAdditions,
  toPendingAddition,
  writePendingAdditions,
} from '@/lib/orders/edit-pending-additions'

beforeEach(() => {
  window.sessionStorage.clear()
})

describe('pending additions survive the menu round trip', () => {
  it('reads back what was written', () => {
    writePendingAdditions('order-1', [{ menuItemId: 'm1', quantity: 1 }])
    expect(readPendingAdditions('order-1')).toEqual([{ menuItemId: 'm1', quantity: 1 }])
  })

  it('appends rather than replacing, so a second trip to the menu keeps the first pick', () => {
    appendPendingAddition('order-1', { menuItemId: 'm1', quantity: 1 })
    appendPendingAddition('order-1', { menuItemId: 'm2', quantity: 2 })
    expect(readPendingAdditions('order-1')).toHaveLength(2)
  })

  it('is empty for an order nothing was picked for', () => {
    expect(readPendingAdditions('order-never-touched')).toEqual([])
  })
})

describe('picks are keyed per order', () => {
  it('does not leak between two orders being edited', () => {
    appendPendingAddition('order-1', { menuItemId: 'm1' })
    appendPendingAddition('order-2', { menuItemId: 'm2' })

    expect(readPendingAdditions('order-1')).toEqual([{ menuItemId: 'm1' }])
    expect(readPendingAdditions('order-2')).toEqual([{ menuItemId: 'm2' }])
  })

  it('clearing one leaves the other alone', () => {
    appendPendingAddition('order-1', { menuItemId: 'm1' })
    appendPendingAddition('order-2', { menuItemId: 'm2' })
    clearPendingAdditions('order-1')

    expect(readPendingAdditions('order-1')).toEqual([])
    expect(readPendingAdditions('order-2')).toHaveLength(1)
  })

  it('uses a namespaced key, so it cannot collide with other flashtap storage', () => {
    appendPendingAddition('order-1', { menuItemId: 'm1' })
    const keys = Object.keys(window.sessionStorage)
    expect(keys).toContain(`${EDIT_PENDING_ADDITIONS_PREFIX}order-1`)
  })
})

describe('clearing', () => {
  it('removes the key entirely rather than leaving an empty array behind', () => {
    appendPendingAddition('order-1', { menuItemId: 'm1' })
    clearPendingAdditions('order-1')
    expect(window.sessionStorage.getItem(`${EDIT_PENDING_ADDITIONS_PREFIX}order-1`)).toBeNull()
  })

  it('an empty write is a clear — this is what the editor does on Cancel', () => {
    // The reopen-on-return check asks whether any pending addition exists, so a leftover `[]`
    // that read as truthy would reopen the editor forever.
    appendPendingAddition('order-1', { menuItemId: 'm1' })
    writePendingAdditions('order-1', [])
    expect(readPendingAdditions('order-1')).toEqual([])
    expect(window.sessionStorage.getItem(`${EDIT_PENDING_ADDITIONS_PREFIX}order-1`)).toBeNull()
  })
})

describe('bad state degrades to empty rather than throwing', () => {
  it('survives unparseable JSON', () => {
    window.sessionStorage.setItem(`${EDIT_PENDING_ADDITIONS_PREFIX}order-1`, '{not json')
    expect(readPendingAdditions('order-1')).toEqual([])
  })

  it('survives a stored value that is not an array', () => {
    window.sessionStorage.setItem(`${EDIT_PENDING_ADDITIONS_PREFIX}order-1`, '{"a":1}')
    expect(readPendingAdditions('order-1')).toEqual([])
  })

  it('ignores a blank order id rather than writing to a shared key', () => {
    appendPendingAddition('', { menuItemId: 'm1' })
    expect(readPendingAdditions('')).toEqual([])
    expect(Object.keys(window.sessionStorage)).toHaveLength(0)
  })
})

describe('toPendingAddition carries what the SERVER prices from, and nothing else', () => {
  it('maps the cart item shape to the order item shape', () => {
    const addition = toPendingAddition({
      menu_item_id: 'm1',
      name: 'Coke',
      display_name: 'Coke 300ml',
      quantity: 2,
      selected_variants: { Size: 'Large' },
      selected_size: { name: 'Large' },
      selected_addons: [{ name: 'Ice' }],
      special_instructions: 'no straw',
    })

    expect(addition).toMatchObject({
      menuItemId: 'm1',
      displayName: 'Coke 300ml',
      quantity: 2,
      selectedVariants: { Size: 'Large' },
      size: 'Large',
      specialInstructions: 'no straw',
    })
  })

  it('does NOT carry client-computed money', () => {
    // The server prices every addition against the live menu. Carrying `subtotal`/`base_price`
    // through would suggest those figures mean something on the way in; they do not, and the
    // staging simulation proves it by sending 0.01 and watching the menu price come back.
    const addition = toPendingAddition({
      menu_item_id: 'm1',
      name: 'Coke',
      quantity: 1,
      subtotal: 0.01,
      base_price: 0.01,
      total: 0.01,
    })

    expect(addition).not.toHaveProperty('subtotal')
    expect(addition).not.toHaveProperty('base_price')
    expect(addition).not.toHaveProperty('basePrice')
    expect(addition).not.toHaveProperty('total')
  })

  it('defaults a missing quantity to 1 rather than to zero or NaN', () => {
    expect(toPendingAddition({ menu_item_id: 'm1' }).quantity).toBe(1)
  })
})

describe('the query parameter is shared, not restated', () => {
  it('is the one the editor writes and the menu reads', () => {
    expect(EDIT_PICK_PARAM).toBe('pickFor')
  })
})
