/**
 * Binds to the shipped predicate in lib/customer-copy/qr-redesign-copy.ts.
 *
 * The rule that matters is the NEGATIVE one: My Orders is reachable from the browse header at
 * any time, and a customer who opens it to check on an order placed twenty minutes ago must not
 * be told "order sent". Only the cart's own `?placed=1` may raise the banner.
 */
import {
  ORDER_PLACED_BANNER_MS,
  ORDER_PLACED_PARAM,
  QR_REDESIGN_PENDING_COPY,
  shouldShowOrderPlacedBanner,
} from '@/lib/customer-copy/qr-redesign-copy'

describe('shouldShowOrderPlacedBanner', () => {
  it('raises the banner for the value the cart sets', () => {
    expect(shouldShowOrderPlacedBanner('1')).toBe(true)
  })

  it('does not raise it when the parameter is absent', () => {
    // URLSearchParams.get returns null for an absent key -- the ordinary case of opening
    // My Orders from the browse header.
    expect(shouldShowOrderPlacedBanner(null)).toBe(false)
    expect(shouldShowOrderPlacedBanner(undefined)).toBe(false)
  })

  it('does not raise it for a bare `?placed` with no value', () => {
    expect(shouldShowOrderPlacedBanner('')).toBe(false)
  })

  it.each(['0', 'true', 'yes', '2', ' 1'])('does not raise it for %p', (value) => {
    expect(shouldShowOrderPlacedBanner(value)).toBe(false)
  })
})

describe('the copy the banner renders', () => {
  it('is still a placeholder, so the morning report can find it', () => {
    // If this fails because the human has signed the wording off, delete the assertion and the
    // entry in the PENDING COPY list -- do not weaken it to keep the suite green.
    expect(QR_REDESIGN_PENDING_COPY.orderPlacedBanner).toMatch(/^PENDING COPY — /)
  })
})

describe('the parameter name and lifetime are shared, not restated', () => {
  it('exports the parameter the cart writes and My Orders reads', () => {
    expect(ORDER_PLACED_PARAM).toBe('placed')
  })

  it('keeps the banner on screen long enough to be read, and not indefinitely', () => {
    expect(ORDER_PLACED_BANNER_MS).toBeGreaterThanOrEqual(3000)
    expect(ORDER_PLACED_BANNER_MS).toBeLessThanOrEqual(15000)
  })
})
