/**
 * Issue #129 residual — the UI caps instruction text at three textareas via
 * MAX_INSTRUCTIONS_LENGTH, but `maxLength` is an attribute on someone else's browser. The
 * order-level note (app/api/orders/route.ts, both the order_requests and the orders insert)
 * and the per-item note (spread verbatim through calculate-order-pricing's `{...item}` into
 * the stored items JSON) were written with no length check at all, into a `text` column.
 *
 * Asserted against the real POST handler, not just the validator, because the validator being
 * correct is not evidence that the route calls it. A control at exactly the cap is included:
 * the guard has to be length-sensitive, not a blanket refusal.
 */
import { MAX_INSTRUCTIONS_LENGTH } from '@/lib/orders/instruction-limits'

// lib/supabase/restaurants.ts pulls in the BROWSER client, which builds itself at module load
// and needs NEXT_PUBLIC_* keys that .env.test does not carry. Stubbed so importing the route
// does not fail before a single assertion runs.
jest.mock('@/lib/supabase/client', () => ({
  supabase: {},
  getSupabaseClient: () => ({}),
}))

jest.mock('@/lib/supabase/server', () => ({
  createServerSupabaseClient: () => ({}),
}))

// payments/paycloud.js is untranspiled ESM, so it cannot be loaded by this runner at all.
// Stubbed to let the route module import; nothing here reaches a payment call.
jest.mock('@/payments/paycloud', () => ({
  createPaymentRequest: jest.fn(),
  paycloudWireMerchantOrderNo: jest.fn(),
}))

import { POST } from '@/app/api/orders/route'

const RESTAURANT = '01bf27f1-a958-4322-bb3e-cc5240987808'

function body(over: Record<string, unknown>) {
  return {
    restaurantId: RESTAURANT,
    tableNumber: 4,
    sessionId: 'sess-1',
    channel: 'table',
    items: [
      {
        menuItemId: 'coffee-1',
        name: 'Cappuccino',
        displayName: 'Cappuccino',
        quantity: 1,
        basePrice: 30,
        addons: [],
        specialInstructions: '',
        subtotal: 30,
      },
    ],
    subtotal: 30,
    total: 30,
    ...over,
  }
}

async function post(payload: Record<string, unknown>) {
  const res = await POST(
    new Request('https://riviera.flashtap.app/api/orders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }),
  )
  const json = await res.json().catch(() => ({}))
  return { status: res.status, error: String((json as any)?.error ?? '') }
}

const AT_CAP = 'a'.repeat(MAX_INSTRUCTIONS_LENGTH)
const OVER_CAP = 'a'.repeat(MAX_INSTRUCTIONS_LENGTH + 1)

describe('server-side instruction length cap (#129)', () => {
  it('rejects an order-level note longer than the cap', async () => {
    const { status, error } = await post(body({ orderInstructions: OVER_CAP }))
    expect(status).toBe(400)
    expect(error).toContain(String(MAX_INSTRUCTIONS_LENGTH))
  })

  it('rejects a per-item note longer than the cap, naming the item', async () => {
    const { status, error } = await post(
      body({
        items: [{ ...body({}).items[0], specialInstructions: OVER_CAP }],
      }),
    )
    expect(status).toBe(400)
    expect(error).toContain('Cappuccino')
    expect(error).toContain(String(MAX_INSTRUCTIONS_LENGTH))
  })

  it('rejects the snake_case spelling of the per-item note too', async () => {
    // The wire format is specialInstructions, but the cart item's own field is
    // special_instructions and calculate-order-pricing accepts either spelling for its other
    // fields. A cap that only knows one spelling is a cap with a documented bypass.
    const { status } = await post(
      body({
        items: [{ ...body({}).items[0], special_instructions: OVER_CAP }],
      }),
    )
    expect(status).toBe(400)
  })

  it('control: a note at exactly the cap is not rejected for length', async () => {
    // Supabase is mocked to an empty object, so this request cannot succeed -- but it must not
    // fail with the length error, which is what proves the guard measures rather than refuses.
    const { error } = await post(body({ orderInstructions: AT_CAP }))
    expect(error).not.toMatch(new RegExp(String(MAX_INSTRUCTIONS_LENGTH)))
  })

  it('control: a per-item note at exactly the cap is not rejected for length', async () => {
    const { error } = await post(
      body({ items: [{ ...body({}).items[0], specialInstructions: AT_CAP }] }),
    )
    expect(error).not.toMatch(new RegExp(String(MAX_INSTRUCTIONS_LENGTH)))
  })

  it('control: an order with no notes at all is not rejected for length', async () => {
    const { error } = await post(body({}))
    expect(error).not.toMatch(new RegExp(String(MAX_INSTRUCTIONS_LENGTH)))
  })
})
