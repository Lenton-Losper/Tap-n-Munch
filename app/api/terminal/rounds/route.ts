/**
 * ADR-005 §1, §2 and §7 -- Send. A waiter commits a round onto a tab, and the stations get lines.
 *
 * ============================================================================================
 * WHAT THIS ROUTE INHERITS RATHER THAN REIMPLEMENTS
 * ============================================================================================
 *
 * RULED: a waiter round deducts stock exactly the way a POS order does today -- inherit the
 * behaviour, change nothing. This route honours that by containing NO stock code at all.
 *
 * Deduction is not application code. It runs from an AFTER UPDATE trigger, `deduct_recipe_stock`,
 * when an order is completed (see the note in app/api/orders/route.ts). So an ordinary order row
 * written through `createOrder` deducts at exactly the same moment, by exactly the same mechanism,
 * as a POS order -- and the way to change nothing is to write nothing.
 *
 * The parallel inventory workstream is rewriting that surface. A waiter round is a new CALLER of
 * the same trigger, never a second copy of it.
 *
 * `checkStockSufficiency` IS called, because the POS path calls it: a tracked item at zero stock
 * is refused at the moment it is rung up, which is the only point where it can still be acted on.
 * Same rule, same 409, same tolerance of a failed read.
 *
 * `createOrder` RE-PRICES from the catalog and ignores the client's subtotal/total. That is the
 * anti-tampering control on the terminal path and it is inherited here unchanged -- a device is a
 * client, and a waiter's P5 does not get to set prices any more than a customer's phone does.
 *
 * ============================================================================================
 * ONE ROUND PER SEND
 * ============================================================================================
 *
 * `x-idempotency-key` is REQUIRED, and a duplicate Send returns the original round rather than
 * creating a second one. See the validation below for why it is mandatory here when the POS path
 * leaves it optional, and the replay guard further down for why checking the ORDER is not enough.
 *
 * ============================================================================================
 * LINES ARE BUILT FROM THE STORED ITEMS, NOT FROM THE REQUEST BODY
 * ============================================================================================
 *
 * `order_lines.source_item_index` has to index into `orders.items` as PERSISTED. createOrder
 * re-prices and rewrites the item array before storing it, so indexing the request body would
 * produce lines pointing at the wrong items the moment the two arrays differ in length or order.
 *
 * So the order is read back and the lines are built from what actually landed. One extra read,
 * and it is the difference between a join that works and a join that silently lies.
 *
 * ============================================================================================
 * THE KNOWN GAP: THE ORDER AND ITS LINES ARE NOT ONE TRANSACTION
 * ============================================================================================
 *
 * PostgREST gives no multi-statement transaction, so the order row and its lines are separate
 * round trips. If the lines fail, an order exists that no station can see.
 *
 * This route does NOT hide that. It answers 502 with the orderId and `lines_written: false`, so
 * the device can tell the waiter the round was taken but the kitchen has not seen it -- which is
 * a thing a human can act on. Silently answering 200 would put food on a bill that nobody cooks.
 *
 * The proper fix is a single RPC writing both inside one transaction. It is a follow-up, and it
 * is named in the terminal brief so the APK author knows the failure exists.
 */
import { NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { resolveOrderRestaurantScope } from '@/lib/supabase/restaurants'
import { requireTerminalAuth, validateTerminalRecord } from '@/lib/terminal-auth'
import { requireFeature } from '@/lib/features/get-restaurant-features'
import { createOrder } from '@/lib/orders/create-order'
import { enrichOrderItemsWithRouteTo } from '@/lib/order-routing'
import { checkStockSufficiency } from '@/lib/orders/check-stock-sufficiency'
import {
  buildOrderLines,
  findInvalidLineNoteIndex,
  stationsOwnedBy,
  writeOrderLines,
  type LineRouteTo,
} from '@/lib/orders/order-lines'
import { broadcastLineChanged } from '@/lib/stations/realtime-invalidate'

export const dynamic = 'force-dynamic'

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
}

