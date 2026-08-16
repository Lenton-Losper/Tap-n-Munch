/**
 * #206 -- the census. Every string `/api/orders` can put in `error`, classified.
 *
 * This file is the enumeration the issue asks for as step 1, written so it cannot rot: each
 * entry was read out of `app/api/orders/route.ts` at `cloudflare-staging`, and adding a message
 * to that route without classifying it here leaves the census incomplete rather than leaving a
 * leak invisible.
 *
 * The two families are asserted in opposite directions on purpose. SAFE strings must survive
 * verbatim -- a filter that suppressed everything would "fix" #206 by telling every customer
 * "Please try again" when the real answer was "that item is out of stock", which is a worse
 * screen, not a safer one. INTERNAL strings must be replaced -- and the list includes the raw
 * Supabase text the issue named, the leaked internal status identifier, and the payment SDK's
 * own error.
 */
import {
  classifyCustomerError,
  customerSafeError,
  CUSTOMER_SAFE_MESSAGES,
} from '@/lib/customer-copy/customer-safe-error'

const FALLBACK = 'Please try again.'

/** Written for a customer. Must reach the screen unchanged. */
const SAFE: Array<[string, string]> = [
  ['view-only table', 'This is a view-only menu — ordering is not available here.'],
  ['tab ready to pay', 'This tab is ready to pay — you cannot add more items.'],
  ['table closed', 'This table has been closed. Please scan the QR code to start a new session.'],
  ['payment method', 'This restaurant does not accept cash payments.'],
  ['payment method, underscored', 'This restaurant does not accept card_terminal payments.'],
  ['table not orderable', 'This table is not available for ordering.'],
  ['kiosk', 'This link is not configured as a kiosk.'],
  ['quantity missing', 'Please choose how many of Flat White you would like.'],
  ['quantity fractional', 'You can only order whole numbers of Flat White.'],
  ['quantity minimum', 'Please order at least 1 of Flat White.'],
  [
    'quantity maximum',
    'You can order up to 20 of Flat White at a time. For a larger order, please ask a member of staff.',
  ],
  ['stock, one item', 'Flat White is out of stock and cannot be ordered right now.'],
  [
    'stock, several items',
    'Flat White and Cappuccino are out of stock and cannot be ordered right now. Please remove them and try again.',
  ],
]

/** Written for an operator, a log, or nobody. Must never reach a customer. */
const INTERNAL: Array<[string, string]> = [
  // The exact shape #206 named: a raw Supabase message returned as `error` on a 500.
  ['raw postgres', 'duplicate key value violates unique constraint "orders_pkey"'],
  ['raw postgrest', "Could not find the table 'public.order_revisions' in the schema cache"],
  ['raw column error', 'column orders.paid_at does not exist'],
  // Leaks an internal status identifier -- the #275 family, on the customer side.
  ['internal status leak', 'Tab is not open (status=ready_to_pay)'],
  ['generic 500', 'Internal server error'],
  ['missing param', 'Missing restaurantId'],
  ['missing param 2', 'tabId is required'],
  ['not found', 'Tab not found'],
  ['orphan write', 'Order created without restaurant_id'],
  ['payment session', 'Failed to persist payment session'],
  ['paycloud', 'Payment link was not returned by PayCloud'],
  ['payment init', 'Payment initialization failed'],
  ['credentials', 'This restaurant has not configured their payment credentials. Please update settings.'],
  ['bare fetch failure', 'Failed to fetch'],
  ['status template', 'Request failed (500)'],
]

describe('#206 census -- customer-facing strings survive', () => {
  it.each(SAFE)('%s', (_label, message) => {
    const verdict = classifyCustomerError(new Error(message), FALLBACK)
    expect(verdict.allowed).toBe(true)
    expect(verdict.text).toBe(message)
    expect(verdict.matched).not.toBeNull()
  })
})

describe('#206 census -- internal strings are replaced', () => {
  it.each(INTERNAL)('%s', (_label, message) => {
    const verdict = classifyCustomerError(new Error(message), FALLBACK)
    expect(verdict.allowed).toBe(false)
    expect(verdict.text).toBe(FALLBACK)
  })
})

describe('#206 default-deny', () => {
  it('a string nobody has ever seen is denied', () => {
    // The population that actually matters: everything not yet written.
    expect(customerSafeError(new Error('kzzt 0x41 unexpected'), FALLBACK)).toBe(FALLBACK)
  })

  it('empty, null, undefined and non-Error shapes all fall back', () => {
    for (const raw of [null, undefined, '', '   ', 42, {}, { message: 7 }]) {
      expect(customerSafeError(raw, FALLBACK)).toBe(FALLBACK)
    }
  })

  it('reads a plain string and a bare {message} as well as an Error', () => {
    const safe = 'This link is not configured as a kiosk.'
    expect(customerSafeError(safe, FALLBACK)).toBe(safe)
    expect(customerSafeError({ message: safe }, FALLBACK)).toBe(safe)
  })
})

describe('#206 the allowlist is anchored', () => {
  it('every pattern is anchored at both ends', () => {
    // An unanchored entry would admit a raw database error that merely CONTAINS a safe sentence,
    // which is the leak this whole file exists to prevent.
    for (const entry of CUSTOMER_SAFE_MESSAGES) {
      expect(entry.source).not.toBe('')
      expect(entry.pattern.source.startsWith('^')).toBe(true)
      expect(entry.pattern.source.endsWith('$')).toBe(true)
    }
  })

  it('a safe sentence buried inside a database error is still denied', () => {
    const buried =
      'error: This table is not available for ordering. at Object.handler (/worker.js:1:2)'
    expect(customerSafeError(buried, FALLBACK)).toBe(FALLBACK)
  })
})
