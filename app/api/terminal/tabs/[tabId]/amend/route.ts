/**
 * POST /api/terminal/tabs/{tabId}/amend -- change the quantity of a line before it's cooked.
 *
 * The whole edit-before-prep feature was blocked on this route not existing. Max verified only
 * lines and settle exist under terminal/tabs/[tabId]/ -- see the migration
 * (20260829150000_amend_order_lines_function.sql) for the atomicity design this wraps.
 *
 * ONE RPC CALL PER ATTEMPT, wrapped in the same bounded order-number retry
 * insertWithOrderNumber() already uses: amend_order_lines() does the real work (void-and-
 * replace, per line, one transaction) and either returns cleanly or raises. A raised unique-
 * index violation on order_number means the whole transaction rolled back -- nothing voided,
 * nothing inserted -- so retrying the WHOLE call with a freshly read number is safe. Any other
 * error is not retried.
 */
import { NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { requireTerminalAuth, validateTerminalRecord } from '@/lib/terminal-auth'
import { requireFeature } from '@/lib/features/get-restaurant-features'
import { nextOrderNumber, isOrderNumberCollision } from '@/lib/orders/order-number'
import { broadcastLineChanged } from '@/lib/stations/realtime-invalidate'
import { consumeAuthorizationToken } from '@/lib/terminal-auth/consume-authorization-token'

export const dynamic = 'force-dynamic'

const MAX_ORDER_NUMBER_ATTEMPTS = 6

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
}

/**
 * Long enough for a real sentence, short enough that nobody pastes a conversation into it.
 * A void reason is read later by somebody reconciling a bill, not by a machine.
 */
const MAX_VOID_REASON_LENGTH = 280

type CleanAmendment = { line_id: string; new_quantity: number }

