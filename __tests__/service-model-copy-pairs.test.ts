import { MENU_COPY } from '@/lib/customer-copy/menu-copy'
import {
  deriveIsCounterService,
  serviceCopy,
  SERVICE_COPY_PAIRS,
  PAIRS_ALLOWED_IDENTICAL,
} from '@/lib/customer-copy/service-model'
import { readFileSync } from 'fs'
import { join } from 'path'

/**
 * SERVICE-MODEL COPY, PINNED BOTH WAYS.
 *
 * The failure this guards against is not "the wrong string renders" -- it is `isCounterService`
 * going DECORATIVE: read at every site, honoured at none, with both halves of a pair holding the
 * same words so nothing ever looks wrong. A one-directional test cannot see that. Asserting only
 * "a counter venue gets the counter string" passes just as happily when both strings are identical
 * and the flag changes nothing.
 *
 * So every pair is asserted in BOTH directions AND asserted to DIFFER.
 */
const ROOT = join(__dirname, '..')
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8')

const SURFACES = [
  'app/menu/[restaurantId]/cart/page.tsx',
  'app/menu/[restaurantId]/tab/page.tsx',
  'app/menu/[restaurantId]/v2/page.tsx',
  'app/menu/[restaurantId]/order-confirmation/[orderId]/page.tsx',
]

describe('deriveIsCounterService', () => {
  it('is true for a counter-service venue, and for a kiosk at any venue', () => {
    expect(deriveIsCounterService({ restaurant: { is_counter_service: true } })).toBe(true)
    expect(deriveIsCounterService({ isKiosk: true, restaurant: { is_counter_service: false } })).toBe(true)
  })

  it('FAILS CLOSED to table service on null or missing, never to counter', () => {
    // A null must not send a table-service customer to a counter that may not take payment.
    expect(deriveIsCounterService({ restaurant: { is_counter_service: null } })).toBe(false)
    expect(deriveIsCounterService({ restaurant: {} })).toBe(false)
    expect(deriveIsCounterService({ restaurant: null })).toBe(false)
    expect(deriveIsCounterService({})).toBe(false)
  })

  it('does not treat a truthy non-true value as counter service', () => {
    // The column is boolean|null; a string 'false' from a loose fetch must not flip the model.
    expect(deriveIsCounterService({ restaurant: { is_counter_service: 'false' as never } })).toBe(false)
  })
})

describe('every service-model pair is pinned in both directions', () => {
  const counter = serviceCopy(true)
  const table = serviceCopy(false)

  it('resolves a different object for each service model', () => {
    expect(counter).not.toEqual(table)
  })

  it.each(SERVICE_COPY_PAIRS)('%s differs between counter and table', (key) => {
    const c = counter[key]
    const t = table[key]
    expect(typeof c).toBe('string')
    expect(typeof t).toBe('string')
    expect(c.length).toBeGreaterThan(0)
    expect(t.length).toBeGreaterThan(0)
    if (PAIRS_ALLOWED_IDENTICAL.includes(key)) {
      // Labels are the payment method's name; only the explanation underneath changes.
      expect(c).toBe(t)
    } else {
      // Equality here would make isCounterService decorative for this pair.
      expect(c).not.toBe(t)
    }
  })

  it('no counter string promises a person who is coming to the customer', () => {
    for (const key of SERVICE_COPY_PAIRS) {
      expect(counter[key]).not.toMatch(/\bwaiter\b/i)
      expect(counter[key]).not.toMatch(/\bsomeone\b/i)
      expect(counter[key]).not.toMatch(/come to your table|at your table|bring a card machine/i)
      expect(counter[key]).not.toMatch(/will be with you/i)
    }
  })

  it('the TABLE strings are the ones that still promise a person — control for the test above', () => {
    // If this ever goes empty, the assertion above is passing because there is nothing left to
    // distinguish, not because the counter copy is correct.
    const promising = SERVICE_COPY_PAIRS.filter((k) => /waiter|someone|your table|will be with you/i.test(table[k]))
    expect(promising.length).toBeGreaterThan(0)
  })
})

describe('the render sites cannot bypass the resolver', () => {
  it.each(SURFACES)('%s reads no payCounter*/payTable* key directly', (file) => {
    const src = read(file)
    const direct = [...src.matchAll(/MENU_COPY\.(pay(?:Counter|Table)[A-Za-z]+)/g)].map((m) => m[1])
    expect(direct).toEqual([])
  })

  it('every surface that shows a service-model string derives the model', () => {
    for (const file of SURFACES) {
      const src = read(file)
      if (!/\bcopy\.[a-zA-Z]/.test(src)) continue
      expect(src).toMatch(/serviceCopy\(/)
    }
  })

  it('CONTROL: the resolver is genuinely reachable from each surface', () => {
    // Guards the assertion above from passing because no surface uses `copy.` at all.
    const users = SURFACES.filter((f) => /serviceCopy\(/.test(read(f)))
    expect(users).toHaveLength(SURFACES.length)
  })
})

describe('the signed counter wording', () => {
  it('is the text the owner signed on 2026-08-25, character for character', () => {
    expect(MENU_COPY.payCounterCouldNotNotifyStaff).toBe('could not reach the counter')
    expect(MENU_COPY.payCounterPleaseAskForAssistance).toBe('please ask at the counter for assistance.')
    expect(MENU_COPY.payCounterStaffNotified).toBe('the counter has been notified.')
    expect(MENU_COPY.payCounterTabReadyToPay).toBe('your tab is ready to pay at the counter.')
    expect(MENU_COPY.payCounterAssistWithPayment).toBe('pay at the counter when you are ready')
    expect(MENU_COPY.payCounterOrderReady).toBe('your order is ready for collection at the counter.')
  })

  it('left every TABLE variant unchanged, which is what "table variants unchanged" meant', () => {
    expect(MENU_COPY.payTableCouldNotNotifyStaff).toBe('Could not notify waiter')
    expect(MENU_COPY.payTablePleaseAskForAssistance).toBe('Please wait or ask your waiter for assistance.')
    expect(MENU_COPY.payTableStaffNotified).toBe('A waiter has been notified and will assist you shortly.')
    expect(MENU_COPY.payTableTabReadyToPay).toBe('Your tab is ready to pay — your waiter has been notified.')
    expect(MENU_COPY.payTableAssistWithPayment).toBe('Staff will assist with payment at your table')
    expect(MENU_COPY.payTableOrderReady).toBe('Your order is ready! A staff member will come to your table shortly.')
  })
})