export async function POST(request: Request) {
  try {
    const terminal = await requireTerminalAuth(request)
    const supabase = createServerSupabaseClient()
    await validateTerminalRecord(supabase, terminal)

    /**
     * ADR-005 is a station_screens_enabled venue's flow, not server policy yet. Riviera-only was
     * an accident of client version -- Mingle and ChowNow are protected only by an old APK never
     * calling this endpoint, not by anything server-side. Added 2026-08-28.
     */
    const { allowed } = await requireFeature(terminal.restaurantId, 'station_screens_enabled')
    if (!allowed) {
      return NextResponse.json(
        { error: 'Waiter-led service is not enabled for this restaurant', code: 'STATION_SCREENS_DISABLED' },
        { status: 403 },
      )
    }

    if (!terminal.permissions.includes('orders:update')) {
      return NextResponse.json({ error: 'Missing permission' }, { status: 403 })
    }

    const body = (await request.json().catch(() => ({}))) as {
      tab_id?: unknown
      items?: unknown
      subtotal?: unknown
      total?: unknown
      order_instructions?: unknown
    }

    const tabId = String(body.tab_id ?? '').trim()
    const items = body.items

    if (!tabId || !isUuid(tabId)) {
      return NextResponse.json({ error: 'tab_id must be a valid UUID' }, { status: 400 })
    }
    if (!Array.isArray(items) || items.length === 0) {
      return NextResponse.json({ error: 'items are required' }, { status: 400 })
    }

    /**
     * A note that is not text is refused before anything is written.
     *
     * line_note is a text column and Postgres COERCES rather than refusing, so an object arrives
     * in the database as the literal "[object Object]" and a cook reads that off the pass.
     * Dropping it silently is worse: the steak comes out wrong and nothing recorded that a note
     * was ever sent. See findInvalidLineNoteIndex.
     */
    const badNoteIndex = findInvalidLineNoteIndex(items)
    if (badNoteIndex !== null) {
      return NextResponse.json(
        {
          error: `items[${badNoteIndex}] has a note that is not text. Send \`note\` as a string.`,
          code: 'INVALID_LINE_NOTE',
          item_index: badNoteIndex,
        },
        { status: 400 },
      )
    }

    /**
     * RULED: one round per Send, and duplicate Sends are rejected. The key is REQUIRED here, not
     * best-effort, and that is the whole point.
     *
     * The mechanism has existed since 20260502140000 -- a unique partial index on
     * orders.idempotency_key, plus createOrder's 23505 branch returning the original order. It has
     * never fired on the POS path because the POS sends no key: 0 of 1,545 orders carry one, which
     * is exactly why every failed retry there stranded a duplicate order.
     *
     * A mechanism that callers may opt out of is a mechanism that is off. So this endpoint refuses
     * the request rather than inheriting that.
     */
    const idempotencyKey = String(request.headers.get('x-idempotency-key') ?? '').trim()
    if (!idempotencyKey) {
      return NextResponse.json(
        {
          error:
            'x-idempotency-key is required. Send one uuid per round and reuse it across retries ' +
            'of that same round.',
          code: 'IDEMPOTENCY_KEY_REQUIRED',
        },
        { status: 400 },
      )
    }

    /**
     * The tab is the authority for the table AND for who owns the round. The device does not get
     * to name a table or a waiter: both are read from the tab it is adding to, so a device cannot
     * attribute a round to somebody else by sending a different id.
     */
    const { data: tab, error: tabError } = await supabase
      .from('tabs')
      .select('id, restaurant_id, table_id, table_number, status, opened_by_user_id')
      .eq('id', tabId)
      .eq('restaurant_id', terminal.restaurantId)
      .maybeSingle()

    if (tabError) throw tabError
    if (!tab?.id) {
      return NextResponse.json({ error: 'Tab not found' }, { status: 404 })
    }
    if (!['open', 'ready_to_pay'].includes(String(tab.status))) {
      return NextResponse.json(
        { error: `Tab is ${tab.status}, so a round cannot be added to it`, code: 'TAB_NOT_OPEN' },
        { status: 409 },
      )
    }

    // Identical to the POS path, including the decision to allow the order through when the
    // balance READ itself fails. A failed read must never stop the till taking orders.
    try {
      const sufficiency = await checkStockSufficiency(supabase, terminal.restaurantId, items)
      if (!sufficiency.ok) {
        return NextResponse.json(
          {
            error: sufficiency.reason,
            code: 'OUT_OF_STOCK',
            outOfStock: sufficiency.unavailable.map((u) => ({
              item: u.itemName,
              ingredient: u.stockItemName,
            })),
          },
          { status: 409 },
        )
      }
    } catch (err) {
      console.error('[TERMINAL ROUNDS] stock sufficiency check failed, allowing round:', err)
    }

    const orderRestaurantScope = await resolveOrderRestaurantScope(terminal.restaurantId)

    // Keeps orders.items shaped exactly as every other channel writes it, so the existing
    // station filters (orderMatchesStation) behave the same on a waiter round as on a POS order.
    // The LINE stations are resolved separately and differently -- see lib/orders/order-lines.ts.
    const enrichedItems = await enrichOrderItemsWithRouteTo(supabase, items)

    const result = await createOrder({
      restaurantId: orderRestaurantScope.restaurantId,
      firebaseRestaurantId: orderRestaurantScope.firebaseRestaurantId,
      tableNumber: Number(tab.table_number) || 0,
      tableId: tab.table_id ? String(tab.table_id) : null,
      // ADR-005 §4: a waiter-opened tab has NO customer session, because nobody scanned.
      sessionId: null,
      memberSessionId: null,
      items: enrichedItems,
      subtotal: Number(body.subtotal) || 0,
      total: Number(body.total) || 0,
      // The round is not paid here. It accumulates on the tab and is settled later.
      paymentMethod: 'cash',
      paymentChannel: null,
      paymentStatus: 'pending',
      orderInstructions:
        typeof body.order_instructions === 'string' && body.order_instructions.trim()
          ? body.order_instructions.trim()
          : null,
      tabId: String(tab.id),
      tabSettlementForTabId: null,
      channel: 'pos',
      customerName: null,
      idempotencyKey,
      // Stays on the tab -- the table is not closed by taking a round.
      isClosed: false,
    })

    /**
     * THE REPLAY GUARD, and it is not optional.
     *
     * On a duplicate Send, createOrder's 23505 branch returns the ORIGINAL order rather than
     * creating a second one -- which is correct, and which means `result.orderId` here is an order
     * whose lines already exist. Writing lines again would put a second copy of the whole round in
     * front of the kitchen: the customer is billed once and the food is made twice.
     *
     * So the lines are the thing checked, not the order. If any exist for this order, this call is
     * a replay: report what is already there and write nothing.
     */
    const { data: existingLines, error: existingLinesError } = await supabase
      .from('order_lines')
      .select('id, route_to')
      .eq('order_id', result.orderId)

    if (existingLinesError) throw existingLinesError

    if ((existingLines ?? []).length > 0) {
      const stationCounts = { kitchen: 0, bar: 0, unrouted: 0 }
      for (const row of existingLines as Array<{ route_to: LineRouteTo }>) {
        const owned = stationsOwnedBy(row.route_to)
        if (owned.includes('kitchen')) stationCounts.kitchen += 1
        if (owned.includes('bar')) stationCounts.bar += 1
        if (row.route_to === 'unrouted') stationCounts.unrouted += 1
      }

      return NextResponse.json({
        success: true,
        // The device treats this as success and returns to the grid. It is the SAME round, not a
        // new one, and showing an error for it would make a waiter send it a third time.
        duplicate: true,
        order_id: result.orderId,
        order_number: result.orderNumber,
        tab_id: String(tab.id),
        lines_written: true,
        line_count: (existingLines ?? []).length,
        station_counts: stationCounts,
      })
    }

    // See the header: lines index into the STORED items, so they are read back.
    const { data: storedOrder, error: storedOrderError } = await supabase
      .from('orders')
      .select('id, items')
      .eq('id', result.orderId)
      .maybeSingle()

    if (storedOrderError) throw storedOrderError

    const lines = await buildOrderLines(supabase, {
      restaurantId: terminal.restaurantId,
      orderId: result.orderId,
      tabId: String(tab.id),
      items: storedOrder?.items ?? enrichedItems,
    })

    let written
    try {
      written = await writeOrderLines(supabase, lines, {
        actorKind: 'terminal',
        // The round is attributed to the tab's opening owner. ADR-005 §6 ruling 2: that is who
        // served them, and it cannot be spoofed by the request body.
        actorUserId: tab.opened_by_user_id ? String(tab.opened_by_user_id) : null,
      })
    } catch (linesError) {
      console.error(
        '[TERMINAL ROUNDS] THE ORDER WAS CREATED BUT ITS LINES WERE NOT — no station will see ' +
          'this round, and the food will not be made unless somebody is told',
        { orderId: result.orderId, tabId: tab.id, error: linesError },
      )
      return NextResponse.json(
        {
          error:
            'The round was recorded on the tab but the kitchen and bar were not notified. Tell a ' +
            'manager before serving this table.',
          code: 'LINES_NOT_WRITTEN',
          order_id: result.orderId,
          order_number: result.orderNumber,
          lines_written: false,
        },
        { status: 502 },
      )
    }

    /**
     * A new round is new outstanding work -- exactly the kind of "what this tab looks like just
     * changed" event a station board or another terminal with this same table open needs to know
     * about, same reason a bump does. The replay branch above (existing lines, nothing written)
     * deliberately does not reach here.
     */
    await broadcastLineChanged(supabase, terminal.restaurantId)

    return NextResponse.json({
      success: true,
      duplicate: false,
      order_id: result.orderId,
      order_number: result.orderNumber,
      tab_id: String(tab.id),
      lines_written: true,
      line_count: written.lineCount,
      // So the device can show "4 to kitchen, 2 to bar" on the confirmation, and so an
      // unrouted count is visible to the waiter rather than only to the stations.
      station_counts: written.stationCounts,
    })
  } catch (err: unknown) {
    if (err instanceof Response) return err
    const message = err instanceof Error ? err.message : 'Internal server error'
    console.error('[TERMINAL/ROUNDS POST]', message)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
