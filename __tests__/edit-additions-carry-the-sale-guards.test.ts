/**
 * Binds to lib/orders/apply-edit-additions.ts.
 *
 * WHY THIS FILE IS MOSTLY ABOUT GUARDS AND NOT ABOUT ADDING. The edit route's entire safety
 * argument used to be "this is a strict reduction of what is already there" — an index outside
 * the stored array is refused, and a quantity may not rise. The 2026-08-16 ruling removes that
 * argument by letting an edit ADD, so the four controls that protect the creation of a sale have
 * to be present on this path or they are simply gone for anyone who reaches ordering through the
 * editor instead of through the cart.
 *
 * Measured at 85a945c before writing this: `checkStockSufficiency` appeared only in
 * app/api/orders/route.ts and app/api/terminal/orders/route.ts, and `validateOrderQuantities`
 * only in app/api/orders/route.ts. Neither was reachable from the edit route.
 *
 * So each test below names the guard it is standing in for, and the assertion is that the
 * addition is REFUSED — not that adding works.
 */
import { applyEditAdditions } from '@/lib/orders/apply-edit-additions'

jest.mock('@/lib/orders/check-stock-sufficiency', () => ({
  checkStockSufficiency: jest.fn(),
}))
jest.mock('@/lib/orders/calculate-order-pricing', () => ({
  calculateOrderPricing: jest.fn(),
}))

import { checkStockSufficiency } from '@/lib/orders/check-stock-sufficiency'
import { calculateOrderPricing } from '@/lib/orders/calculate-order-pricing'

const stockMock = checkStockSufficiency as jest.Mock
const pricingMock = calculateOrderPricing as jest.Mock

const KEPT = {
  items: [{ name: 'Beef Burger', quantity: 1, total: 95 }],
  subtotal: 82.61,
  tax: 12.39,
  total: 95,
}

const supabase = {} as never

function run(additions: Record<string, unknown>[]) {
  return applyEditAdditions({ supabase, restaurantUuid: 'r-uuid', kept: KEPT, additions })
}

beforeEach(() => {
  jest.clearAllMocks()
  stockMock.mockResolvedValue({ ok: true, unavailable: [] })
  pricingMock.mockResolvedValue({
    items: [{ name: 'Coke', quantity: 1, total: 20 }],
    subtotal: 17.39,
    tax: 2.61,
    total: 20,
    warnings: [],
  })
})

describe('a pure reduction is untouched', () => {
  it('returns the kept lines unchanged and calls nothing', async () => {
    const result = await run([])
    expect(result).toEqual({ ok: true, ...KEPT })
    expect(stockMock).not.toHaveBeenCalled()
    expect(pricingMock).not.toHaveBeenCalled()
  })
})

describe('GUARD — the per-line quantity cap, ported from POST /api/orders', () => {
  it('refuses a quantity above the cap, before pricing or stock are consulted', async () => {
    const result = await run([{ menuItemId: 'm1', quantity: 9999 }])

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.refusal.kind).toBe('quantity')
    // The cheapest check runs first, and nothing is priced or reserved on a refusal.
    expect(pricingMock).not.toHaveBeenCalled()
    expect(stockMock).not.toHaveBeenCalled()
  })

  it('refuses a fractional quantity', async () => {
    const result = await run([{ menuItemId: 'm1', quantity: 2.5 }])
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.refusal.kind).toBe('quantity')
  })
})

describe('GUARD — stock sufficiency, ported from POST /api/orders', () => {
  it('refuses an out-of-stock addition and names every offender at once', async () => {
    stockMock.mockResolvedValue({
      ok: false,
      reason: 'Coke is out of stock and cannot be ordered right now',
      unavailable: [
        { itemName: 'Coke', stockItemName: 'Coke 300ml' },
        { itemName: 'Fanta', stockItemName: 'Fanta 300ml' },
      ],
    })

    const result = await run([{ menuItemId: 'm1', quantity: 1 }])

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.refusal.kind).toBe('out_of_stock')
    if (result.refusal.kind !== 'out_of_stock') throw new Error('unreachable')
    // All of them, so the customer does not discover them one refusal at a time.
    expect(result.refusal.unavailable).toEqual([
      { item: 'Coke', ingredient: 'Coke 300ml' },
      { item: 'Fanta', ingredient: 'Fanta 300ml' },
    ])
    expect(pricingMock).not.toHaveBeenCalled()
  })

  it('a failed stock READ does not refuse the edit — identical to the creation path', async () => {
    // Deliberately the same fail-open POST /api/orders has. Diverging would make the same
    // customer action succeed or fail depending on which route reached it.
    stockMock.mockRejectedValue(new Error('balance query exploded'))
    jest.spyOn(console, 'error').mockImplementation(() => {})

    const result = await run([{ menuItemId: 'm1', quantity: 1 }])

    expect(result.ok).toBe(true)
    expect(pricingMock).toHaveBeenCalled()
  })
})

describe('GUARD — pricing against the live menu', () => {
  it('prices the additions with the shipped pricer, not with anything the client sent', async () => {
    await run([{ menuItemId: 'm1', quantity: 1, basePrice: 0.01, subtotal: 0.01, total: 0.01 }])

    expect(pricingMock).toHaveBeenCalledWith(supabase, 'r-uuid', [
      { menuItemId: 'm1', quantity: 1, basePrice: 0.01, subtotal: 0.01, total: 0.01 },
    ])
  })

  it("uses the pricer's figures and discards the client's", async () => {
    const result = await run([{ menuItemId: 'm1', quantity: 1, total: 0.01 }])

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    // 95 kept + 20 priced, never 95 + 0.01.
    expect(result.total).toBe(115)
  })

  it('turns a pricing failure into a refusal rather than a 500', async () => {
    const err = Object.assign(new Error('Beef Burger is no longer on the menu'), {
      code: 'MENU_ITEM_UNMATCHED',
    })
    pricingMock.mockRejectedValue(err)

    const result = await run([{ menuItemId: 'gone', quantity: 1 }])

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.refusal.kind).toBe('pricing')
    if (result.refusal.kind !== 'pricing') throw new Error('unreachable')
    // The CODE travels, not just prose -- #273.
    expect(result.refusal.code).toBe('MENU_ITEM_UNMATCHED')
  })
})

describe('the merge', () => {
  it('appends the added lines after the kept ones', async () => {
    const result = await run([{ menuItemId: 'm1', quantity: 1 }])
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.items).toEqual([
      { name: 'Beef Burger', quantity: 1, total: 95 },
      { name: 'Coke', quantity: 1, total: 20 },
    ])
  })

  it('sums both halves server-side and rounds to cents', async () => {
    // Two independently-rounded halves added raw reintroduce the sub-cent drift #180 removed.
    pricingMock.mockResolvedValue({
      items: [],
      subtotal: 0.1,
      tax: 0.2,
      total: 0.30000000000000004,
      warnings: [],
    })
    const result = await run([{ menuItemId: 'm1', quantity: 1 }])
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.total).toBe(95.3)
    expect(result.subtotal).toBe(82.71)
    expect(result.tax).toBe(12.59)
  })
})
