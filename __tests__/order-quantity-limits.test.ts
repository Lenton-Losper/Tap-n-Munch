import {
  clampLineQuantity,
  MAX_LINE_QUANTITY,
  MIN_LINE_QUANTITY,
  validateLineQuantity,
  validateOrderQuantities,
} from '../lib/orders/quantity-limits'

describe('validateLineQuantity', () => {
  it('accepts the whole allowed range', () => {
    for (const q of [MIN_LINE_QUANTITY, 2, 7, MAX_LINE_QUANTITY]) {
      expect(validateLineQuantity(q)).toEqual({ ok: true, quantity: q })
    }
  })

  it('rejects above the cap and names the limit', () => {
    const result = validateLineQuantity(MAX_LINE_QUANTITY + 1, 'Chicken burger')
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.reason).toContain(String(MAX_LINE_QUANTITY))
    expect(result.reason).toContain('Chicken burger')
    expect(result.reason).toMatch(/ask a member of staff/i)
  })

  it('rejects the values that used to be silently coerced to 1', () => {
    // extractQuantity turned every one of these into a quantity-1 order.
    for (const bad of [0, -5, 'abc', null, undefined, '', NaN, Infinity]) {
      expect(validateLineQuantity(bad).ok).toBe(false)
    }
  })

  it('rejects fractional quantities', () => {
    const result = validateLineQuantity(2.5, 'Latte')
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.reason).toMatch(/whole numbers/i)
  })

  it('accepts a numeric string, since form inputs produce them', () => {
    expect(validateLineQuantity('3')).toEqual({ ok: true, quantity: 3 })
  })

  it('never leaks a raw value or the word undefined into customer-facing text', () => {
    for (const bad of [0, -1, 999, 2.5, 'abc', null, undefined]) {
      const result = validateLineQuantity(bad)
      if (result.ok) continue
      expect(result.reason).not.toMatch(/undefined|null|NaN|\[object/i)
      expect(result.reason.length).toBeGreaterThan(10)
    }
  })
})

describe('validateOrderQuantities', () => {
  const line = (quantity: unknown, name = 'Item') => ({ quantity, displayName: name })

  it('passes a valid basket', () => {
    expect(validateOrderQuantities([line(1), line(20), line(5)])).toEqual({ ok: true })
  })

  it('fails the whole order on one bad line and names that item', () => {
    const result = validateOrderQuantities([line(2, 'Coke'), line(50, 'Americano')])
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.reason).toContain('Americano')
  })

  it('treats an empty basket as valid here -- emptiness is a separate check', () => {
    expect(validateOrderQuantities([])).toEqual({ ok: true })
  })

  it('falls back to name when displayName is absent', () => {
    const result = validateOrderQuantities([{ quantity: 99, name: 'Flat white' }])
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.reason).toContain('Flat white')
  })
})

describe('clampLineQuantity', () => {
  it('keeps UI controls inside the range the server will accept', () => {
    expect(clampLineQuantity(0)).toBe(MIN_LINE_QUANTITY)
    expect(clampLineQuantity(-3)).toBe(MIN_LINE_QUANTITY)
    expect(clampLineQuantity(MAX_LINE_QUANTITY + 5)).toBe(MAX_LINE_QUANTITY)
    expect(clampLineQuantity(7)).toBe(7)
    expect(clampLineQuantity(3.9)).toBe(3)
    expect(clampLineQuantity(NaN)).toBe(MIN_LINE_QUANTITY)
  })

  it('produces a value the validator always accepts', () => {
    for (const raw of [-10, 0, 1, 3.7, 20, 21, 1000, NaN]) {
      expect(validateLineQuantity(clampLineQuantity(raw)).ok).toBe(true)
    }
  })
})
