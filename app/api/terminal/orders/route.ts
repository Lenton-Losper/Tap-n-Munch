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
import { fetchAllRowsConcurrently } from '@/lib/supabase/fetch-all-rows'
import { mapWithConcurrency } from '@/lib/util/map-with-concurrency'
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
 * How many financials batches / payment-projection chunks are in flight at once on the list path
 * (perf/latency-sprint 2026-10-01). CHOSEN BY MEASUREMENT, not by reasoning: both compete for the
 * worker's six simultaneous connections, and __tests__/terminal-orders-list-latency.test.ts at FNB
 * scale (4,675 orders, 133 calls) measured sequential depth for projection x financials of
 * 1x1 51, 1x2 34, 2x2 28, 3x3 26, 3x4 25, 6x2 32, 6x4 26. The floor is ~26 (133 calls / 6, plus
 * auth, sweep and page 0). Re-measure before changing either number.
 */
const FINANCIALS_FANOUT = 4
const PROJECTION_FANOUT = 3

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
  const starts: number[] = []
  for (let i = 0; i < rows.length; i += FINANCIALS_BATCH) starts.push(i)
  // perf/latency-sprint 2026-10-01: the batches are independent, so they are read FINANCIALS_FANOUT
  // at a time rather than one ~200 ms round trip after another (24 in a row at FNB's 4,675 orders).
  // Fail-soft stays PER BATCH, and results are applied in batch order.
  const perBatch = await mapWithConcurrency(
    starts,
    async (i) => {
      const batch = rows.slice(i, i + FINANCIALS_BATCH) as unknown as FinancialOrderInput[]
      try {
        return await projectOrderRows(supabase, batch)
      } catch (e) {
        console.error('[terminal/orders] financials unreadable; listing without them', {
          batchStart: i,
          batchSize: batch.length,
          error: e instanceof Error ? e.message : String(e),
        })
        return null
      }
    },
    FINANCIALS_FANOUT,
  )
  for (const projected of perBatch) {
    if (!projected) continue
    for (const [id, f] of projected) out.set(id, financialsWire(f))
  }
  return out
}

/** The statuses the terminal lists. The single-order read uses the same set, so it can never
 *  return an order the list would not have offered. */
const LIVE_ORDER_STATUSES = ['pending', 'confirmed', 'preparing', 'ready', 'completed']

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** ?scope=active: what the terminal's New / Preparing / Ready tabs show. */
const ACTIVE_ORDER_STATUSES = ['pending', 'confirmed', 'preparing', 'ready']
const COMPLETED_PAGE_DEFAULT = 50
const COMPLETED_PAGE_MAX = 200
/** A timestamptz as PostgREST writes it back, e.g. 2026-09-30T12:01:02.123456+00:00. */
const TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$/

/** The completed-history cursor: the last row's placed_at and id, `<placed_at>~<id>`. */
function parseCursor(raw: string): { placedAt: string; id: string } | null {
  const sep = raw.lastIndexOf('~')
  if (sep < 0) return null
  const placedAt = raw.slice(0, sep)
  const id = raw.slice(sep + 1)
  if (!TIMESTAMP_RE.test(placedAt) || !Number.isFinite(Date.parse(placedAt)) || !UUID_RE.test(id)) return null
  return { placedAt, id }
}

