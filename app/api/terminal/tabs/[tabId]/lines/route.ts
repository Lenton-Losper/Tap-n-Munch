/**
 * ADR-005 §5 -- what the waiter's TABLE VIEW reads: everything ordered on this tab, and which of
 * it is still being made.
 *
 * ============================================================================================
 * WHY THIS ENDPOINT HAD TO EXIST
 * ============================================================================================
 *
 * The table view needs "outstanding vs ready, for THIS table". Nothing could answer that:
 *
 *   * POST /api/terminal/rounds is write-only.
 *   * GET /api/station/lines is scoped by restaurant AND state='outstanding', with no tab or
 *     table filter -- and done lines drop out of it entirely, so "not returned" is
 *     indistinguishable from "the call failed".
 *   * The legacy GET /api/terminal/tables carries tab.orders[].items[], which is the BILLING
 *     shape and has no line state in it at all.
 *
 * The available workaround was to join the tab's items against /api/station/lines for both
 * stations and treat "on the tab but not returned" as ready. That silently reports READY for
 * anything a failed station call omits -- a waiter carrying food that was never made, from a
 * screen that looked confident. Not shippable as a readiness signal.
 *
 * So the read exists here, scoped to one tab, returning every line WITH its per-station state.
 *
 * ============================================================================================
 * IT RETURNS DONE AND VOIDED LINES TOO, DELIBERATELY
 * ============================================================================================
 *
 * The station screens want only outstanding work. A waiter wants the opposite: the whole history
 * of the table, because "has the starter gone out yet" is answered by a line that is DONE. A
 * filtered view would make the table look emptier than the bill.
 */
import { NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { requireTerminalAuth, validateTerminalRecord } from '@/lib/terminal-auth'
import { requireFeature } from '@/lib/features/get-restaurant-features'
import { isLineReady, type LineRouteTo, type LineState } from '@/lib/orders/order-lines'
import { toCents } from '@/lib/billing/split-cents'

export const dynamic = 'force-dynamic'

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
}

type LineRow = {
  id: string
  order_id: string
  source_item_index: number
  name_snapshot: string
  quantity: number
  line_note: string | null
  route_to: LineRouteTo
  kitchen_state: LineState | null
  bar_state: LineState | null
  created_at: string
}

/** Voided if EVERY station that owns the line has voided it. A half-voided line is still work. */
function isVoided(line: { kitchen_state: LineState | null; bar_state: LineState | null }): boolean {
  const owned = [line.kitchen_state, line.bar_state].filter((s): s is LineState => s != null)
  return owned.length > 0 && owned.every((s) => s === 'voided')
}

/** Collected if EVERY station that owns the line has been collected from. A 'both' line with one
 *  half collected and one still sitting ready is NOT this -- there is still something on a pass
 *  waiting for a waiter, and the bucket below must say so. */
function isCollected(line: { kitchen_state: LineState | null; bar_state: LineState | null }): boolean {
  const owned = [line.kitchen_state, line.bar_state].filter((s): s is LineState => s != null)
  return owned.length > 0 && owned.every((s) => s === 'collected')
}

/**
 * ============================================================================================
 * THE SECOND collected GAP: THE FOOD-UP SIGNAL, NOT THE LABEL
 * ============================================================================================
 *
 * Found by the terminal handover, 20260829 -- Max could read the symptom (FOOD UP never clears)
 * but not this route to find the cause. Distinct from serializeStateForLegacyTerminal above:
 * that one is about a per-line STATUS LABEL and is genuinely harmless to get slightly stale.
 * This one is the AGGREGATE the floor badge counts, and getting it wrong is not cosmetic.
 *
 * `isLineReady()` (lib/orders/order-lines.ts) treats 'collected' as still ready, deliberately --
 * "one step past ready, not a step back" is the right answer to "has the pass finished with
 * this line". But the terminal's floor badge is not asking that question. It is asking "is there
 * food sitting at a pass RIGHT NOW that a waiter has not walked over for yet" -- and that
 * question's answer flips to false the moment a line is collected, not never.
 *
 * Before this fix, `is_ready`/`summary.ready` on this route reused isLineReady()'s general
 * answer, so a collected line stayed counted in the 'ready' bucket forever. The terminal source
 * has never heard the word 'collected' and only ever counts is_ready lines for FOOD UP, so it had
 * no way to notice the dish it was told about was already gone -- the badge could only ever turn
 * ON, never off, once the first line reached the pass.
 *
 * THE FIX IS SCOPED TO THIS ROUTE, NOT TO isLineReady(). The general "has this been handled"
 * question and the terminal's "is something waiting for me right now" question are different
 * questions that happened to have the same answer until 'collected' existed; giving them the
 * same name (`is_ready`) on two different responses is what let this gap open. This route now
 * computes its OWN four-way bucket from the raw states before any legacy-terminal translation,
 * and `is_ready` here means exactly "in the ready bucket" -- true for 'ready', false for
 * 'collected', matching what a floor badge actually needs.
 *
 * `all_ready` is UNCHANGED (still `outstanding === 0`) -- settling a table has never depended on
 * whether ready food was physically collected, only on whether anything is still being made.
 */
