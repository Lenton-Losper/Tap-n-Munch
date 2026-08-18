/**
 * "ORDER #0" MUST NOT BE RENDERABLE. Third occurrence on production, 2026-08-19.
 *
 * The history matters, because it is why this is a class test and a CI scan rather than a fourth
 * one-line fix:
 *
 *   #296        `Number(row.order_number || 0)` -> every unaccepted request said "Order #0"
 *   #308        a number derived from the UUID tail
 *   2026-08-19  `orderNumber != null` in the confirmation view -> a real customer saw "Order #0"
 *
 * THE PRODUCER was `mapOrderRequestToGuestRow`, which set a literal `order_number: 0` because
 * `order_requests` has no such column. Every consumer then had to defend itself, and two defended
 * with `!= null`, which 0 passes. Fixed at source AND at every reader.
 */
import { hasAllocatedOrderNumber, orderIdentityLabel } from '@/lib/orders/order-identity'

describe('hasAllocatedOrderNumber — the one test for "is there a number"', () => {
  it('REJECTS 0, which is the value that shipped three times', () => {
    expect(hasAllocatedOrderNumber({ order_number: 0 })).toBe(false)
  })

  it('rejects the other shapes that mean "none"', () => {
    expect(hasAllocatedOrderNumber({ order_number: null })).toBe(false)
    expect(hasAllocatedOrderNumber({ order_number: undefined })).toBe(false)
    expect(hasAllocatedOrderNumber({ order_number: '' })).toBe(false)
    expect(hasAllocatedOrderNumber({ order_number: '0' })).toBe(false)
    expect(hasAllocatedOrderNumber({ order_number: 'abc' })).toBe(false)
    expect(hasAllocatedOrderNumber(null)).toBe(false)
  })

  it('ACCEPTS a real number — the control, or "rejects everything" would pass the above', () => {
    expect(hasAllocatedOrderNumber({ order_number: 1 })).toBe(true)
    expect(hasAllocatedOrderNumber({ order_number: 42 })).toBe(true)
    expect(hasAllocatedOrderNumber({ order_number: '42' })).toBe(true)
  })

  /**
   * The inline shapes each shipped once. Asserted as behaviour so the difference is visible:
   * both admit 0, which is the entire bug.
   */
  it('differs from the two inline shapes exactly where it matters', () => {
    const zero = 0
    expect(zero != null).toBe(true) // the shape that shipped
    expect(typeof zero === 'number').toBe(true) // the other shape that shipped
    expect(hasAllocatedOrderNumber({ order_number: zero })).toBe(false) // the helper
  })
})

describe('orderIdentityLabel never invents a number', () => {
  it('does not say "#0" for any of the none-allocated shapes', () => {
    for (const v of [0, null, undefined, '', '0']) {
      expect(orderIdentityLabel({ order_number: v, status: 'pending' })).not.toMatch(/#\s*0\b/)
    }
  })

  it('says the real number when there is one', () => {
    expect(orderIdentityLabel({ order_number: 7, status: 'pending' })).toBe('Order #7')
  })
})

describe('the producer no longer invents one', () => {
  /**
   * `mapOrderRequestToGuestRow` is module-private, so this asserts the source line. A behavioural
   * test would need a live Supabase client, and the thing worth pinning is the literal.
   */
  const { readFileSync } = require('fs') as typeof import('fs')
  const { join } = require('path') as typeof import('path')
  const src = readFileSync(join(process.cwd(), 'lib/guest-orders/queries.ts'), 'utf8')

  it('maps an order_request to a null order number, not 0', () => {
    const stripped = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
    expect(stripped).toMatch(/order_number:\s*null/)
    expect(stripped).not.toMatch(/order_number:\s*0\b/)
  })
})

describe('the CI scan that makes a fourth instance impossible', () => {
  const { readFileSync, existsSync } = require('fs') as typeof import('fs')
  const { join } = require('path') as typeof import('path')

  it('exists', () => {
    expect(existsSync(join(process.cwd(), 'scripts/check-order-number-guard.ts'))).toBe(true)
  })

  it('is wired into BOTH gates — staging and production', () => {
    // Production is the bar. A scan that only runs on staging has never gated a customer.
    for (const wf of ['.github/workflows/staging.yml', '.github/workflows/production-worker.yml']) {
      expect(readFileSync(join(process.cwd(), wf), 'utf8')).toMatch(/check-order-number-guard/)
    }
  })
})
