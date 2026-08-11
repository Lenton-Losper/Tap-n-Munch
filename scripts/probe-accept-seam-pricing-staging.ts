/**
 * LIVE-DATA PROBE — the order_requests -> Accept money seam, with NOTHING mocked.
 *
 * Why this exists. Every jest suite on this seam mocks `@/lib/supabase/server` with a hand-rolled
 * chainable stub and mocks `calculateOrderPricing` as well
 * (__tests__/order-accept-preserves-reviewed-total.test.ts:73,125 and
 * __tests__/order-payment-method-allowlist.test.ts:47,111). Those suites therefore prove that the
 * route hands the stored figures to `supabase.from('orders').insert(...)`. They CANNOT prove that
 * the figures survive PostgREST, the column types, the CHECK constraints and the round trip -- i.e.
 * that the row a customer is actually billed against holds the total they were quoted. #125 changed
 * exactly that behaviour (createOrder gained `preauthorizedPricing`, lib/orders/create-order.ts:33
 * and :71), so the money path moved with mocked coverage only.
 *
 * This probe drives the REAL Next.js route handlers in-process against the REAL staging Postgres:
 *   - real `createServerSupabaseClient` (no jest.mock anywhere -- this is not a jest suite)
 *   - real `calculateOrderPricing` against real `menu_items` and real `tax_rates`
 *   - real `requireStaffPermission` with a real Supabase JWT for a real staff membership
 *   - real `enrichOrderItemsWithRouteTo`
 *   - the assertion is a SELECT of the persisted `orders` row, not the route's JSON response
 *
 * In-process, deliberately: an HTTP probe against the staging Worker tests whatever is DEPLOYED,
 * not the code in this worktree. Importing the handlers exercises this branch.
 *
 * What it does NOT cover, on purpose: `payment_channel` is left null so the hosted-checkout block
 * (accept/route.ts:221-249) is not entered and no Finatic session is created. Charging a real
 * gateway is out of scope for a probe; scripts/probe-order-request-accept-race-staging.ts covers
 * the hosted branch over HTTP.
 *
 * THE PRICE MOVE IS THE POINT. Between review and accept the probe changes the catalog price of a
 * menu item it created itself (never a shared fixture item -- other agents run live suites against
 * this same staging project), and first PROVES the counterfactual by calling calculateOrderPricing
 * and showing a fresh pricing pass now yields a different total. Then it asserts the persisted
 * order still holds the quoted one. Without the price move the assertion would pass whether or not
 * the fix is present.
 *
 * Every row it creates is removed in `finally`, and the menu price is restored there too.
 *
 * Marker: PROBE_ACCEPT_SEAM_PRICING_OK
 *
 *   npx tsx scripts/probe-accept-seam-pricing-staging.ts
 */
// @ts-nocheck
import { createClient } from '@supabase/supabase-js'
import { randomUUID } from 'crypto'
import { config } from 'dotenv'
import { resolve } from 'path'

// .env.local points at PRODUCTION (ihlmmpmolnpchzgwyhgh); .env.test points at staging. Load
// .env.test with override:true FIRST, then mirror onto the NEXT_PUBLIC_* names that
// lib/supabase/server.ts and lib/supabase/client.ts actually read -- .env.test does not define
// them, and without this the route handlers would fall back to whatever a shell or .env.local
// left behind. Everything below is guarded by an explicit production refusal anyway.
config({ path: resolve(__dirname, '../.env.test'), override: true })

const PRODUCTION_REF = 'ihlmmpmolnpchzgwyhgh'
const STAGING_REF = 'mdqjpxwczrhkxkbqatqa'

const url = process.env.SUPABASE_URL || ''
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || ''
const anonKey = process.env.SUPABASE_ANON_KEY || ''

for (const [name, value] of Object.entries({
  SUPABASE_URL: url,
  NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
  STAGING_SUPABASE_URL: process.env.STAGING_SUPABASE_URL,
})) {
  if (String(value || '').includes(PRODUCTION_REF)) {
    throw new Error(`REFUSING TO RUN: ${name} resolves to PRODUCTION (${PRODUCTION_REF}).`)
  }
}
if (!url.includes(STAGING_REF)) {
  throw new Error(`REFUSING TO RUN: SUPABASE_URL is not staging ${STAGING_REF} (got "${url}").`)
}
if (!serviceKey || !anonKey) {
  throw new Error('Need SUPABASE_SERVICE_ROLE_KEY and SUPABASE_ANON_KEY from .env.test')
}

process.env.NEXT_PUBLIC_SUPABASE_URL = url
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = anonKey

const RESTAURANT_ID = 'a1999166-ddfa-40d1-ad1f-2f01282a1652'
const MENU_CATEGORY_ID = 'f73dd098-8fc8-4d2a-8485-907550852a4e'
const TABLE_NUMBER = 9903

const QUOTED_UNIT_PRICE = 40
const QUOTED_QUANTITY = 2
const REVIEWED_QUANTITY = 3
/** What the catalog is moved to between review and accept. */
const MOVED_UNIT_PRICE = 999

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`ASSERTION FAILED: ${msg}`)
}

