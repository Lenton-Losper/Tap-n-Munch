import { NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { resolveOrderRestaurantScope } from '@/lib/supabase/restaurants'
import { requireTerminalAuth, validateTerminalRecord } from '@/lib/terminal-auth'
import { createOrder } from '@/lib/orders/create-order'
import { UnmatchedMenuItemError } from '@/lib/orders/calculate-order-pricing'
import { requestDeclaresVariantProtocol } from '@/lib/orders/variant-protocol'
import { enrichOrderItemsWithRouteTo } from '@/lib/order-routing'
import { getPaymentProjections } from '@/lib/payments/get-payment-projection'
import { autoCancelStalePosOrders } from '@/lib/orders/auto-cancel-stale-pos-orders'
import { checkStockSufficiency } from '@/lib/orders/check-stock-sufficiency'
import { fetchAllRows } from '@/lib/supabase/fetch-all-rows'
import {
  financialsWire,
  projectOrderRows,
  type FinancialOrderInput,
  type FinancialsWire,
} from '@/lib/orders/order-financials'
import {
  findOrderByIdempotencyKey,
  idempotencyMismatchBody,
  isSameRound,
} from '@/lib/orders/round-idempotency'

export const dynamic = 'force-dynamic'

/** Orders per projection read. Keeps each `.in('order_id', ...)` URL well under PostgREST's limit. */
const FINANCIALS_BATCH = 200

/**
 * WHAT EACH LISTED ORDER IS WORTH NOW (Sprint 2026-09-29, F-TERMPAY task 8).
 *
 * The terminal's order card showed `orders.total`, the stored ORIGINAL, which amend_order_lines
 * never rewrites -- so an order with voided lines was listed at a figure nobody owes, on the card a
 * waiter taps to reach Process Payment. Each order now carries the C1 projection (the same wire
 * shape as the lines route's per-order `financials`), and the card shows live/outstanding.
 *
 * BATCHED: a constant number of reads per FINANCIALS_BATCH orders (lines + the item ledger), never
 * one per order. FAIL-SOFT, because this route only DISPLAYS: a batch whose reads fail simply has no
 * `financials` on its orders, and the terminal then labels the stored total as what was ordered
 * rather than what is owed. The list itself must not fail because a figure could not be read -- and
 * the charge path never reads these (PaymentScreen resolves the live amount itself).
 */
async function financialsByOrder(
  supabase: ReturnType<typeof createServerSupabaseClient>,
  rows: Record<string, unknown>[],
): Promise<Map<string, FinancialsWire>> {
  const out = new Map<string, FinancialsWire>()
  for (let i = 0; i < rows.length; i += FINANCIALS_BATCH) {
    const batch = rows.slice(i, i + FINANCIALS_BATCH) as unknown as FinancialOrderInput[]
    try {
      const projected = await projectOrderRows(supabase, batch)
      for (const [id, f] of projected) out.set(id, financialsWire(f))
    } catch (e) {
      console.error('[terminal/orders] financials unreadable; listing without them', {
        batchStart: i,
        batchSize: batch.length,
        error: e instanceof Error ? e.message : String(e),
      })
    }
  }
  return out
}

/** The statuses the terminal lists. The single-order read uses the same set, so it can never
 *  return an order the list would not have offered. */
const LIVE_ORDER_STATUSES = ['pending', 'confirmed', 'preparing', 'ready', 'completed']

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Order rows as the terminal receives them: the stored row plus its payment and money figures. */
async function enrichOrders(
  supabase: ReturnType<typeof createServerSupabaseClient>,
  restaurantId: string,
  data: Record<string, unknown>[],
) {
  const orderIds = data.map((o: any) => String(o.id)).filter(Boolean)
  const projections = await getPaymentProjections(supabase, restaurantId, orderIds)
  const financials = await financialsByOrder(supabase, data)

  return data.map((order: any) => {
    const projection = projections.get(String(order.id)) ?? null
    const money = financials.get(String(order.id))
    return {
      ...order,
      // Distinct from orders.payment_status (paid/pending settlement flag).
      payment_status_derived: projection?.paymentStatus ?? null,
      refunded_amount: projection?.refundedAmount ?? 0,
      // Additive, and ABSENT (not zero) when it could not be read. See financialsByOrder.
      ...(money ? { financials: money } : {}),
    }
  })
}

export async function GET(req: Request) {
  try {
    const terminal = await requireTerminalAuth(req)
    const supabase = createServerSupabaseClient()
    await validateTerminalRecord(supabase, terminal)

    if (!terminal.permissions.includes('orders:read')) {
      return NextResponse.json(
        { error: 'Missing permission: orders:read' },
        { status: 403 }
      )
    }

    /**
     * SINGLE-ORDER READ (?orderId=). The Payment and Order Detail screens need one order; before
     * this they pulled the whole live list -- 4,675 rows at FNB ChowNow on 2026-09-30 -- and picked
     * one out on the device, while this route paginated, projected and computed financials for every
     * row. Production logs that morning: p90 >= 13 s.
     *
     * Same auth, record check and permission gate as the list, above. The query keeps the list's
     * restaurant scope and live-status set and ADDS the id, so it can only narrow what this terminal
     * could already see: another venue's order, or one outside the live set, is simply not found --
     * `{ orders: [] }`, the same envelope the list gives, which the terminal already reads as
     * "Order not found". Nothing distinguishes "exists elsewhere" from "does not exist".
     *
     * NO STALE-ORDER SWEEP HERE. autoCancelStalePosOrders is restaurant-wide and unrelated to the
     * order being read; it still runs on every list poll below and on the two-minute cron, so its
     * cadence is unchanged. Running it here only put a restaurant-wide scan in front of one row.
     */
    const url = new URL(req.url)
    if (url.searchParams.has('orderId')) {
      const orderId = (url.searchParams.get('orderId') ?? '').trim()
      if (!UUID_RE.test(orderId)) {
        return NextResponse.json(
          { error: 'orderId must be a UUID', code: 'INVALID_ORDER_ID' },
          { status: 400 },
        )
      }

      const { data: row, error } = await supabase
        .from('orders')
        .select('*')
        .eq('restaurant_id', terminal.restaurantId)
        .eq('id', orderId)
        .in('status', LIVE_ORDER_STATUSES)
        .maybeSingle()
      if (error) throw new Error(`terminal-order: ${error.message}`)
      if (!row) return NextResponse.json({ orders: [] })

      const orders = await enrichOrders(supabase, terminal.restaurantId, [row as Record<string, unknown>])
      return NextResponse.json({ orders })
    }

    // Lazy cleanup, same pattern as recomputeInvoiceStatus's lazy overdue check: no scheduled
    // job needed for the terminal's own polling to self-heal abandoned Sale-tab orders, since
    // this route is what the terminal calls to list its own orders in the first place.
    // verifyWithFinatic is deliberately false here: this route is polled frequently and must
    // stay fast/independent of Finatic's uptime. Only orders that never got a
    // paycloud_merchant_order_no (no payment attempt reached Finatic) are cancelled inline;
    // anything mid-flight is resolved by the Finatic-verified cron instead (up to ~2min extra).
    await autoCancelStalePosOrders(supabase, { restaurantId: terminal.restaurantId, verifyWithFinatic: false })

    // #323: every live order for the restaurant, no date bound -- 739 for FNB ChowNow today.
    // fetchAllRows throws on failure; the enclosing try/catch already answers with JSON.
    const data = await fetchAllRows<Record<string, unknown>>(
      supabase
        .from('orders')
        .select('*')
        .eq('restaurant_id', terminal.restaurantId)
        .in('status', LIVE_ORDER_STATUSES)
        .order('placed_at', { ascending: false }),
      { label: 'terminal-orders' },
    )

    const enriched = await enrichOrders(supabase, terminal.restaurantId, data ?? [])

    return NextResponse.json({ orders: enriched })
  } catch (err: unknown) {
    if (err instanceof Response) return err
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
}

export async function POST(request: Request) {
  try {
    const terminal = await requireTerminalAuth(request)
    const supabase = createServerSupabaseClient()
    await validateTerminalRecord(supabase, terminal)

    if (!terminal.permissions.includes('orders:update')) {
      return NextResponse.json({ error: 'Missing permission' }, { status: 403 })
    }

    const body = await request.json()
    const { restaurantId, items, subtotal, total, orderInstructions } = body

    if (!restaurantId) {
      return NextResponse.json({ error: 'restaurantId is required' }, { status: 400 })
    }
    if (String(restaurantId).trim() !== terminal.restaurantId) {
      return NextResponse.json(
        { error: 'restaurantId does not match terminal' },
        { status: 403 }
      )
    }
    if (!Array.isArray(items) || items.length === 0) {
      return NextResponse.json({ error: 'items are required' }, { status: 400 })
    }
    if (!total || total <= 0) {
      return NextResponse.json({ error: 'total must be greater than 0' }, { status: 400 })
    }

    // Same out-of-stock rule as the customer channel: a TRACKED item whose ingredient stock
    // is at zero or below cannot be sold. Untracked items are skipped and behave as before.
    // Staff see the refusal on the terminal at the moment they ring it up, which is the only
    // point where it can still be acted on.
    try {
      const sufficiency = await checkStockSufficiency(supabase, terminal.restaurantId, items)
      if (!sufficiency.ok) {
        return NextResponse.json(
          {
            error: sufficiency.reason,
            outOfStock: sufficiency.unavailable.map((u) => ({
              item: u.itemName,
              ingredient: u.stockItemName,
            })),
          },
          { status: 409 },
        )
      }
    } catch (err) {
      // Never let a failed balance READ stop the till from taking orders.
      console.error('[TERMINAL ORDERS] stock sufficiency check failed, allowing order:', err)
    }

    const orderRestaurantScope = await resolveOrderRestaurantScope(terminal.restaurantId)

    const enrichedItems = await enrichOrderItemsWithRouteTo(supabase, items)
    const variantProtocol = requestDeclaresVariantProtocol(request)

    const result = await createOrder({
      restaurantId: orderRestaurantScope.restaurantId,
      firebaseRestaurantId: orderRestaurantScope.firebaseRestaurantId,
      tableNumber: 0,
      tableId: null,
      sessionId: null,
      memberSessionId: null,
      items: enrichedItems,
      subtotal: Number(subtotal) || 0,
      total: Number(total),
      paymentMethod: 'card',
      paymentChannel: 'card_manual',
      paymentStatus: 'pending',
      orderInstructions: orderInstructions || null,
      tabId: null,
      tabSettlementForTabId: null,
      channel: 'pos',
      customerName: null,
      idempotencyKey: request.headers.get('x-idempotency-key') || null,
      isClosed: true,
      // C6: strict only for a build that declares the variant protocol; older P5s are priced as
      // before and the gap is logged. See lib/orders/variant-protocol.ts.
      requireCompleteVariantSelection: variantProtocol,
      auditMissingRequiredVariants: !variantProtocol,
    })

    /**
     * C4, the same rule as POST /api/terminal/rounds. A key this venue already used returns the
     * ORIGINAL order from createOrder; a retry whose basket was edited in between would then be
     * charged at the original total. Only an identical body is a replay.
     */
    if (result.duplicate) {
      const idempotencyKey = String(request.headers.get('x-idempotency-key') ?? '')
      const stored = await findOrderByIdempotencyKey(supabase, terminal.restaurantId, idempotencyKey)
      if (stored && !isSameRound(stored, { items })) {
        return NextResponse.json(idempotencyMismatchBody(stored), { status: 409 })
      }
    }

    return NextResponse.json({
      success: true,
      orderId: result.orderId,
      orderNumber: result.orderNumber,
      duplicate: result.duplicate,
    })
  } catch (err: unknown) {
    if (err instanceof Response) return err
    // C5: a pricing refusal is the waiter's to fix, not a server fault -- 400 with the code and
    // the offending lines, the same body /api/orders returns. A 500 here read as "try again".
    if (err instanceof UnmatchedMenuItemError) {
      return NextResponse.json(
        { error: err.message, code: err.code, unavailableItems: err.items },
        { status: 400 },
      )
    }
    const message = err instanceof Error ? err.message : 'Internal server error'
    console.error('[TERMINAL/ORDERS POST]', message)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
