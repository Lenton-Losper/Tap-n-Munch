/**
 * POST /api/admin/documents/from-order — who may call it, and what they may influence.
 *
 * The module tests (invoice-from-order.test.ts) cover the business rules. These cover the boundary:
 * authentication, permission, tenant scoping, and the fact that a client cannot smuggle a figure
 * onto the document through the request body.
 */
import { NextResponse } from 'next/server'

const RESTAURANT_ID = '11111111-1111-4111-8111-111111111111'
const OTHER_RESTAURANT_ID = '22222222-2222-4222-8222-222222222222'
const ORDER_ID = '33333333-3333-4333-8333-333333333333'
const USER_ID = 'user-inv'

let authThrows: boolean
let permissionDenied: boolean
let callerRestaurantId: string | null
let createCalls: Array<Record<string, unknown>>
let createResult: unknown

jest.mock('@/lib/supabase/server', () => ({
  createServerSupabaseClient: () => ({}),
}))

jest.mock('@/lib/supabase/admin-restaurant-auth', () => ({
  getUserFromRequest: async () => {
    if (authThrows) throw new Error('Unauthorized')
    return { id: USER_ID }
  },
  requireCallerRestaurantId: async () =>
    callerRestaurantId ??
    NextResponse.json({ error: 'You do not have permission to perform this action.' }, { status: 403 }),
}))

jest.mock('@/lib/permissions/authorize', () => ({
  requirePermission: async () =>
    permissionDenied
      ? NextResponse.json({ error: 'You do not have permission to perform this action.' }, { status: 403 })
      : null,
}))

jest.mock('@/lib/documents/create-invoice-from-order', () => ({
  createInvoiceFromOrder: async (_db: unknown, args: Record<string, unknown>) => {
    createCalls.push(args)
    return createResult
  },
}))

 
const route = require('@/app/api/admin/documents/from-order/route') as {
  POST: (req: Request) => Promise<Response>
}

function post(body: unknown) {
  return new Request('http://localhost/api/admin/documents/from-order', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

beforeEach(() => {
  authThrows = false
  permissionDenied = false
  callerRestaurantId = RESTAURANT_ID
  createCalls = []
  createResult = { ok: true, document: { id: 'doc-1', document_number: '1', total: 78 }, warnings: [] }
})

describe('authority', () => {
  test('an unauthenticated caller gets 401 and nothing is created', async () => {
    authThrows = true
    const res = await route.POST(post({ order_id: ORDER_ID, restaurant_id: RESTAURANT_ID }))
    expect(res.status).toBe(401)
    expect(createCalls).toHaveLength(0)
  })

  test('a caller without documents:write gets 403 and nothing is created', async () => {
    permissionDenied = true
    const res = await route.POST(post({ order_id: ORDER_ID, restaurant_id: RESTAURANT_ID }))
    expect(res.status).toBe(403)
    expect(createCalls).toHaveLength(0)
  })

  test('a caller naming a venue they do not belong to is refused before any read', async () => {
    callerRestaurantId = null
    const res = await route.POST(post({ order_id: ORDER_ID, restaurant_id: OTHER_RESTAURANT_ID }))
    expect(res.status).toBe(403)
    expect(createCalls).toHaveLength(0)
  })

  test('the AUTHORIZED restaurant is used, never the one in the body', async () => {
    // Authorization resolves RESTAURANT_ID even though the body asks for OTHER_RESTAURANT_ID.
    callerRestaurantId = RESTAURANT_ID
    await route.POST(post({ order_id: ORDER_ID, restaurant_id: OTHER_RESTAURANT_ID }))
    expect(createCalls[0].restaurantId).toBe(RESTAURANT_ID)
  })
})

describe('input handling', () => {
  test('a non-UUID order id is refused', async () => {
    const res = await route.POST(post({ order_id: 'not-a-uuid', restaurant_id: RESTAURANT_ID }))
    expect(res.status).toBe(400)
    expect(createCalls).toHaveLength(0)
  })

  test('a missing restaurant_id is refused', async () => {
    const res = await route.POST(post({ order_id: ORDER_ID }))
    expect(res.status).toBe(400)
  })

  test('client-supplied money fields are IGNORED, not forwarded', async () => {
    await route.POST(
      post({
        order_id: ORDER_ID,
        restaurant_id: RESTAURANT_ID,
        // None of these may reach the document. Every figure comes off the order row.
        total: 1,
        subtotal: 1,
        vat_amount: 0,
        line_items: [{ description: 'Free lunch', quantity: 1, unit_price: 0 }],
        payment_status: 'paid',
        document_number: '999',
      }),
    )

    const args = createCalls[0]
    expect(Object.keys(args).sort()).toEqual(
      ['billTo', 'createdBy', 'dueDate', 'orderId', 'referenceNote', 'restaurantId'].sort(),
    )
    expect(args).not.toHaveProperty('total')
    expect(args).not.toHaveProperty('line_items')
    expect(args).not.toHaveProperty('document_number')
  })

  test('bill_to is trimmed and passed through as the document party', async () => {
    await route.POST(
      post({
        order_id: ORDER_ID,
        restaurant_id: RESTAURANT_ID,
        bill_to: { name: '  Acme CC  ', email: ' a@b.test ' },
      }),
    )
    expect(createCalls[0].billTo).toEqual({ name: 'Acme CC', email: 'a@b.test' })
  })
})

describe('refusals reach the caller intact', () => {
  test('an incomplete billing profile answers 409 and names the missing fields', async () => {
    createResult = {
      ok: false,
      code: 'BILLING_PROFILE_INCOMPLETE',
      message: 'not complete',
      missingBillingFields: ['registration_number'],
    }

    const res = await route.POST(post({ order_id: ORDER_ID, restaurant_id: RESTAURANT_ID }))

    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.code).toBe('BILLING_PROFILE_INCOMPLETE')
    expect(body.missingBillingFields).toEqual(['registration_number'])
  })

  test('a missing order answers 404', async () => {
    createResult = { ok: false, code: 'ORDER_NOT_FOUND', message: 'gone' }
    const res = await route.POST(post({ order_id: ORDER_ID, restaurant_id: RESTAURANT_ID }))
    expect(res.status).toBe(404)
  })

  test('a cancelled order answers 409', async () => {
    createResult = { ok: false, code: 'ORDER_CANCELLED', message: 'cancelled' }
    const res = await route.POST(post({ order_id: ORDER_ID, restaurant_id: RESTAURANT_ID }))
    expect(res.status).toBe(409)
  })
})

test('a successful call answers 201 with the document', async () => {
  const res = await route.POST(post({ order_id: ORDER_ID, restaurant_id: RESTAURANT_ID }))
  expect(res.status).toBe(201)
  expect((await res.json()).document.document_number).toBe('1')
})