function log(label: string, value?: unknown) {
  if (value === undefined) {
    console.log(`== ${label} ==`)
    return
  }
  console.log(`== ${label} ==`)
  console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2))
}

/** Money comparison on the numbers as persisted, to the cent. */
function sameMoney(a: unknown, b: unknown): boolean {
  return Math.round(Number(a) * 100) === Math.round(Number(b) * 100)
}

async function readJson(res: Response) {
  const text = await res.text()
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

async function main() {
  // Imported AFTER the env is fixed: lib/supabase/client.ts builds a module-scope client from
  // NEXT_PUBLIC_* at import time, so a static import would capture the wrong project.
  const { POST: ordersPOST } = await import('../app/api/orders/route')
  const { PATCH: reviewPATCH } = await import(
    '../app/api/order-requests/[requestId]/review/route'
  )
  const { POST: acceptPOST } = await import(
    '../app/api/order-requests/[requestId]/accept/route'
  )
  const { calculateOrderPricing } = await import('../lib/orders/calculate-order-pricing')

  const admin = createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
  const anon = createClient(url, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  })

  const tag = `acceptseam-${Date.now()}`
  const email = `${tag}@flashtap-test.invalid`
  const password = `Set${randomUUID().slice(0, 8)}!1a`

  let menuItemId: string | null = null
  let userId: string | null = null
  let createdTabId: string | null = null
  const requestIds: string[] = []
  const orderIds: string[] = []

  try {
    // ---- fixtures the probe owns -------------------------------------------------------
    const { data: menuItem, error: menuErr } = await admin
      .from('menu_items')
      .insert({
        restaurant_id: RESTAURANT_ID,
        category_id: MENU_CATEGORY_ID,
        name: `${tag} probe item`,
        base_price: QUOTED_UNIT_PRICE,
        status: 'available',
      })
      .select('id, base_price, tax_rate_id')
      .single()
    assert(!menuErr && menuItem?.id, `menu_items insert failed: ${menuErr?.message}`)
    menuItemId = menuItem.id
    log('probe menu item', { menuItemId, base_price: menuItem.base_price })

    const { data: authUser, error: userErr } = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    })
    assert(!userErr && authUser?.user?.id, `createUser failed: ${userErr?.message}`)
    userId = authUser.user.id

    const { error: usersErr } = await admin
      .from('users')
      .upsert({ id: userId, email, full_name: 'Accept Seam Probe' })
    assert(!usersErr, `users upsert failed: ${usersErr?.message}`)

    const { data: ownerRole } = await admin
      .from('restaurant_roles')
      .select('role_slug, permissions')
      .eq('restaurant_id', RESTAURANT_ID)
      .eq('role_slug', 'owner')
      .maybeSingle()
    assert(
      ownerRole?.role_slug,
      'staging restaurant has no owner role row -- probe will not create one (shared fixture)',
    )

    const { error: memberErr } = await admin.from('restaurant_users').insert({
      restaurant_id: RESTAURANT_ID,
      user_id: userId,
      role: 'owner',
      invite_accepted: true,
    })
    assert(!memberErr, `restaurant_users insert failed: ${memberErr?.message}`)

    const { data: signIn, error: signInErr } = await anon.auth.signInWithPassword({
      email,
      password,
    })
    assert(!signInErr && signIn?.session?.access_token, `sign-in failed: ${signInErr?.message}`)
    const token = signIn.session.access_token

    // POST /api/orders refuses a non-tab table order unless the table has an OPEN tab
    // (app/api/orders/route.ts:158-178). Reuse one if staging already has it; only clean up
    // a tab this probe created.
    const { data: existingTab } = await admin
      .from('tabs')
      .select('id')
      .eq('restaurant_id', RESTAURANT_ID)
      .eq('table_number', TABLE_NUMBER)
      .eq('status', 'open')
      .maybeSingle()

    if (!existingTab?.id) {
      const { data: newTab, error: tabErr } = await admin
        .from('tabs')
        .insert({
          restaurant_id: RESTAURANT_ID,
          table_number: TABLE_NUMBER,
          status: 'open',
          total: 0,
          members: [],
        })
        .select('id')
        .single()
      assert(!tabErr && newTab?.id, `tabs insert failed: ${tabErr?.message}`)
      createdTabId = newTab.id
    }
    log('open tab for table', { tableNumber: TABLE_NUMBER, createdByProbe: createdTabId })

    const staffHeaders = {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    }

    // =====================================================================================
    // SCENARIO 1 — staff reviewed the order, then the catalog price moved before Accept.
    // =====================================================================================
    log('SCENARIO 1: reviewed request, catalog moves before Accept')

    const sessionId = `sess_${tag}_1`
    const quoteRes = await ordersPOST(
      new Request('https://probe.local/api/orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          restaurantId: RESTAURANT_ID,
          tableNumber: TABLE_NUMBER,
          channel: 'table',
          sessionId,
          customerName: 'Accept Seam Probe',
          paymentMethod: 'card',
          items: [
            {
              menuItemId,
              name: `${tag} probe item`,
              quantity: QUOTED_QUANTITY,
              // Deliberately absurd client-supplied money: the quote must ignore it.
              unitPrice: 1,
              price: 1,
            },
          ],
          // Client-claimed totals, also deliberately wrong.
          subtotal: 2,
          total: 2,
        }),
      }),
    )
    const quoteBody = await readJson(quoteRes)
    log('POST /api/orders', { status: quoteRes.status, body: quoteBody })
    assert(quoteRes.status === 200, `quote failed: ${JSON.stringify(quoteBody)}`)
    const requestId = String(quoteBody.requestId)
    requestIds.push(requestId)

    const { data: quotedRow, error: quotedErr } = await admin
      .from('order_requests')
      .select('*')
      .eq('id', requestId)
      .single()
    assert(!quotedErr && quotedRow, `order_requests read failed: ${quotedErr?.message}`)
    log('order_request as quoted', {
      status: quotedRow.status,
      subtotal: quotedRow.subtotal,
      tax: quotedRow.tax,
      total: quotedRow.total,
    })
    assert(quotedRow.status === 'waiting_review', 'a table submission must land waiting_review')
    assert(
      sameMoney(quotedRow.total, QUOTED_UNIT_PRICE * QUOTED_QUANTITY),
      `quote must price from the catalog (${QUOTED_UNIT_PRICE * QUOTED_QUANTITY}), got ${quotedRow.total}`,
    )

    // ---- staff review: quantity 2 -> 3 -------------------------------------------------
    const reviewRes = await reviewPATCH(
      new Request(`https://probe.local/api/order-requests/${requestId}/review`, {
        method: 'PATCH',
        headers: staffHeaders,
        body: JSON.stringify({
          items: [{ menuItemId, name: `${tag} probe item`, quantity: REVIEWED_QUANTITY }],
        }),
      }),
      { params: Promise.resolve({ requestId }) },
    )
    const reviewBody = await readJson(reviewRes)
    log('PATCH .../review', { status: reviewRes.status, body: reviewBody })
    assert(reviewRes.status === 200, `review failed: ${JSON.stringify(reviewBody)}`)

    const { data: reviewedRow } = await admin
      .from('order_requests')
      .select('subtotal, tax, total, subtotal_reviewed, tax_reviewed, total_reviewed, items_reviewed')
      .eq('id', requestId)
      .single()
    log('order_request after review', {
      total: reviewedRow.total,
      total_reviewed: reviewedRow.total_reviewed,
      subtotal_reviewed: reviewedRow.subtotal_reviewed,
      tax_reviewed: reviewedRow.tax_reviewed,
    })
    assert(
      sameMoney(reviewedRow.total_reviewed, QUOTED_UNIT_PRICE * REVIEWED_QUANTITY),
      `review must reprice from the catalog, got ${reviewedRow.total_reviewed}`,
    )

    // This is the number the customer is shown (total_reviewed ?? total) and the number the
    // hosted checkout would charge. It is the ONLY number the orders row may hold.
    const quotedToCustomer = Number(reviewedRow.total_reviewed)

    // ---- the catalog moves -------------------------------------------------------------
    const { error: moveErr } = await admin
      .from('menu_items')
      .update({ base_price: MOVED_UNIT_PRICE })
      .eq('id', menuItemId)
    assert(!moveErr, `price move failed: ${moveErr?.message}`)

    // Counterfactual, established empirically rather than assumed: a fresh pricing pass taken
    // at Accept time now produces a DIFFERENT total. Without this the assertion below would be
    // one-sided and would pass even if nothing were being preserved.
    const repriced = await calculateOrderPricing(admin, RESTAURANT_ID, [
      { menuItemId, quantity: REVIEWED_QUANTITY },
    ])
    log('counterfactual: what a re-price at Accept would say now', {
      subtotal: repriced.subtotal,
      tax: repriced.tax,
      total: repriced.total,
    })
    assert(
      !sameMoney(repriced.total, quotedToCustomer),
      'price move did not change the computed total -- the probe would prove nothing',
    )

    // What the CUSTOMER's confirmation screen renders for this request, read through the real
    // guest query (not recomputed here). Closing the loop on this number is the whole point:
    // "what the customer was shown" and "what the order row records" must be one figure.
    const { fetchGuestOrderById } = await import('../lib/guest-orders/queries')
    const guestView = await fetchGuestOrderById(requestId, {
      tableNumber: TABLE_NUMBER,
      sessionId,
      restaurantId: RESTAURANT_ID,
    })
    log('what the customer is shown pre-Accept', {
      denied: guestView.denied,
      subtotal: guestView.order?.subtotal,
      tax: guestView.order?.tax,
      total: guestView.order?.total,
    })
    assert(guestView.order, 'guest view of the request must be readable')
    assert(
      sameMoney(guestView.order.total, quotedToCustomer),
      `guest-facing total ${guestView.order.total} != reviewed total ${quotedToCustomer}`,
    )
    const shownToCustomer = Number(guestView.order.total)

    // ---- Accept ------------------------------------------------------------------------
    const acceptRes = await acceptPOST(
      new Request(`https://probe.local/api/order-requests/${requestId}/accept`, {
        method: 'POST',
        headers: staffHeaders,
        body: '{}',
      }),
      { params: Promise.resolve({ requestId }) },
    )
    const acceptBody = await readJson(acceptRes)
    log('POST .../accept', { status: acceptRes.status, body: acceptBody })
    assert(acceptRes.status === 200, `accept failed: ${JSON.stringify(acceptBody)}`)
    const orderId = String(acceptBody.orderId)
    orderIds.push(orderId)

    // ---- the assertion that matters: the PERSISTED row ---------------------------------
    const { data: orderRow, error: orderErr } = await admin
      .from('orders')
      .select('id, subtotal, tax, total, items, order_number, payment_status, channel, table_number')
      .eq('id', orderId)
      .single()
    assert(!orderErr && orderRow, `orders read failed: ${orderErr?.message}`)
    log('PERSISTED orders row', {
      subtotal: orderRow.subtotal,
      tax: orderRow.tax,
      total: orderRow.total,
      items: orderRow.items,
    })

    assert(
      sameMoney(orderRow.total, quotedToCustomer),
      `RECORDED TOTAL DRIFTED: quoted ${quotedToCustomer}, orders.total ${orderRow.total}`,
    )
    assert(
      sameMoney(orderRow.total, shownToCustomer),
      `RECORDED TOTAL != WHAT THE CUSTOMER WAS SHOWN: shown ${shownToCustomer}, recorded ${orderRow.total}`,
    )
    assert(
      !sameMoney(orderRow.total, repriced.total),
      `orders.total equals the ACCEPT-TIME re-price (${repriced.total}) -- #125 has regressed`,
    )
    assert(
      sameMoney(orderRow.subtotal, reviewedRow.subtotal_reviewed),
      `subtotal drifted: ${orderRow.subtotal} vs reviewed ${reviewedRow.subtotal_reviewed}`,
    )
    assert(
      sameMoney(orderRow.tax, reviewedRow.tax_reviewed),
      `tax drifted: ${orderRow.tax} vs reviewed ${reviewedRow.tax_reviewed}`,
    )

    const persistedItems = Array.isArray(orderRow.items) ? orderRow.items : []
    assert(persistedItems.length === 1, `expected 1 line item, got ${persistedItems.length}`)
    assert(
      Number(persistedItems[0].quantity) === REVIEWED_QUANTITY,
      `line quantity must be the REVIEWED one (${REVIEWED_QUANTITY}), got ${persistedItems[0].quantity}`,
    )
    assert(
      sameMoney(persistedItems[0].unitPrice, QUOTED_UNIT_PRICE),
      `line unitPrice must be the reviewed ${QUOTED_UNIT_PRICE}, got ${persistedItems[0].unitPrice}`,
    )
    assert(
      'route_to' in persistedItems[0],
      'line items must carry the route_to enrichment Accept adds',
    )

    const { data: finalRequest } = await admin
      .from('order_requests')
      .select('status, accepted_order_id, decided_by, subtotal, tax, total, total_reviewed')
      .eq('id', requestId)
      .single()
    log('order_request after accept', finalRequest)
    // The audit trail of what the customer actually submitted must survive Accept untouched.
    assert(
      sameMoney(finalRequest.total, QUOTED_UNIT_PRICE * QUOTED_QUANTITY),
      `Accept mutated the original submission total: ${finalRequest.total}`,
    )
    assert(
      sameMoney(finalRequest.total_reviewed, quotedToCustomer),
      `Accept mutated the reviewed total: ${finalRequest.total_reviewed}`,
    )
    assert(finalRequest.status === 'accepted', 'request must end accepted')
    assert(String(finalRequest.accepted_order_id) === orderId, 'accepted_order_id must match')
    assert(String(finalRequest.decided_by) === String(userId), 'decided_by must be the staff user')

    // Idempotent re-Accept: same order, no second row.
    const reacceptRes = await acceptPOST(
      new Request(`https://probe.local/api/order-requests/${requestId}/accept`, {
        method: 'POST',
        headers: staffHeaders,
        body: '{}',
      }),
      { params: Promise.resolve({ requestId }) },
    )
    const reacceptBody = await readJson(reacceptRes)
    log('POST .../accept (retry)', { status: reacceptRes.status, body: reacceptBody })
    assert(reacceptRes.status === 200, 'retried accept must be idempotent 200')
    assert(String(reacceptBody.orderId) === orderId, 'retried accept must return the same orderId')

    const { count: orderCount } = await admin
      .from('orders')
      .select('id', { count: 'exact', head: true })
      .eq('idempotency_key', `order-request-accept:${requestId}`)
    assert(
      (orderCount ?? 0) <= 1,
      `retried accept created a second orders row (${orderCount})`,
    )

    // =====================================================================================
    // SCENARIO 2 — no review was ever saved: the SUBMISSION figures must be what is recorded.
    // The catalog is still sitting at the moved price for the whole of this scenario.
    // =====================================================================================
    log('SCENARIO 2: unreviewed request accepted while the catalog sits at the moved price')

    // Quote it back at the ORIGINAL price, then move the catalog again, so the submission
    // figures and the catalog disagree at Accept time exactly as in scenario 1.
    await admin.from('menu_items').update({ base_price: QUOTED_UNIT_PRICE }).eq('id', menuItemId)

    const sessionId2 = `sess_${tag}_2`
    const quote2Res = await ordersPOST(
      new Request('https://probe.local/api/orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          restaurantId: RESTAURANT_ID,
          tableNumber: TABLE_NUMBER,
          channel: 'table',
          sessionId: sessionId2,
          customerName: 'Accept Seam Probe 2',
          paymentMethod: 'card',
          items: [{ menuItemId, name: `${tag} probe item`, quantity: QUOTED_QUANTITY }],
        }),
      }),
    )
    const quote2Body = await readJson(quote2Res)
    assert(quote2Res.status === 200, `quote 2 failed: ${JSON.stringify(quote2Body)}`)
    const requestId2 = String(quote2Body.requestId)
    requestIds.push(requestId2)

    const { data: quoted2 } = await admin
      .from('order_requests')
      .select('subtotal, tax, total, total_reviewed')
      .eq('id', requestId2)
      .single()
    assert(quoted2.total_reviewed == null, 'scenario 2 must have no review saved')
    const submittedTotal = Number(quoted2.total)
    log('order_request 2 as submitted', quoted2)

    await admin.from('menu_items').update({ base_price: MOVED_UNIT_PRICE }).eq('id', menuItemId)
    const repriced2 = await calculateOrderPricing(admin, RESTAURANT_ID, [
      { menuItemId, quantity: QUOTED_QUANTITY },
    ])
    assert(
      !sameMoney(repriced2.total, submittedTotal),
      'scenario 2 counterfactual is not distinguishable',
    )

    const accept2Res = await acceptPOST(
      new Request(`https://probe.local/api/order-requests/${requestId2}/accept`, {
        method: 'POST',
        headers: staffHeaders,
        body: '{}',
      }),
      { params: Promise.resolve({ requestId: requestId2 }) },
    )
    const accept2Body = await readJson(accept2Res)
    log('POST .../accept (scenario 2)', { status: accept2Res.status, body: accept2Body })
    assert(accept2Res.status === 200, `accept 2 failed: ${JSON.stringify(accept2Body)}`)
    const orderId2 = String(accept2Body.orderId)
    orderIds.push(orderId2)

    const { data: orderRow2 } = await admin
      .from('orders')
      .select('subtotal, tax, total, items')
      .eq('id', orderId2)
      .single()
    log('PERSISTED orders row (scenario 2)', {
      subtotal: orderRow2.subtotal,
      tax: orderRow2.tax,
      total: orderRow2.total,
    })
    assert(
      sameMoney(orderRow2.total, submittedTotal),
      `unreviewed accept drifted: submitted ${submittedTotal}, recorded ${orderRow2.total}`,
    )
    assert(
      !sameMoney(orderRow2.total, repriced2.total),
      `unreviewed accept recorded the accept-time re-price (${repriced2.total})`,
    )
    assert(
      sameMoney(orderRow2.tax, quoted2.tax),
      `unreviewed accept tax drifted: ${orderRow2.tax} vs ${quoted2.tax}`,
    )

    // =====================================================================================
    // SCENARIO 3 — Decline, and the terminal-status guard on Accept.
    // =====================================================================================
    log('SCENARIO 3: decline, then Accept must refuse')
    const { POST: declinePOST } = await import(
      '../app/api/order-requests/[requestId]/decline/route'
    )

    const sessionId3 = `sess_${tag}_3`
    const quote3Res = await ordersPOST(
      new Request('https://probe.local/api/orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          restaurantId: RESTAURANT_ID,
          tableNumber: TABLE_NUMBER,
          channel: 'table',
          sessionId: sessionId3,
          paymentMethod: 'card',
          items: [{ menuItemId, name: `${tag} probe item`, quantity: 1 }],
        }),
      }),
    )
    const quote3Body = await readJson(quote3Res)
    assert(quote3Res.status === 200, `quote 3 failed: ${JSON.stringify(quote3Body)}`)
    const requestId3 = String(quote3Body.requestId)
    requestIds.push(requestId3)

    const declineRes = await declinePOST(
      new Request(`https://probe.local/api/order-requests/${requestId3}/decline`, {
        method: 'POST',
        headers: staffHeaders,
        body: JSON.stringify({ reason: 'probe' }),
      }),
      { params: Promise.resolve({ requestId: requestId3 }) },
    )
    assert(declineRes.status === 200, `decline failed: ${JSON.stringify(await readJson(declineRes))}`)

    const accept3Res = await acceptPOST(
      new Request(`https://probe.local/api/order-requests/${requestId3}/accept`, {
        method: 'POST',
        headers: staffHeaders,
        body: '{}',
      }),
      { params: Promise.resolve({ requestId: requestId3 }) },
    )
    const accept3Body = await readJson(accept3Res)
    log('accept after decline', { status: accept3Res.status, body: accept3Body })
    assert(accept3Res.status === 409, `accept after decline must be 409, got ${accept3Res.status}`)

    const { count: strayOrders } = await admin
      .from('orders')
      .select('id', { count: 'exact', head: true })
      .eq('idempotency_key', `order-request-accept:${requestId3}`)
    assert((strayOrders ?? 0) === 0, 'a declined request must never produce an orders row')

    // =====================================================================================
    // SCENARIO 4 — unauthenticated Accept creates nothing.
    // =====================================================================================
    log('SCENARIO 4: Accept without a staff token')
    const sessionId4 = `sess_${tag}_4`
    const quote4Res = await ordersPOST(
      new Request('https://probe.local/api/orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          restaurantId: RESTAURANT_ID,
          tableNumber: TABLE_NUMBER,
          channel: 'table',
          sessionId: sessionId4,
          paymentMethod: 'card',
          items: [{ menuItemId, name: `${tag} probe item`, quantity: 1 }],
        }),
      }),
    )
    const quote4Body = await readJson(quote4Res)
    assert(quote4Res.status === 200, `quote 4 failed: ${JSON.stringify(quote4Body)}`)
    const requestId4 = String(quote4Body.requestId)
    requestIds.push(requestId4)

    // OBSERVED, and it is not what the code reads as: requireStaffPermission is written to
    // return a 401 NextResponse (require-staff-permission.ts:56-58), but on the Bearer path
    // getUserFromRequest THROWS for an invalid or expired token
    // (lib/supabase/admin-restaurant-auth.ts:41-43) and nothing between it and the route
    // catches. The handler therefore rejects rather than returning 401, and Next renders that
    // as an opaque 500. Staff whose session expired get "something went wrong", not "sign in
    // again". Pinned here as the CURRENT behaviour, not endorsed -- see the handoff.
    let accept4Status: number | 'threw' = 'threw'
    let accept4Detail: unknown = null
    try {
      const accept4Res = await acceptPOST(
        new Request(`https://probe.local/api/order-requests/${requestId4}/accept`, {
          method: 'POST',
          headers: { Authorization: 'Bearer not-a-real-token', 'Content-Type': 'application/json' },
          body: '{}',
        }),
        { params: Promise.resolve({ requestId: requestId4 }) },
      )
      accept4Status = accept4Res.status
      accept4Detail = await readJson(accept4Res)
    } catch (err) {
      accept4Detail = err instanceof Error ? err.message : String(err)
    }
    log('accept with an invalid staff token', { status: accept4Status, detail: accept4Detail })
    assert(
      accept4Status === 401 || accept4Status === 403 || accept4Status === 'threw',
      `invalid-token accept must be refused, got ${accept4Status}`,
    )

    const { data: untouched } = await admin
      .from('order_requests')
      .select('status')
      .eq('id', requestId4)
      .single()
    assert(
      untouched.status === 'waiting_review',
      `refused accept must leave the request in waiting_review, got ${untouched.status}`,
    )
    const { count: strayOrders4 } = await admin
      .from('orders')
      .select('id', { count: 'exact', head: true })
      .eq('idempotency_key', `order-request-accept:${requestId4}`)
    assert((strayOrders4 ?? 0) === 0, 'a refused accept must never produce an orders row')

    // =====================================================================================
    // SCENARIO 5 — hosted checkout when the gateway cannot be reached.
    //
    // READ THIS BEFORE TRUSTING IT. It does NOT verify a successful Finatic checkout. The
    // staging Finatic stub (lib/payments/staging-finatic-stub.ts) only stubs
    // queryFinaticOrderPaid; there is no stub for createPaymentRequest, which is what
    // accept/route.ts:224 calls. And .env.test carries no PAYCLOUD_* vars at all, so
    // getPaycloudConfig throws on PAYCLOUD_ENDPOINT. What this scenario therefore drives is
    // the GATEWAY-UNAVAILABLE path, and what it proves is the claim the code only asserts in
    // a comment (accept/route.ts:215-218): a failed checkout init is best-effort and must
    // still leave a correct, accepted order at the quoted total rather than stranding it.
    // =====================================================================================
    log('SCENARIO 5: hosted checkout with no reachable gateway')
    await admin.from('menu_items').update({ base_price: QUOTED_UNIT_PRICE }).eq('id', menuItemId)

    const sessionId5 = `sess_${tag}_5`
    const quote5Res = await ordersPOST(
      new Request('https://probe.local/api/orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          restaurantId: RESTAURANT_ID,
          tableNumber: TABLE_NUMBER,
          channel: 'table',
          sessionId: sessionId5,
          customerName: 'Accept Seam Probe 5',
          paymentMethod: 'card',
          paymentChannel: 'hosted',
          items: [{ menuItemId, name: `${tag} probe item`, quantity: 1 }],
        }),
      }),
    )
    const quote5Body = await readJson(quote5Res)
    assert(quote5Res.status === 200, `quote 5 failed: ${JSON.stringify(quote5Body)}`)
    const requestId5 = String(quote5Body.requestId)
    requestIds.push(requestId5)

    const { data: quoted5 } = await admin
      .from('order_requests')
      .select('total, payment_channel')
      .eq('id', requestId5)
      .single()
    assert(quoted5.payment_channel === 'hosted', 'scenario 5 must be on the hosted channel')

    const accept5Res = await acceptPOST(
      new Request(`https://probe.local/api/order-requests/${requestId5}/accept`, {
        method: 'POST',
        headers: staffHeaders,
        body: '{}',
      }),
      { params: Promise.resolve({ requestId: requestId5 }) },
    )
    const accept5Body = await readJson(accept5Res)
    log('accept on hosted channel', { status: accept5Res.status, body: accept5Body })
    assert(accept5Res.status === 200, 'a failed checkout init must not fail the Accept')
    orderIds.push(String(accept5Body.orderId))
    assert(
      accept5Body.checkoutUrl == null,
      'no gateway is configured here, so checkoutUrl must be null -- if it is set, this scenario reached a REAL Finatic and the probe must be changed',
    )

    const { data: order5 } = await admin
      .from('orders')
      .select('total, payment_status, payment_checkout_url')
      .eq('id', String(accept5Body.orderId))
      .single()
    log('PERSISTED orders row (scenario 5)', order5)
    assert(
      sameMoney(order5.total, quoted5.total),
      `hosted accept drifted: quoted ${quoted5.total}, recorded ${order5.total}`,
    )
    assert(order5.payment_status === 'pending', 'an unpaid hosted order must be pending')

    const { data: request5After } = await admin
      .from('order_requests')
      .select('status')
      .eq('id', requestId5)
      .single()
    assert(
      request5After.status === 'accepted',
      `a failed checkout init must not strand the request (status=${request5After.status})`,
    )

    // =====================================================================================
    // SCENARIO 6 — kiosk channel: the daily counter branch (accept/route.ts:171-182).
    // The counter itself is restaurant-wide shared state that other agents' runs also move,
    // so this asserts only that it is a positive integer written to the row -- never a
    // specific value.
    // =====================================================================================
    log('SCENARIO 6: kiosk channel')
    const { data: kioskTable } = await admin
      .from('restaurant_tables')
      .select('table_number')
      .eq('restaurant_id', RESTAURANT_ID)
      .eq('is_kiosk', true)
      .eq('active', true)
      .limit(1)
      .maybeSingle()

    if (!kioskTable?.table_number) {
      log('SKIPPED: staging has no active kiosk table')
    } else {
      const sessionId6 = `sess_${tag}_6`
      const quote6Res = await ordersPOST(
        new Request('https://probe.local/api/orders', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            restaurantId: RESTAURANT_ID,
            tableNumber: kioskTable.table_number,
            channel: 'kiosk',
            sessionId: sessionId6,
            customerName: 'Accept Seam Probe 6',
            paymentMethod: 'card',
            items: [{ menuItemId, name: `${tag} probe item`, quantity: 2 }],
          }),
        }),
      )
      const quote6Body = await readJson(quote6Res)
      assert(quote6Res.status === 200, `kiosk quote failed: ${JSON.stringify(quote6Body)}`)
      const requestId6 = String(quote6Body.requestId)
      requestIds.push(requestId6)

      const { data: quoted6 } = await admin
        .from('order_requests')
        .select('total')
        .eq('id', requestId6)
        .single()

      await admin.from('menu_items').update({ base_price: MOVED_UNIT_PRICE }).eq('id', menuItemId)

      const accept6Res = await acceptPOST(
        new Request(`https://probe.local/api/order-requests/${requestId6}/accept`, {
          method: 'POST',
          headers: staffHeaders,
          body: '{}',
        }),
        { params: Promise.resolve({ requestId: requestId6 }) },
      )
      const accept6Body = await readJson(accept6Res)
      log('accept on kiosk channel', { status: accept6Res.status, body: accept6Body })
      assert(accept6Res.status === 200, `kiosk accept failed: ${JSON.stringify(accept6Body)}`)
      orderIds.push(String(accept6Body.orderId))

      const { data: order6 } = await admin
        .from('orders')
        .select('total, channel, kiosk_order_number')
        .eq('id', String(accept6Body.orderId))
        .single()
      log('PERSISTED orders row (scenario 6)', order6)
      assert(
        sameMoney(order6.total, quoted6.total),
        `kiosk accept drifted: quoted ${quoted6.total}, recorded ${order6.total}`,
      )
      assert(order6.channel === 'kiosk', 'kiosk order must record channel=kiosk')
      assert(
        Number.isInteger(Number(order6.kiosk_order_number)) &&
          Number(order6.kiosk_order_number) > 0,
        `kiosk_order_number must be a positive integer, got ${order6.kiosk_order_number}`,
      )
      assert(
        accept6Body.kioskOrderLabel === `K-${String(order6.kiosk_order_number).padStart(3, '0')}`,
        `kioskOrderLabel must match the persisted number, got ${accept6Body.kioskOrderLabel}`,
      )
      await admin.from('menu_items').update({ base_price: QUOTED_UNIT_PRICE }).eq('id', menuItemId)
    }

    // =====================================================================================
    // SCENARIO 7 — two Accepts at once, against real Postgres.
    //
    // The claim (accept/route.ts:64-82) is a conditional UPDATE ... WHERE status =
    // 'waiting_review'. Its correctness is a property of the DATABASE, which is precisely what
    // a mocked client cannot express: the existing jest suite's stub returns the same row to
    // every caller, so both would "win". scripts/probe-order-request-accept-race-staging.ts
    // covers this over HTTP against the DEPLOYED worker; this covers this branch's code.
    // =====================================================================================
    log('SCENARIO 7: concurrent Accept')
    const sessionId7 = `sess_${tag}_7`
    const quote7Res = await ordersPOST(
      new Request('https://probe.local/api/orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          restaurantId: RESTAURANT_ID,
          tableNumber: TABLE_NUMBER,
          channel: 'table',
          sessionId: sessionId7,
          customerName: 'Accept Seam Probe 7',
          paymentMethod: 'card',
          items: [{ menuItemId, name: `${tag} probe item`, quantity: 1 }],
        }),
      }),
    )
    const quote7Body = await readJson(quote7Res)
    assert(quote7Res.status === 200, `quote 7 failed: ${JSON.stringify(quote7Body)}`)
    const requestId7 = String(quote7Body.requestId)
    requestIds.push(requestId7)

    const makeAccept = () =>
      acceptPOST(
        new Request(`https://probe.local/api/order-requests/${requestId7}/accept`, {
          method: 'POST',
          headers: staffHeaders,
          body: '{}',
        }),
        { params: Promise.resolve({ requestId: requestId7 }) },
      )
    const [res7a, res7b] = await Promise.all([makeAccept(), makeAccept()])
    const [body7a, body7b] = await Promise.all([readJson(res7a), readJson(res7b)])
    log('concurrent accepts', {
      a: { status: res7a.status, body: body7a },
      b: { status: res7b.status, body: body7b },
    })
    for (const b of [body7a, body7b]) {
      if (b?.orderId) orderIds.push(String(b.orderId))
    }

    const statuses = [res7a.status, res7b.status].sort((x, y) => x - y)
    assert(
      statuses[0] === 200 && statuses[1] === 409,
      `expected one 200 and one 409, got ${res7a.status}/${res7b.status}`,
    )
    const loser7 = res7a.status === 409 ? body7a : body7b
    assert(!loser7.orderId, 'the losing Accept must not return an orderId')

    const { data: orders7 } = await admin
      .from('orders')
      .select('id')
      .eq('idempotency_key', `order-request-accept:${requestId7}`)
    assert(
      (orders7 || []).length === 1,
      `concurrent Accept created ${(orders7 || []).length} orders rows, expected exactly 1`,
    )

    console.log('PROBE_ACCEPT_SEAM_PRICING_OK')
  } finally {
    log('cleanup')
    // Restore the catalog price before anything else -- the menu item is deleted below, but if
    // that ever fails the shared restaurant must not be left holding a 999 price.
    if (menuItemId) {
      await admin
        .from('menu_items')
        .update({ base_price: QUOTED_UNIT_PRICE })
        .eq('id', menuItemId)
    }
    // order_requests.accepted_order_id FKs orders(id), so requests go first.
    if (requestIds.length) {
      const { error } = await admin.from('order_requests').delete().in('id', requestIds)
      if (error) console.error('cleanup order_requests:', error.message)
    }
    if (orderIds.length) {
      const { error } = await admin.from('orders').delete().in('id', [...new Set(orderIds)])
      if (error) console.error('cleanup orders:', error.message)
    }
    if (createdTabId) {
      const { error } = await admin.from('tabs').delete().eq('id', createdTabId)
      if (error) console.error('cleanup tabs:', error.message)
    }
    if (menuItemId) {
      const { error } = await admin.from('menu_items').delete().eq('id', menuItemId)
      if (error) console.error('cleanup menu_items:', error.message)
    }
    if (userId) {
      await admin.from('restaurant_users').delete().eq('user_id', userId)
      await admin.from('users').delete().eq('id', userId)
      const { error } = await admin.auth.admin.deleteUser(userId)
      if (error) console.error('cleanup auth user:', error.message)
    }
    log('cleanup done', { requestIds, orderIds, menuItemId, userId, createdTabId })
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