export async function POST(req: Request, { params }: { params: Promise<{ tabId: string }> }) {
  try {
    const terminal = await requireTerminalAuth(req)
    const supabase = createServerSupabaseClient()
    await validateTerminalRecord(supabase, terminal)

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

    const { tabId } = await params
    if (!tabId || !isUuid(tabId)) {
      return NextResponse.json({ error: 'tabId must be a valid UUID' }, { status: 400 })
    }

    const body = (await req.json().catch(() => ({}))) as {
      amendments?: unknown
      staff_user_id?: unknown
      staffUserId?: unknown
      authorization_token_id?: unknown
      authorizationTokenId?: unknown
      void_reason?: unknown
      voidReason?: unknown
    }
    const rawAmendments = Array.isArray(body.amendments) ? body.amendments : []
    if (rawAmendments.length === 0) {
      return NextResponse.json({ error: 'amendments must be a non-empty array' }, { status: 400 })
    }

    const amendments: CleanAmendment[] = []
    for (const raw of rawAmendments) {
      const entry = raw as { line_id?: unknown; new_quantity?: unknown }
      const lineId = String(entry.line_id ?? '').trim()
      const quantity = Number(entry.new_quantity)

      if (!lineId || !isUuid(lineId)) {
        return NextResponse.json(
          { error: 'Every amendment needs a valid line_id', code: 'INVALID_LINE_ID' },
          { status: 400 },
        )
      }
      if (!Number.isFinite(quantity) || quantity < 0) {
        return NextResponse.json(
          {
            error: `new_quantity for line ${lineId} must be a number >= 0`,
            code: 'INVALID_QUANTITY',
            line_id: lineId,
          },
          { status: 400 },
        )
      }
      amendments.push({ line_id: lineId, new_quantity: quantity })
    }

    /**
     * ============================================================================================
     * A REDUCTION IS A VOID, AND A VOID NEEDS A SECOND PERSON
     * ============================================================================================
     *
     * WHY REDUCTION AND NOT JUST ZERO. The RPC calls `new_quantity = 0` "a pure void", and gating
     * only that would leave an obvious way round it: reduce 3 to 1 instead of 3 to 0 and two
     * dishes leave the bill with no PIN. A control with a bypass that obvious is not a control, so
     * ANY reduction is gated — 3→0 and 3→1 alike.
     *
     * An INCREASE is not gated. It adds to what the customer owes rather than writing food off,
     * which is the authority this exists to check.
     *
     * THE CURRENT QUANTITIES ARE READ HERE, and there is a race worth naming: a line could change
     * between this read and the RPC. The window is small (amend is the only writer and it is
     * per-terminal) and the exposure is one-sided in the safe direction — a stale HIGHER quantity
     * asks for a PIN that turned out not to be needed. Closing it completely means moving the test
     * inside `amend_order_lines`, which is a signature change to a money-path function and is a
     * deliberate follow-up rather than something to slip in here.
     */
    const { data: currentLines, error: currentLinesError } = await supabase
      .from('order_lines')
      .select('id, quantity')
      .eq('restaurant_id', terminal.restaurantId)
      .eq('tab_id', tabId)
      .in('id', amendments.map((a) => a.line_id))

    if (currentLinesError) {
      return NextResponse.json({ error: 'Failed to read the lines being amended' }, { status: 500 })
    }

    const quantityById = new Map(
      (currentLines ?? []).map((l) => [String(l.id), Number(l.quantity)]),
    )
    const reducesALine = amendments.some((a) => {
      const current = quantityById.get(a.line_id)
      // An unknown line is NOT treated as a reduction: the RPC scopes and refuses it by tab and
      // restaurant, and inventing a void here would demand a PIN for a line that cannot be voided.
      return typeof current === 'number' && a.new_quantity < current
    })

    const staffUserId = String(body.staff_user_id ?? body.staffUserId ?? '').trim()
    const authorizationTokenId = String(
      body.authorization_token_id ?? body.authorizationTokenId ?? '',
    ).trim()
    /**
     * The reason, required on a void and stored on order_line_events — the FULFILMENT record.
     * Never on `order_lines.line_note`: that is the kitchen prep note, and `amend_order_lines`
     * copies it onto the replacement line, which would put "customer changed their mind" in front
     * of a chef on the next amendment of the same dish.
     */
    const voidReason = String(body.void_reason ?? body.voidReason ?? '').trim()

    let attributedStaffUserId: string | null = null

    if (reducesALine) {
      if (!authorizationTokenId || !staffUserId) {
        return NextResponse.json(
          {
            error:
              'Taking items off a bill needs a manager or owner PIN. Authorize and try again.',
            code: 'VOID_NEEDS_AUTHORIZATION',
          },
          { status: 403 },
        )
      }
      if (!voidReason) {
        return NextResponse.json(
          { error: 'Give a reason for removing these items.', code: 'VOID_NEEDS_REASON' },
          { status: 400 },
        )
      }
      if (voidReason.length > MAX_VOID_REASON_LENGTH) {
        return NextResponse.json(
          {
            error: `That reason is too long — keep it under ${MAX_VOID_REASON_LENGTH} characters.`,
            code: 'VOID_REASON_TOO_LONG',
          },
          { status: 400 },
        )
      }

      // Fails closed on a thrown error as well as a rejected token — consuming also writes an
      // authorization_events row, and letting that escape would answer 401 and tell staff nothing.
      let consumed: Awaited<ReturnType<typeof consumeAuthorizationToken>>
      try {
        consumed = await consumeAuthorizationToken(supabase, {
          tokenId: authorizationTokenId,
          expectedUserId: staffUserId,
          expectedRestaurantId: terminal.restaurantId,
          expectedTerminalId: terminal.terminalId,
          expectedPurpose: 'line_void',
        })
      } catch (authErr) {
        console.error('[terminal/tabs/amend] authorization check failed', authErr)
        consumed = { ok: false, reason: 'not_found' }
      }

      if (!consumed.ok) {
        return NextResponse.json(
          {
            error: 'Authorization could not be verified',
            code: 'AUTHORIZATION_INVALID',
            reason: consumed.reason,
          },
          { status: 403 },
        )
      }
      attributedStaffUserId = staffUserId
    }

    let lastError: { code?: string | null; message?: string | null } | null = null
    let lastData: unknown = null

    for (let attempt = 1; attempt <= MAX_ORDER_NUMBER_ATTEMPTS; attempt += 1) {
      const orderNumber = await nextOrderNumber(supabase, terminal.restaurantId)
      const { data, error } = await supabase.rpc('amend_order_lines', {
        p_restaurant_id: terminal.restaurantId,
        p_tab_id: tabId,
        p_order_number: orderNumber,
        p_actor_kind: 'terminal',
        // THE FIX. This was hardcoded null, so a void recorded no human at all -- only that
        // "a terminal" did it. It is now the PIN-verified manager or owner from the gate above,
        // and stays null for an amendment that reduces nothing, where no PIN was required.
        p_actor_user_id: attributedStaffUserId,
        p_amendments: amendments,
      })

      lastData = data
      lastError = error

      if (!error) break
      if (!isOrderNumberCollision(error)) break

      console.warn(
        `[terminal/tabs/amend] order #${orderNumber} was taken at ${terminal.restaurantId} -- ` +
          `attempt ${attempt}/${MAX_ORDER_NUMBER_ATTEMPTS}, retrying the whole amendment.`,
      )
    }

    if (lastError) {
      console.error('[terminal/tabs/amend] RPC failed', lastError)
      return NextResponse.json(
        { error: 'Could not apply this amendment', code: 'AMEND_FAILED' },
        { status: 502 },
      )
    }

    const result = lastData as {
      order_id: string | null
      order_number: number | null
      applied: Array<{ line_id: string; action: 'voided' | 'replaced'; new_line_id?: string }>
      refused: Array<{ line_id: string; reason: string }>
    }

    /**
     * THE REASON, WRITTEN ONTO THE VOID EVENTS THE RPC JUST CREATED.
     *
     * WHY HERE AND NOT INSIDE `amend_order_lines`. The reason would ideally ride into the RPC and
     * be written in the same transaction as the void. Doing that means adding a parameter, and
     * because Postgres keys a function on its argument list, `CREATE OR REPLACE` with an extra
     * parameter creates an OVERLOAD rather than replacing it -- leaving two live versions of a
     * money-path function for PostgREST to choose between. Correcting that needs a DROP and
     * recreate of the function that voids and re-inserts order lines, which is a deliberate
     * change of its own and not something to slip into this one.
     *
     * SO THIS IS A SECOND WRITE, AND ITS FAILURE MODE IS HONEST: if it fails, the void still
     * happened and the reason is absent -- which the column already documents as NOT RECORDED
     * rather than "no reason given". A missing reason is a gap in the record; a wrong one, or a
     * void that silently didn't happen because a metadata write failed, would be worse.
     *
     * SCOPED TIGHTLY: only the lines this call voided, only their `voided` events, and only where
     * no reason is set -- so a re-run cannot overwrite an earlier void's reason on a line that has
     * been voided before.
     */
    const voidedLineIds = result.applied
      .filter((a) => a.action === 'voided')
      .map((a) => a.line_id)

    if (voidReason && voidedLineIds.length > 0) {
      const { error: reasonError } = await supabase
        .from('order_line_events')
        .update({ void_reason: voidReason })
        .eq('restaurant_id', terminal.restaurantId)
        .in('order_line_id', voidedLineIds)
        .eq('to_state', 'voided')
        .is('void_reason', null)

      if (reasonError) {
        console.error('[terminal/tabs/amend] void reason not recorded', {
          tabId,
          line_ids: voidedLineIds,
          error: reasonError,
        })
      }
    }

    /**
     * A voided/replaced line changes what every station board and every terminal with this tab
     * open is showing -- an amend can drop a line from someone's outstanding count or ready
     * count exactly the way a bump can. Only when something actually moved: a fully-refused
     * amendment (`applied` empty) changed nothing, and an invalidation for it would just cost
     * every listening screen a no-op refetch.
     */
    if (result.applied.length > 0) {
      await broadcastLineChanged(supabase, terminal.restaurantId)
    }

    return NextResponse.json({
      success: true,
      order_id: result.order_id,
      order_number: result.order_number,
      applied: result.applied,
      refused: result.refused,
    })
  } catch (err: unknown) {
    if (err instanceof Response) return err
    const message = err instanceof Error ? err.message : 'Internal server error'
    console.error('[terminal/tabs/amend POST]', message)
    return NextResponse.json({ error: 'Failed to amend the tab' }, { status: 500 })
  }
}
