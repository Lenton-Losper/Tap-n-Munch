/**
 * Customer order editing, before preparation starts.
 *
 *   POST   acquire (or renew) the edit lock
 *   PATCH  commit the edit — requires the token POST handed out
 *   DELETE release the lock early
 *
 * ONE orderId covers both surfaces. A QR submission is an `order_requests` row until staff
 * Accept and an `orders` row afterwards, and the customer's link does not change when it
 * graduates, so this resolves the id against `orders` first and falls back to
 * `order_requests` — the same order lib/guest-orders/queries.ts already uses.
 *
 * THE LOCK IS THE `WHERE` CLAUSE, NOT THE READ. Every write here is conditional in the
 * database: acquire is conditioned on the token observed a moment earlier (`.eq`, or `.is
 * null` when there was none), and commit is conditioned on the caller's own token plus the
 * status and payment allowlists. Zero rows affected means somebody else got there first and
 * the caller is told so — nothing is decided by comparing values in this process, because
 * two Workers isolates comparing the same stale read would both conclude they had won.
 *
 * STAFF WINS, and here is the whole mechanism: PATCH /api/orders/[orderId]/status nulls
 * edit_lock_token whenever it moves an order out of the editable set. A customer commit
 * already in flight then matches zero rows and is refused with "the kitchen has started".
 * The reverse cannot happen — no staff route consults the lock before writing.
 *
 * AUTH is the guest session id, matched against the row's session_id or member_session_id.
 * Deliberately NOT guestCanAccessOrder: that helper admits an open order on table_number
 * alone, which is the right call for a read on a shared table and the wrong one for a write.
 * Knowing a table number must not let one diner edit another's order.
 */
import { NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { resolveRestaurantUuid } from '@/lib/supabase/restaurants'
import {
  EDITABLE_ORDER_STATUSES,
  EDITABLE_PAYMENT_STATUSES,
  EDITABLE_REQUEST_STATUSES,
  EDIT_COPY,
  appendEditHistory,
  editLockExpiryFrom,
  editRefusalReason,
  editRequiresReacceptance,
  isEditLockActive,
  normalizeSessionIds,
  requestEditRefusalReason,
  type EditRefusalReason,
} from '@/lib/orders/edit-lock'
import { InvalidEditError, repriceKeptLines, type LineKeepInstruction } from '@/lib/orders/reprice-priced-lines'
import { effectiveRequestPricing } from '@/lib/orders/order-request-pricing'
import { normalizeOrderInstructions } from '@/lib/orders/instruction-limits'

export const dynamic = 'force-dynamic'

type RouteParams = { params: Promise<{ orderId: string }> }

type Surface = 'orders' | 'order_requests'

type LoadedTarget = {
  surface: Surface
  row: Record<string, unknown>
}

/**
 * Explicit column lists, and written as single literals rather than concatenations on purpose:
 * supabase-js parses the select string at the TYPE level, and a runtime-built string degrades
 * the row type to GenericStringError — which then needs a double cast at every use. A literal
 * types itself.
 */
const ORDER_COLUMNS =
  'id, restaurant_id, tab_id, session_id, member_session_id, status, payment_status, payment_checkout_url, items, subtotal, tax, total, order_instructions, edit_lock_token, edit_lock_session_id, edit_lock_expires_at, customer_edit_count, edit_history, total_before_edit'

const REQUEST_COLUMNS =
  'id, restaurant_id, tab_id, session_id, member_session_id, status, order_instructions, items, subtotal, tax, total, items_customer, subtotal_customer, tax_customer, total_customer, items_reviewed, subtotal_reviewed, tax_reviewed, total_reviewed, edit_lock_token, edit_lock_session_id, edit_lock_expires_at, customer_edit_count, edit_history, total_before_edit'

/** HTTP status per refusal. 409 for "somebody else moved it", 403 for "not yours to edit". */
const REFUSAL_HTTP: Record<EditRefusalReason, number> = {
  preparation_started: 409,
  payment_settled: 409,
  payment_in_flight: 409,
  locked_by_other: 409,
  not_editable_status: 409,
  request_accepted: 409,
  request_declined: 409,
}

const REFUSAL_COPY: Record<EditRefusalReason, string> = {
  preparation_started: EDIT_COPY.preparationStarted,
  payment_settled: EDIT_COPY.paymentSettled,
  payment_in_flight: EDIT_COPY.paymentInFlight,
  locked_by_other: EDIT_COPY.lockedByOther,
  not_editable_status: EDIT_COPY.notEditable,
  request_accepted: EDIT_COPY.requestAccepted,
  request_declined: EDIT_COPY.requestDeclined,
}

function refuse(reason: EditRefusalReason) {
  return NextResponse.json(
    { error: REFUSAL_COPY[reason], reason, editable: false },
    { status: REFUSAL_HTTP[reason] },
  )
}

type SupabaseLike = ReturnType<typeof createServerSupabaseClient>

async function loadTarget(
  supabase: SupabaseLike,
  orderId: string,
  restaurantUuid: string,
): Promise<LoadedTarget | null> {
  const { data: order, error: orderError } = await supabase
    .from('orders')
    .select(ORDER_COLUMNS)
    .eq('id', orderId)
    .eq('restaurant_id', restaurantUuid)
    .maybeSingle()
  if (orderError) throw orderError
  if (order) return { surface: 'orders', row: order as Record<string, unknown> }

  const { data: request, error: requestError } = await supabase
    .from('order_requests')
    .select(REQUEST_COLUMNS)
    .eq('id', orderId)
    .eq('restaurant_id', restaurantUuid)
    .maybeSingle()
  if (requestError) throw requestError
  if (request) return { surface: 'order_requests', row: request as Record<string, unknown> }

  return null
}

/**
 * The write must belong to the session that placed the order, not merely to the table.
 *
 * Matches EVERY id the client holds against BOTH columns. The customer app mints two session
 * ids in different storages and nothing syncs them, and the cart submits the tab-context one as
 * both `session_id` and `member_session_id` — so checking one id against one column rejected the
 * customer's own order with a 404. Measured on the deployed worker before this fix; see
 * EditLockAsker in lib/orders/edit-lock.ts.
 */
function sessionOwnsRow(row: Record<string, unknown>, sessionIds: string[]): boolean {
  if (sessionIds.length === 0) return false
  const rowIds = [
    String(row.session_id ?? '').trim(),
    String(row.member_session_id ?? '').trim(),
  ].filter(Boolean)
  return rowIds.some((rowId) => sessionIds.includes(rowId))
}

function refusalFor(target: LoadedTarget, sessionIds: string[], nowMs: number) {
  return target.surface === 'orders'
    ? editRefusalReason(target.row, { sessionIds, nowMs })
    : requestEditRefusalReason(target.row, { sessionIds, nowMs })
}

/**
 * Effective items and total for the surface. On `orders` these are simply the row's own
 * columns; on `order_requests` the precedence lives in one shared place.
 */
function effectiveOf(target: LoadedTarget) {
  if (target.surface === 'orders') {
    return {
      items: Array.isArray(target.row.items) ? (target.row.items as unknown[]) : [],
      subtotal: Number(target.row.subtotal) || 0,
      tax: Number(target.row.tax) || 0,
      total: Number(target.row.total) || 0,
    }
  }
  const effective = effectiveRequestPricing(target.row)
  return {
    items: effective.items,
    subtotal: effective.subtotal,
    tax: effective.tax,
    total: effective.total,
  }
}

type ParsedBody = {
  restaurantId: string
  /** Every id the client holds, deduped. The first is the one recorded as the lock holder. */
  sessionIds: string[]
  lockToken: string
  keep: LineKeepInstruction[] | null
  orderInstructions: string | null
  orderInstructionsProvided: boolean
}

async function parseBody(req: Request): Promise<ParsedBody> {
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>
  const rawKeep = body.keep
  const instructionsProvided =
    Object.prototype.hasOwnProperty.call(body, 'orderInstructions') ||
    Object.prototype.hasOwnProperty.call(body, 'order_instructions')

  return {
    restaurantId: String(body.restaurantId ?? body.restaurant_id ?? '').trim(),
    // `sessionId` stays accepted so an older client keeps working; `sessionIds` is what the
    // current one sends. Repeated values are deduped, and order is preserved so the primary id
    // stays first — that is the one written to edit_lock_session_id.
    sessionIds: normalizeSessionIds([
      body.sessionId as string | undefined,
      body.session_id as string | undefined,
      ...(Array.isArray(body.sessionIds) ? (body.sessionIds as unknown[]) : []).map((v) =>
        v == null ? '' : String(v),
      ),
      ...(Array.isArray(body.session_ids) ? (body.session_ids as unknown[]) : []).map((v) =>
        v == null ? '' : String(v),
      ),
    ]),
    lockToken: String(body.lockToken ?? body.lock_token ?? '').trim(),
    keep: Array.isArray(rawKeep)
      ? rawKeep.map((entry) => {
          const e = (entry ?? {}) as Record<string, unknown>
          return { index: Number(e.index), quantity: Number(e.quantity) }
        })
      : null,
    orderInstructions: instructionsProvided
      ? normalizeOrderInstructions(String(body.orderInstructions ?? body.order_instructions ?? ''))
      : null,
    orderInstructionsProvided: instructionsProvided,
  }
}

/**
 * Shared preamble: resolve the restaurant, load the row, check ownership. Returns either the
 * target or the response to send instead, so each handler stays about its own write.
 */
async function prepare(
  req: Request,
  orderId: string,
  parsed: ParsedBody,
): Promise<{ supabase: SupabaseLike; restaurantUuid: string; target: LoadedTarget } | NextResponse> {
  if (!orderId) {
    return NextResponse.json({ error: 'orderId is required' }, { status: 400 })
  }
  if (!parsed.restaurantId) {
    return NextResponse.json({ error: 'restaurantId is required' }, { status: 400 })
  }
  if (parsed.sessionIds.length === 0) {
    return NextResponse.json({ error: 'sessionId is required' }, { status: 400 })
  }

  const supabase = createServerSupabaseClient()
  const restaurantUuid = await resolveRestaurantUuid(parsed.restaurantId)
  const target = await loadTarget(supabase, orderId, restaurantUuid)

  if (!target) {
    return NextResponse.json({ error: 'Order not found' }, { status: 404 })
  }
  // Same answer for "no such order" and "not your order": a 403 here would confirm that an
  // order exists at an id the caller cannot otherwise see.
  if (!sessionOwnsRow(target.row, parsed.sessionIds)) {
    return NextResponse.json({ error: 'Order not found' }, { status: 404 })
  }

  return { supabase, restaurantUuid, target }
}

/** Re-read after a losing write so the caller is told what actually happened, not a guess. */
async function explainLostWrite(
  supabase: SupabaseLike,
  orderId: string,
  restaurantUuid: string,
  sessionIds: string[],
  nowMs: number,
) {
  const fresh = await loadTarget(supabase, orderId, restaurantUuid)
  if (!fresh) {
    return NextResponse.json({ error: 'Order not found' }, { status: 404 })
  }
  const reason = refusalFor(fresh, sessionIds, nowMs)
  if (reason) return refuse(reason)

  // The row is still editable but our conditional write matched nothing, which leaves one
  // explanation: the token moved. Either it expired and someone re-acquired, or staff nulled
  // it and then moved the order back into an editable state.
  return NextResponse.json(
    { error: EDIT_COPY.lockExpired, reason: 'lock_lost', editable: false },
    { status: 409 },
  )
}

// ---------------------------------------------------------------------------
// POST — acquire or renew the lock
// ---------------------------------------------------------------------------
export async function POST(req: Request, { params }: RouteParams) {
  try {
    const { orderId } = await params
    const parsed = await parseBody(req)
    const prepared = await prepare(req, String(orderId || '').trim(), parsed)
    if (prepared instanceof NextResponse) return prepared
    const { supabase, restaurantUuid, target } = prepared

    const nowMs = Date.now()
    const reason = refusalFor(target, parsed.sessionIds, nowMs)
    if (reason) return refuse(reason)

    const observedToken = String(target.row.edit_lock_token ?? '').trim()
    const newToken = crypto.randomUUID()
    const expiresAt = editLockExpiryFrom(nowMs)

    let claim = supabase
      .from(target.surface)
      .update({
        edit_lock_token: newToken,
        // THE PRIMARY ID, NOT THE LIST. `edit_lock_session_id` is `text`
        // (20260813120000_order_editing_lock.sql), and isEditLockHeldByOther reads it back as a
        // scalar. Writing the array put PostgREST's json_populate_record in the middle: a JSON
        // array into a text column is stored as its JSON TEXT — literally `["a", "b"]` — which
        // matches no id in normalizeSessionIds, so the holder failed its own holder check and
        // every commit was refused 409 locked_by_other. Measured directly:
        //   select pg_typeof(x.edit_lock_session_id), x.edit_lock_session_id
        //     from json_populate_record(null::public.orders,
        //       '{"edit_lock_session_id": ["a","b"]}'::json) x   ->  text | ["a", "b"]
        // One id is sufficient because the READ side compares against every id the client holds:
        // isEditLockHeldByOther asks `normalizeSessionIds(params.sessionIds).includes(holder)`,
        // so recording any one of the caller's ids identifies them for as long as they still hold
        // it. This is what the comment on parsed.sessionIds already said happened.
        edit_lock_session_id: parsed.sessionIds[0] ?? null,
        edit_lock_expires_at: expiresAt,
      })
      .eq('id', target.row.id as string)
      .eq('restaurant_id', restaurantUuid)

    // CAS on the token we just observed. `.eq` never matches NULL in PostgREST, so the
    // no-lock case has to be spelled with `.is` — getting that wrong would make every first
    // acquire fail, which is the kind of thing that looks like "the feature is flaky".
    claim = observedToken
      ? claim.eq('edit_lock_token', observedToken)
      : claim.is('edit_lock_token', null)

    // Re-assert the whole gate inside the write. The check above is a read; staff can move
    // the order between the two.
    claim =
      target.surface === 'orders'
        ? claim
            .in('status', [...EDITABLE_ORDER_STATUSES])
            .in('payment_status', [...EDITABLE_PAYMENT_STATUSES])
        : claim.in('status', [...EDITABLE_REQUEST_STATUSES])

    const { data: locked, error: claimError } = await claim
      .select('id, edit_lock_token, edit_lock_expires_at')
      .maybeSingle()

    if (claimError) {
      console.error('[guest/orders/:id/edit] lock claim failed:', claimError)
      return NextResponse.json({ error: claimError.message }, { status: 500 })
    }
    if (!locked) {
      return explainLostWrite(supabase, String(target.row.id), restaurantUuid, parsed.sessionIds, Date.now())
    }

    const effective = effectiveOf(target)
    return NextResponse.json({
      success: true,
      lockToken: locked.edit_lock_token,
      expiresAt: locked.edit_lock_expires_at,
      surface: target.surface,
      items: effective.items,
      subtotal: effective.subtotal,
      tax: effective.tax,
      total: effective.total,
      orderInstructions: target.row.order_instructions ?? null,
    })
  } catch (err) {
    console.error('[guest/orders/:id/edit] POST failed:', err)
    return NextResponse.json({ error: 'Failed to open this order for editing' }, { status: 500 })
  }
}

// ---------------------------------------------------------------------------
// PATCH — commit the edit
// ---------------------------------------------------------------------------
export async function PATCH(req: Request, { params }: RouteParams) {
  try {
    const { orderId } = await params
    const parsed = await parseBody(req)
    const prepared = await prepare(req, String(orderId || '').trim(), parsed)
    if (prepared instanceof NextResponse) return prepared
    const { supabase, restaurantUuid, target } = prepared

    if (!parsed.lockToken) {
      return NextResponse.json({ error: 'lockToken is required' }, { status: 400 })
    }
    if (!parsed.keep && !parsed.orderInstructionsProvided) {
      return NextResponse.json({ error: 'Nothing to change' }, { status: 400 })
    }

    const nowMs = Date.now()
    const reason = refusalFor(target, parsed.sessionIds, nowMs)
    if (reason) return refuse(reason)

    // The token has to be live AND ours. An expired token is not a lock, and committing on
    // one would let a customer who walked away come back after the kitchen looked at the
    // order and change it anyway.
    if (
      !isEditLockActive(target.row, nowMs) ||
      String(target.row.edit_lock_token ?? '') !== parsed.lockToken
    ) {
      return NextResponse.json(
        { error: EDIT_COPY.lockExpired, reason: 'lock_lost', editable: false },
        { status: 409 },
      )
    }

    const effective = effectiveOf(target)
    const previousTotal = effective.total

    let next = {
      items: effective.items as unknown[],
      subtotal: effective.subtotal,
      tax: effective.tax,
      total: effective.total,
    }
    if (parsed.keep) {
      try {
        next = repriceKeptLines(effective.items, parsed.keep)
      } catch (err) {
        if (err instanceof InvalidEditError) {
          const message = /at least one item/i.test(err.message)
            ? EDIT_COPY.cannotEmpty
            : err.message
          return NextResponse.json({ error: message, reason: 'invalid_edit' }, { status: 400 })
        }
        throw err
      }
    }

    const itemsChanged = Boolean(parsed.keep)
    const previousInstructions = String(target.row.order_instructions ?? '')
    const notesChanged =
      parsed.orderInstructionsProvided && (parsed.orderInstructions ?? '') !== previousInstructions
    const totalChanged = editRequiresReacceptance(previousTotal, next.total)

    if (!itemsChanged && !notesChanged) {
      return NextResponse.json({ error: 'Nothing to change' }, { status: 400 })
    }

    const nowIso = new Date(nowMs).toISOString()
    const staffReviewDiscarded =
      target.surface === 'order_requests' && Array.isArray(target.row.items_reviewed)

    const history = appendEditHistory(target.row.edit_history, {
      edited_at: nowIso,
      previous_total: previousTotal,
      new_total: next.total,
      previous_items: effective.items,
      notes_changed: notesChanged,
      items_changed: itemsChanged,
      ...(staffReviewDiscarded ? { discarded_staff_review: target.row.items_reviewed } : {}),
    })

    const common: Record<string, unknown> = {
      customer_edited_at: nowIso,
      customer_edit_count: (Number(target.row.customer_edit_count) || 0) + 1,
      edit_history: history,
      // The lock is spent by the commit. Holding it afterwards would keep the dashboard
      // saying "customer is editing" for up to three minutes after they finished.
      edit_lock_token: null,
      edit_lock_session_id: null,
      edit_lock_expires_at: null,
      ...(parsed.orderInstructionsProvided ? { order_instructions: parsed.orderInstructions } : {}),
      ...(totalChanged ? { total_before_edit: previousTotal } : {}),
    }

    const patch: Record<string, unknown> =
      target.surface === 'orders'
        ? {
            ...common,
            items: next.items,
            subtotal: next.subtotal,
            tax: next.tax,
            total: next.total,
            requires_reacceptance: totalChanged,
            // Back to review with the new figure. `pending` is the dashboard's New tab and
            // the only status the existing pending -> accepted transition starts from, so
            // staff re-accept through the CAS-protected route they already use.
            ...(totalChanged ? { status: 'pending' } : {}),
          }
        : {
            ...common,
            items_customer: next.items,
            subtotal_customer: next.subtotal,
            tax_customer: next.tax,
            total_customer: next.total,
            // A staff review of the PREVIOUS item list must not survive: Accept reads
            // items_reviewed first, so leaving it would silently discard this edit and
            // charge for an item the customer just removed. Preserved in edit_history.
            items_reviewed: null,
            subtotal_reviewed: null,
            tax_reviewed: null,
            total_reviewed: null,
            requires_reacceptance: staffReviewDiscarded,
          }

    let write = supabase
      .from(target.surface)
      .update(patch)
      .eq('id', target.row.id as string)
      .eq('restaurant_id', restaurantUuid)
      // THE lock. Staff nulling this token is what makes an in-flight edit lose.
      .eq('edit_lock_token', parsed.lockToken)

    write =
      target.surface === 'orders'
        ? write
            .in('status', [...EDITABLE_ORDER_STATUSES])
            .in('payment_status', [...EDITABLE_PAYMENT_STATUSES])
        : write.in('status', [...EDITABLE_REQUEST_STATUSES])

    const { data: updated, error: writeError } = await write
      .select('id, status, total, requires_reacceptance, total_before_edit, customer_edit_count')
      .maybeSingle()

    if (writeError) {
      console.error('[guest/orders/:id/edit] commit failed:', writeError)
      return NextResponse.json({ error: writeError.message }, { status: 500 })
    }
    if (!updated) {
      return explainLostWrite(supabase, String(target.row.id), restaurantUuid, parsed.sessionIds, Date.now())
    }

    // Tab bookkeeping, same recomputation the Accept route does: sum the tab's non-settlement
    // orders. Best effort and after the fact — the edit itself has landed, and failing the
    // request now would tell the customer their change did not happen when it did.
    if (target.surface === 'orders' && totalChanged && target.row.tab_id) {
      const tabId = String(target.row.tab_id)
      const { data: tabOrders, error: tabSumError } = await supabase
        .from('orders')
        .select('total, tab_settlement_for_tab_id')
        .eq('tab_id', tabId)
      if (tabSumError) {
        console.error('[guest/orders/:id/edit] tab total re-sum failed:', tabSumError)
      } else {
        const nextTabTotal = (tabOrders || [])
          .filter((o) => !String(o.tab_settlement_for_tab_id || '').trim())
          .reduce((sum, o) => sum + (Number(o.total) || 0), 0)
        const { error: tabUpdateError } = await supabase
          .from('tabs')
          .update({ total: nextTabTotal })
          .eq('id', tabId)
        if (tabUpdateError) {
          console.error('[guest/orders/:id/edit] tab total update failed:', tabUpdateError)
        }
      }
    }

    return NextResponse.json({
      success: true,
      totalChanged,
      previousTotal,
      total: next.total,
      subtotal: next.subtotal,
      tax: next.tax,
      requiresReacceptance: Boolean(updated.requires_reacceptance),
      status: updated.status,
      message: totalChanged
        ? EDIT_COPY.committedTotalChanged
        : EDIT_COPY.committedNoTotalChange,
    })
  } catch (err) {
    console.error('[guest/orders/:id/edit] PATCH failed:', err)
    return NextResponse.json({ error: 'Failed to save your changes' }, { status: 500 })
  }
}

// ---------------------------------------------------------------------------
// DELETE — release the lock early
// ---------------------------------------------------------------------------
export async function DELETE(req: Request, { params }: RouteParams) {
  try {
    const { orderId } = await params
    const parsed = await parseBody(req)
    const prepared = await prepare(req, String(orderId || '').trim(), parsed)
    if (prepared instanceof NextResponse) return prepared
    const { supabase, restaurantUuid, target } = prepared

    if (!parsed.lockToken) {
      return NextResponse.json({ error: 'lockToken is required' }, { status: 400 })
    }

    // Conditioned on the caller's own token, so releasing a lock that has already passed to
    // somebody else is impossible. Matching nothing is not an error: the lock is not held by
    // this caller either way, which is the state they asked for.
    const { data: released, error } = await supabase
      .from(target.surface)
      .update({ edit_lock_token: null, edit_lock_session_id: null, edit_lock_expires_at: null })
      .eq('id', target.row.id as string)
      .eq('restaurant_id', restaurantUuid)
      .eq('edit_lock_token', parsed.lockToken)
      .select('id')
      .maybeSingle()

    if (error) {
      console.error('[guest/orders/:id/edit] release failed:', error)
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    return NextResponse.json({ success: true, released: Boolean(released) })
  } catch (err) {
    console.error('[guest/orders/:id/edit] DELETE failed:', err)
    return NextResponse.json({ error: 'Failed to release the edit lock' }, { status: 500 })
  }
}