/** Order rows as the terminal receives them: the stored row plus its payment and money figures. */
async function enrichOrders(
  supabase: ReturnType<typeof createServerSupabaseClient>,
  restaurantId: string,
  data: Record<string, unknown>[],
) {
  const orderIds = data.map((o: any) => String(o.id)).filter(Boolean)
  // Independent reads of the same rows: together, not one after the other. A projection failure
  // still fails the request (as it did when it ran first); financials stay fail-soft.
  const [projections, financials] = await Promise.all([
    getPaymentProjections(supabase, restaurantId, orderIds, { concurrency: PROJECTION_FANOUT }),
    financialsByOrder(supabase, data),
  ])

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

    /**
     * BOUNDED VIEWS (perf/latency-sprint 2026-10-01). Without a `scope` this route returns every
     * live order with no date bound -- 4,675 rows for FNB ChowNow on 2026-10-01, 4,543 of them
     * completed -- and every terminal in the field polls exactly that every 30 s. That response is
     * UNCHANGED below. A terminal that asks for a scope gets only what one screen shows:
     *
     *   ?scope=active                        pending/confirmed/preparing/ready, all (with the sweep)
     *   ?scope=completed[&limit=N][&cursor=]  completed, newest first, N per page (default 50, max
     *                                         200), plus `nextCursor` (null on the last page)
     *
     * Anything else in `scope`, `limit` or `cursor` is a 400 before anything is read.
     */
    const scope = url.searchParams.get('scope')
    if (scope !== null && scope !== 'active' && scope !== 'completed') {
      return NextResponse.json({ error: 'scope must be active or completed', code: 'INVALID_SCOPE' }, { status: 400 })
    }

    if (scope === 'completed') {
      const rawLimit = url.searchParams.get('limit')
      const limit = rawLimit === null ? COMPLETED_PAGE_DEFAULT : /^\d+$/.test(rawLimit) ? Number(rawLimit) : NaN
      if (!Number.isInteger(limit) || limit < 1 || limit > COMPLETED_PAGE_MAX) {
        return NextResponse.json(
          { error: `limit must be an integer from 1 to ${COMPLETED_PAGE_MAX}`, code: 'INVALID_LIMIT' },
          { status: 400 },
        )
      }
      const rawCursor = url.searchParams.get('cursor')
      const cursor = rawCursor === null ? null : parseCursor(rawCursor)
      if (rawCursor !== null && !cursor) {
        return NextResponse.json({ error: 'cursor is not one this route issued', code: 'INVALID_CURSOR' }, { status: 400 })
      }

      /**
       * KEYSET ON (placed_at, id), newest first. Two timestamps can be equal, so the cursor carries
       * the id as a tie-break. "After the cursor" is (placed_at < X) OR (placed_at = X AND id < Y):
       * TWO plain-filter queries sent together, not one `.or()` -- `.or()` parses its argument, and
       * this one would be built from the caller's input.
       *
       * NO SWEEP: autoCancelStalePosOrders only ever cancels non-completed orders, so it cannot
       * change what a completed page holds; it still runs on every legacy and ?scope=active poll.
       *
       * A completed order with NULL placed_at (the column is nullable; staging had none on
       * 2026-10-01) has no place on a keyset and is not paged here; the legacy list still has it.
       */
      const base = () =>
        supabase
          .from('orders')
          .select('*')
          .eq('restaurant_id', terminal.restaurantId)
          .eq('status', 'completed')
          .not('placed_at', 'is', null)
          .limit(limit)
      const [older, tied] = await Promise.all([
        (cursor ? base().lt('placed_at', cursor.placedAt) : base())
          .order('placed_at', { ascending: false })
          .order('id', { ascending: false }),
        cursor
          ? base().eq('placed_at', cursor.placedAt).lt('id', cursor.id).order('id', { ascending: false })
          : Promise.resolve({ data: [] as Record<string, unknown>[], error: null }),
      ])
      if (older.error) throw new Error(`terminal-orders-completed: ${older.error.message}`)
      if (tied.error) throw new Error(`terminal-orders-completed: ${tied.error.message}`)
      // Rows tied with the cursor's timestamp sort ahead of every strictly older row.
      const page = [
        ...((tied.data ?? []) as Record<string, unknown>[]),
        ...((older.data ?? []) as Record<string, unknown>[]),
      ].slice(0, limit)
      const last = page[page.length - 1]
      const nextCursor = page.length === limit && last ? `${String(last.placed_at)}~${String(last.id)}` : null

      const orders = await enrichOrders(supabase, terminal.restaurantId, page)
      return NextResponse.json({ orders, nextCursor })
    }

    // Lazy cleanup, same pattern as recomputeInvoiceStatus's lazy overdue check: no scheduled
    // job needed for the terminal's own polling to self-heal abandoned Sale-tab orders, since
    // this route is what the terminal calls to list its own orders in the first place.
    // verifyWithFinatic is deliberately false here: this route is polled frequently and must
    // stay fast/independent of Finatic's uptime. Only orders that never got a
    // paycloud_merchant_order_no (no payment attempt reached Finatic) are cancelled inline;
    // anything mid-flight is resolved by the Finatic-verified cron instead (up to ~2min extra).
    //
    // THE SWEEP RUNS FIRST, NOT ALONGSIDE THE READ (perf/latency-sprint 2026-10-01). It cancels
    // pending orders, which drops them out of the status filter below; landing between two of the
    // concurrent offset pages, that shifts every later page and silently SKIPS a row. Steady state
    // it is a single round trip.
    await autoCancelStalePosOrders(supabase, { restaurantId: terminal.restaurantId, verifyWithFinatic: false })

    // #323: every live order for the restaurant, no date bound (legacy), or the active set.
    // Pages after the first are fetched concurrently (fetchAllRowsConcurrently), kept in page order.
    // It throws on failure; the enclosing try/catch already answers with JSON.
    const statuses = scope === 'active' ? ACTIVE_ORDER_STATUSES : LIVE_ORDER_STATUSES
    const data = await fetchAllRowsConcurrently<Record<string, unknown>>(
      () =>
        supabase
          .from('orders')
          .select('*')
          .eq('restaurant_id', terminal.restaurantId)
          .in('status', statuses)
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