type LineBucket = 'outstanding' | 'ready' | 'collected' | 'voided'

function bucketForLine(line: { kitchen_state: LineState | null; bar_state: LineState | null }): LineBucket {
  if (isVoided(line)) return 'voided'
  if (isCollected(line)) return 'collected'
  if (isLineReady(line)) return 'ready'
  return 'outstanding'
}

/**
 * ============================================================================================
 * COOKED PROGRESS — ADDITIVE, AND DELIBERATELY *NOT* A FIFTH BUCKET
 * ============================================================================================
 *
 * Waiters asked to see cooked progress; the terminal has no representation of `cooked` at all
 * today, so a plated dish and an unstarted one look identical on the table view.
 *
 * The tempting change is to give `cooked` its own bucket alongside outstanding/ready/collected/
 * voided. THAT WOULD BE A SILENT REGRESSION, and it is worth naming precisely:
 *
 *     all_ready is `summary.outstanding === 0`.
 *
 * Move cooked lines out of `outstanding` and a table whose every dish is plated but not yet passed
 * reports all_ready -- "nothing outstanding at this table" -- while the food is still under the
 * lamp and the pass has not touched it. A progress indicator must not be able to change what
 * "this table is finished" means.
 *
 * So cooked stays IN the outstanding bucket, exactly as before, and everything here is new fields
 * that old clients ignore. `summary.outstanding`, `summary.ready`, `all_ready` and the raw
 * kitchen_state/bar_state strings are byte-for-byte what they were, and
 * serializeStateForLegacyTerminal is untouched -- widening that vocabulary is what made an old
 * till render "Being made" for a collected line.
 *
 * A COUNT, NOT A FLAG. "2 of 5 cooked" is progress a waiter can act on; a COOKING chip is another
 * word for not-ready, and staff learn to ignore a chip that never changes anything.
 *
 * SPLIT BY STATION, because three of four food items plated while the drinks have not been started
 * is different information from three of four overall -- the first says the trip is nearly worth
 * making, the second says nothing about whether anything is collectable.
 */
function hasCookedStation(line: { kitchen_state: LineState | null; bar_state: LineState | null }): boolean {
  return line.kitchen_state === 'cooked' || line.bar_state === 'cooked'
}

/** Per-station progress. `total` excludes voided halves -- a cancelled item is not work in hand. */
type StationProgress = { total: number; cooked: number }

function tallyStation(progress: StationProgress, state: LineState | null): void {
  // A null state is a station that does not own this line, so it is not work either way.
  if (state == null || state === 'voided') return
  progress.total += 1
  if (state === 'cooked') progress.cooked += 1
}

