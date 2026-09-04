/**
 * POST /api/terminal/tables/{tableId}/walkout-close — close a table whose tab still owes money.
 *
 * ============================================================================================
 * WHY THIS IS NOT THE ORDINARY CLOSE ROUTE WITH A FLAG
 * ============================================================================================
 *
 * `POST .../close` exists and is gated on `orders:update`, which EVERY terminal JWT carries
 * (TERMINAL_JWT_PERMISSIONS). That is right for closing a table that has been paid: it is a
 * housekeeping action any waiter finishing a table performs.
 *
 * Closing a table that still owes money is a different act. It writes off a debt, and the person
 * holding the terminal is the person the money was owed to. Adding a `walkout: true` flag to the
 * existing route would mean one endpoint with two authorities, and the weaker one already reachable
 * by every device in the estate — the exact shape that lets a gate be bypassed by omitting a field.
 *
 * So it is its own route, with its own purpose (`walkout_close`) and its own permission
 * (`tabs:close_unpaid`, manager and owner only — see lib/terminal-auth/purpose-permissions.ts for
 * why no existing permission fitted).
 *
 * ============================================================================================
 * WHAT IT MUST NEVER DO, AND WHY THAT IS WRITTEN DOWN
 * ============================================================================================
 *
 * IT WRITES NO PAYMENT. Not `paid_at`, not `completed_at`, not `payment_status`, and no
 * payment_events row. Before 2026-07-30 Close Table bulk-stamped paid_at/completed_at across a
 * table's orders, and three orders on production were left marked paid with no payment behind
 * them — money that was never collected, recorded as collected, in a system whose reports are
 * built on exactly those columns.
 *
 * A walkout is the case where that temptation is strongest: the table is being cleared, and
 * "settled" is one column away. The distinction this route keeps is that the TAB closes and the
 * ORDERS stay honestly unpaid, so the loss is visible in every report rather than absorbed.
 *
 * Verified by effect against production rather than asserted here — the tab closes, the unpaid
 * orders come back with paid_at still null, and payment_events is unchanged.
 *
 * ============================================================================================
 * THE GATE REFUSES BEFORE ANYTHING CLOSES
 * ============================================================================================
 *
 * Token verification happens BEFORE close_table_session is called. A gate that refuses after
 * closing has not gated anything — the table is already turned and the debt already written off,
 * and the refusal is a message about something that has happened.
 */
import { NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { requireTerminalAuth, validateTerminalRecord } from '@/lib/terminal-auth'
import { consumeAuthorizationToken } from '@/lib/terminal-auth/consume-authorization-token'
import { guardTableClose } from '@/lib/tabs/pending-order-requests'
import { closeTableSession } from '@/lib/session-manager'
import { owesMoney } from '@/lib/payments/payment-integrity'

export const dynamic = 'force-dynamic'

/** Long enough to say what happened, short enough that it is a reason and not a paragraph. */
const REASON_MIN = 3
const REASON_MAX = 500

export async function POST(req: Request, { params }: { params: Promise<{ tableId: string }> }) {
  try {
    const terminal = await requireTerminalAuth(req)
    const supabase = createServerSupabaseClient()
    await validateTerminalRecord(supabase, terminal)

    const { tableId } = await params
    const body = (await req.json().catch(() => ({}))) as {
      reason?: unknown
      staff_user_id?: unknown
      authorization_token_id?: unknown
    }

    /**
     * A REASON IS REQUIRED, and it is checked before the token is consumed.
     *
     * Consuming a token is single-use and irreversible. Refusing a malformed request AFTER burning
     * the manager's authorisation would make them walk back to the terminal and PIN in again for a
     * mistake the device could have caught, and the second attempt is where people start sharing
     * PINs.
     */
    const reason = String(body.reason ?? '').trim()
    if (reason.length < REASON_MIN || reason.length > REASON_MAX) {
      return NextResponse.json(
        {
          error: `A reason is required, between ${REASON_MIN} and ${REASON_MAX} characters.`,
          code: 'REASON_REQUIRED',
        },
        { status: 400 },
      )
    }

    const staffUserId = String(body.staff_user_id ?? '').trim()
    const authorizationTokenId = String(body.authorization_token_id ?? '').trim()
    if (!staffUserId || !authorizationTokenId) {
      // NOT OPTIONAL HERE, unlike cash settlement. There is no version of this action that is
      // acceptable unattributed: the whole point is that a named person authorised the write-off.
      return NextResponse.json(
        {
          error: 'A manager or owner must authorise a walkout.',
          code: 'AUTHORIZATION_REQUIRED',
        },
        { status: 403 },
      )
    }

    /**
     * THE GATE. Before the guard, before the close, before anything is written.
     *
     * Fails closed on a thrown error as well as a rejected token: consuming a token also writes an
     * authorization_events row, and letting that write escape would land in the generic catch and
     * answer 500, which tells staff nothing about why the table is still open.
     */
    let consumed: Awaited<ReturnType<typeof consumeAuthorizationToken>>
    try {
      consumed = await consumeAuthorizationToken(supabase, {
        tokenId: authorizationTokenId,
        expectedUserId: staffUserId,
        expectedRestaurantId: terminal.restaurantId,
        expectedTerminalId: terminal.terminalId,
        expectedPurpose: 'walkout_close',
      })
    } catch (authErr) {
      console.error('[terminal/tables/walkout-close] authorization check failed', authErr)
      consumed = { ok: false, reason: 'not_found' }
    }

    if (!consumed.ok) {
      return NextResponse.json(
        {
          error: 'That PIN cannot authorise a walkout.',
          code: 'AUTHORIZATION_INVALID',
          reason: consumed.reason,
        },
        { status: 403 },
      )
    }

    /**
     * The same preflight the ordinary close performs (#120): a round still awaiting staff review
     * is not in `orders`, and closing over it re-inflates a closed tab the moment somebody presses
     * Accept. Shared rather than restated -- two routes doing one job with the rule written into
     * only one of them is how the dashboard's close went unguarded.
     */
    const guard = await guardTableClose(supabase, {
      restaurantId: terminal.restaurantId,
      tableId,
    })
    if (guard.blocked) {
      return NextResponse.json(guard.body, { status: guard.status })
    }

    /**
     * WHAT WAS OWED, CAPTURED BEFORE THE CLOSE.
     *
     * Read first because the close settles the tab, and afterwards there is no way to reconstruct
     * what was outstanding at the moment somebody decided to write it off. A walkout whose amount
     * cannot be stated is not an audit trail, it is a note that something happened.
     */
    const { data: tabs, error: tabsError } = await supabase
      .from('tabs')
      .select('id, total, table_number')
      .eq('restaurant_id', terminal.restaurantId)
      .eq('table_id', tableId)
      .in('status', ['open', 'ready_to_pay', 'active'])
    if (tabsError) {
      console.error('[terminal/tables/walkout-close] could not read tabs', tabsError)
      return NextResponse.json({ error: 'Could not read this table' }, { status: 500 })
    }

    const tabIds = (tabs ?? []).map((t) => String(t.id))
    let unpaidOrderIds: string[] = []
    let unpaidTotal = 0
    if (tabIds.length > 0) {
      const { data: orders, error: ordersError } = await supabase
        .from('orders')
        .select('id, total, payment_status')
        .in('tab_id', tabIds)
      if (ordersError) {
        console.error('[terminal/tables/walkout-close] could not read orders', ordersError)
        return NextResponse.json({ error: 'Could not read this table' }, { status: 500 })
      }
      const unpaid = (orders ?? []).filter((o) => owesMoney(o.payment_status))
      unpaidOrderIds = unpaid.map((o) => String(o.id))
      unpaidTotal = unpaid.reduce((sum, o) => sum + Number(o.total ?? 0), 0)
    }

    /**
     * The close itself is the EXISTING one, unchanged and unwrapped.
     *
     * close_table_session() settles the tab, expires customer sessions and bumps the table version.
     * It does not touch `orders` at all, which is precisely the property that must hold — so this
     * route calls it rather than reimplementing a close that could drift from it.
     */
    await closeTableSession({
      supabase,
      restaurantId: terminal.restaurantId,
      tableId,
      closedBy: staffUserId,
      source: 'terminal_walkout',
    })

    /**
     * The audit row that makes this a walkout rather than an unexplained close: WHO (a users.id,
     * not a device), WHY (their words), and HOW MUCH was left unpaid.
     *
     * Written after the close, deliberately: an audit row for a close that then failed would be
     * worse than a missing one. A failure here is logged and does not fail the request — the table
     * is already turned, and answering non-2xx would have staff close it a second time.
     */
    const { error: auditError } = await supabase.from('audit_logs').insert({
      restaurant_id: terminal.restaurantId,
      action: 'tab.walkout_closed',
      entity_type: 'restaurant_tables',
      entity_id: tableId,
      metadata: {
        closed_by_user_id: staffUserId,
        authorization_token_id: authorizationTokenId,
        reason,
        tab_ids: tabIds,
        table_number: (tabs ?? [])[0]?.table_number ?? null,
        unpaid_order_ids: unpaidOrderIds,
        unpaid_order_count: unpaidOrderIds.length,
        amount_written_off: unpaidTotal,
        terminal_id: terminal.terminalId,
        device_serial: terminal.deviceSerial,
        source: 'terminal_walkout',
        // Stated in the record itself, so a later reader does not have to infer it from absence.
        note: 'No payment was recorded. Orders remain unpaid by design.',
        closed_at: new Date().toISOString(),
      },
    })
    if (auditError) {
      console.error('[terminal/tables/walkout-close] audit insert failed', auditError)
    }

    return NextResponse.json({
      success: true,
      closed_by_user_id: staffUserId,
      reason,
      unpaid_order_count: unpaidOrderIds.length,
      amount_written_off: unpaidTotal,
      audit_recorded: !auditError,
    })
  } catch (err: unknown) {
    if (err instanceof Response) return err
    console.error('[terminal/tables/walkout-close]', err)
    return NextResponse.json({ error: 'Failed to close this table' }, { status: 500 })
  }
}