/**
 * 'collected' (20260829160000, the board rebuild's pinned Ready zone) DOWNGRADES to 'ready' in
 * the raw kitchen_state/bar_state strings THIS route serialises. Nowhere else -- the station
 * screens (lib/stations/map-raw-lines.ts) read the real five-value vocabulary directly and must
 * keep doing so.
 *
 * ============================================================================================
 * WHY THIS EXISTS: THE ready_to_run SHAPE, IN THE READ DIRECTION
 * ============================================================================================
 *
 * `is_ready` on this same response is computed server-side (isLineReady already treats
 * 'collected' as ready) and is safe for any client regardless of its own vocabulary. The raw
 * kitchen_state/bar_state strings are not -- a waiter terminal on a build that predates
 * 'collected' (confirmed: at least app_version 2.13) may render a floor badge off THOSE strings
 * directly rather than off is_ready, the same way the old (guessed) 'ready_to_run' value broke a
 * client that read it literally. A fifth value such a client has never seen falls into whatever
 * its switch's default does -- worst case, a picked-up plate reads as not-started, which is the
 * most misleading direction a floor badge could fail in.
 *
 * Serialising 'collected' as 'ready' costs nothing true: to a waiter, "picked up" and "ready" both
 * mean nothing is left to do at that line. It is not a lie the way defaulting to 'outstanding'
 * would be.
 *
 * ============================================================================================
 * WHEN THIS CAN GO -- A SHIM NOBODY CAN DATE IS A SHIM NOBODY REMOVES
 * ============================================================================================
 *
 * Remove this once every terminal actually in the field has an app_version that knows
 * 'collected' -- i.e. once `select min(app_version) from <wherever app_version is tracked, see
 * app/api/terminal/heartbeat/route.ts>` for restaurants running the waiter-led flow is at or past
 * that release. Until a version handshake exists to answer that question from data rather than
 * from memory, treat "have we heard from anything older" as the honest way to check it, and leave
 * this in.
 */
function serializeStateForLegacyTerminal(state: LineState | null): LineState | null {
  return state === 'collected' ? 'ready' : state
}

export async function GET(req: Request, { params }: { params: Promise<{ tabId: string }> }) {
  try {
    const terminal = await requireTerminalAuth(req)
    const supabase = createServerSupabaseClient()

    /**
     * Independent reads, one round trip instead of two — measured median for this route was 994 ms
     * on production 2026-09-03, against ~1 ms of database execution. allSettled preserves the
     * original order of refusal; see app/api/terminal/station-lines/route.ts.
     *
     * ADR-005 is a station_screens_enabled venue's flow, not server policy yet. Riviera-only was
     * an accident of client version -- Mingle and ChowNow are protected only by an old APK never
     * calling this endpoint, not by anything server-side. Added 2026-08-28.
     */
    const [validation, feature] = await Promise.allSettled([
      validateTerminalRecord(supabase, terminal),
      requireFeature(terminal.restaurantId, 'station_screens_enabled'),
    ])
    if (validation.status === 'rejected') throw validation.reason
    const { allowed } = feature.status === 'fulfilled' ? feature.value : { allowed: false }
    if (!allowed) {
      return NextResponse.json(
        { error: 'Waiter-led service is not enabled for this restaurant', code: 'STATION_SCREENS_DISABLED' },
        { status: 403 },
      )
    }

    if (!terminal.permissions.includes('orders:read')) {
      return NextResponse.json({ error: 'Missing permission' }, { status: 403 })
    }

    const { tabId } = await params
    if (!tabId || !isUuid(tabId)) {
      return NextResponse.json({ error: 'tabId must be a valid UUID' }, { status: 400 })
    }

    // Scoped by restaurant as well as id, so a terminal cannot read another venue's tab by
    // guessing a uuid.
    /**
     * The tab header and its lines are both keyed by tabId — neither needs the other's answer, so
     * they are one wave. Only `orders` below must wait, because it is keyed by the order_ids the
     * line rows return.
     *
     * The 404 still wins over any line data: the tab is checked first below, exactly as before, so
     * a terminal guessing another venue's uuid gets the same answer it always did.
     */
    const [tabRes, linesRes, allocationsRes] = await Promise.all([
      supabase
        .from('tabs')
        .select('id, table_number, status, total, opened_by_user_id, created_at')
        .eq('id', tabId)
        .eq('restaurant_id', terminal.restaurantId)
        .maybeSingle(),
      supabase
        .from('order_lines')
        .select(
          'id, order_id, source_item_index, name_snapshot, quantity, line_note, route_to, kitchen_state, bar_state, created_at',
        )
        .eq('restaurant_id', terminal.restaurantId)
        .eq('tab_id', tabId)
        .order('created_at', { ascending: true }),
      /**
       * ============================================================================================
       * THE SPLIT, AS IT STANDS — without this the terminal cannot SEE one
       * ============================================================================================
       *
       * docs/design-item-level-bill-splitting.md point 3: "extending it to also carry
       * `allocations: []` when present is additive". It was never done, and the omission made the
       * feature unusable rather than merely incomplete: `POST .../allocate` returns the rows it
       * just wrote, so a split was visible ONLY to the device that made it, only until that screen
       * was closed. A second waiter, a reopened table, or a crashed app saw an unsplit bill and
       * would have split it again.
       *
       * Keyed by tab_id, so it joins the existing wave rather than adding a round trip — this
       * endpoint's latency is already the thing being watched.
       *
       * VOIDED ALLOCATIONS ARE EXCLUDED, settled ones are NOT. A settled allocation is exactly what
       * the collect screen must show as already paid; dropping it would offer the same share for
       * payment twice.
       */
      supabase
        .from('order_line_allocations')
        .select('id, order_line_id, allocated_to, quantity_allocated, amount_cents, settled_at')
        .eq('restaurant_id', terminal.restaurantId)
        .eq('tab_id', tabId)
        .is('voided_at', null),
    ])

    const { data: tab, error: tabError } = tabRes
    if (tabError) throw tabError
    if (!tab?.id) {
      return NextResponse.json({ error: 'Tab not found' }, { status: 404 })
    }

    const { data: lines, error: linesError } = linesRes
    if (linesError) throw linesError

    const lineRows = (lines ?? []) as LineRow[]

    /**
     * A failed allocations read DEGRADES to "no split" rather than failing the table view. The
     * bill, the readiness and every existing figure are unaffected by it, and a waiter who cannot
     * see the table at all is worse off than one who cannot see a split. Logged, never silent.
     */
    const allocationsByLineId = new Map<string, Array<Record<string, unknown>>>()
    if (allocationsRes.error) {
      console.error('[terminal/tabs/lines] allocations unavailable', allocationsRes.error.message)
    } else {
      for (const a of (allocationsRes.data ?? []) as Array<Record<string, unknown>>) {
        const key = String(a.order_line_id)
        const list = allocationsByLineId.get(key) ?? []
        list.push({
          id: String(a.id),
          allocated_to: a.allocated_to,
          quantity_allocated: Number(a.quantity_allocated),
          amount_cents: Number(a.amount_cents),
          settled_at: a.settled_at ?? null,
        })
        allocationsByLineId.set(key, list)
      }
    }

    const orderIds = [...new Set(lineRows.map((l) => String(l.order_id)))]
    const ordersById = new Map<string, Record<string, unknown>>()

    if (orderIds.length > 0) {
      const { data: orders, error: ordersError } = await supabase
        .from('orders')
        .select('id, order_number, placed_at, order_instructions, total, items')
        .in('id', orderIds)

      if (ordersError) throw ordersError
      for (const order of (orders ?? []) as Array<Record<string, unknown>>) {
        ordersById.set(String(order.id), order)
      }
    }

    // One clock for the whole payload.
    const now = Date.now()
    // 'collected' is its own bucket, additive -- a pre-collected terminal reads outstanding/
    // ready/voided by name, same as before, and now correctly sees 'ready' drop once a line is
    // actually picked up rather than counting it forever. See bucketForLine's own docblock.
    const summary = {
      total_lines: 0,
      outstanding: 0,
      ready: 0,
      collected: 0,
      voided: 0,
      // Additive station progress. See hasCookedStation's docblock: cooked lines are still counted
      // in `outstanding` above, so nothing here can move `all_ready`.
      kitchen: { total: 0, cooked: 0 } as StationProgress,
      bar: { total: 0, cooked: 0 } as StationProgress,
    }

    const grouped = new Map<string, Record<string, unknown>>()

    for (const line of lineRows) {
      const orderId = String(line.order_id)

      if (!grouped.has(orderId)) {
        const order = ordersById.get(orderId)
        const placedAt = order?.placed_at ? String(order.placed_at) : null
        const placedMs = placedAt ? new Date(placedAt).getTime() : Number.NaN
        grouped.set(orderId, {
          order_id: orderId,
          order_number: order?.order_number ?? null,
          order_instructions: order?.order_instructions ?? null,
          order_total: order?.total ?? null,
          placed_at: placedAt,
          seconds_since_placed: Number.isFinite(placedMs)
            ? Math.max(0, Math.round((now - placedMs) / 1000))
            : null,
          lines: [] as Array<Record<string, unknown>>,
        })
      }

      const bucket = bucketForLine(line)

      // Same derivation as readLineTotalCents(): orders.items[source_item_index].total, integer
      // cents. Null when unpriceable rather than 0 -- see total_cents below.
      const orderItems = Array.isArray(ordersById.get(orderId)?.items)
        ? (ordersById.get(orderId)!.items as Array<Record<string, unknown>>)
        : []
      const sourceItem = orderItems[line.source_item_index]
      const rawTotal = sourceItem?.total
      const derivedCents =
        rawTotal === undefined || rawTotal === null ? NaN : toCents(Number(rawTotal))
      const lineTotalCents =
        Number.isFinite(derivedCents) && derivedCents >= 0 ? derivedCents : null
      const lineAllocations = allocationsByLineId.get(String(line.id)) ?? []

      summary.total_lines += 1
      summary[bucket] += 1
      tallyStation(summary.kitchen, line.kitchen_state)
      tallyStation(summary.bar, line.bar_state)

      ;(grouped.get(orderId)!.lines as Array<Record<string, unknown>>).push({
        id: line.id,
        name_snapshot: line.name_snapshot,
        quantity: line.quantity,
        line_note: line.line_note,
        route_to: line.route_to,
        kitchen_state: serializeStateForLegacyTerminal(line.kitchen_state),
        bar_state: serializeStateForLegacyTerminal(line.bar_state),
        // is_ready means "in the ready bucket" -- see bucketForLine's docblock on why this is
        // NOT the same question as the general isLineReady(). is_collected is additive, for a
        // terminal that has been taught the word.
        is_ready: bucket === 'ready',
        is_collected: bucket === 'collected',
        is_voided: bucket === 'voided',
        /**
         * At least one station has plated this, and the line is not already past that. Scoped to
         * the outstanding bucket ON PURPOSE, so the precedence a client renders can be a straight
         * fall-through — ready, then cooked, then still being made — with no arrangement of states
         * in which is_cooked and is_ready are both true and a client has to guess which wins.
         */
        is_cooked: bucket === 'outstanding' && hasCookedStation(line),
        unrouted: line.route_to === 'unrouted',
        /**
         * ============================================================================================
         * THE SPLIT, PER LINE — money derived the SAME way the allocate route derives it
         * ============================================================================================
         *
         * `total_cents` is orders.items[source_item_index].total in integer cents, which is exactly
         * what readLineTotalCents() (lib/orders/order-line-allocations.ts) computes server-side
         * before splitting. Deriving it a second, different way here is how a screen comes to show
         * "N$40 not yet assigned" against a line the server would split for some other figure — so
         * it reads the same field through the same toCents().
         *
         * order_lines carries no price column by design, so this join back to orders.items is the
         * only place a line's own money exists.
         *
         * NULL when the item cannot be priced (missing index, malformed item). The screen must then
         * decline to offer a split for that line rather than guess — which is why this is null and
         * not 0. A zero would read as a free item and split cleanly into nothing.
         */
        total_cents: lineTotalCents,
        allocations: lineAllocations,
        allocated_cents: lineAllocations.reduce((sum, a) => sum + Number(a.amount_cents ?? 0), 0),
      })
    }

    return NextResponse.json({
      tab: {
        id: tab.id,
        table_number: tab.table_number ?? null,
        status: tab.status,
        total: tab.total,
        opened_at: tab.created_at,
        opened_by_user_id: tab.opened_by_user_id ?? null,
      },
      // Newest round last: a waiter reads a table top to bottom in the order it was ordered.
      orders: [...grouped.values()],
      /**
       * The counts the table view puts at the top. `total_lines` is FULFILMENT lines, which for
       * an item routed to both stations is still ONE line -- it is not a count of anything
       * billable, and must never be shown as a quantity of items sold.
       */
      summary,
      /**
       * TRUE when the tab has lines and every one of them is ready, collected, or voided. This is
       * the "nothing outstanding at this table" signal; it is NOT a payment state and says
       * nothing about whether the bill has been settled. UNCHANGED by the collected split above
       * -- settling has never depended on whether ready food was physically picked up, only on
       * whether anything is still being made.
       */
      all_ready: summary.total_lines > 0 && summary.outstanding === 0,
      /**
       * Lines only exist for rounds sent through the waiter flow. A tab that predates it, or a
       * QR tab, has a bill but no lines -- so the table view must render the bill from the tab
       * total and simply not claim anything about readiness.
       */
      has_lines: summary.total_lines > 0,
      server_time: new Date(now).toISOString(),
    })
  } catch (err: unknown) {
    if (err instanceof Response) return err
    const message = err instanceof Error ? err.message : 'Internal server error'
    console.error('[terminal/tabs/lines GET]', message)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
