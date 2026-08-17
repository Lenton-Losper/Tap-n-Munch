import { NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { requireTerminalAuth, validateTerminalRecord } from '@/lib/terminal-auth'
import { getPaymentProjections } from '@/lib/payments/get-payment-projection'
import {
  CARD_IN_FLIGHT_TIMEOUT_SECONDS,
  isCardPaymentStillInFlight,
  isCashSettleablePaymentStatus,
  isClaimablePaymentStatus,
  owesMoney,
  secondsSincePush,
} from '@/lib/payments/payment-integrity'
import {
  buildMemberNameLookup,
  resolveOrderMemberName,
} from '@/lib/tabs/resolve-order-member-names'

export const dynamic = 'force-dynamic'

export async function GET(req: Request) {
  try {
    const terminal = await requireTerminalAuth(req)
    const supabase = createServerSupabaseClient()
    await validateTerminalRecord(supabase, terminal)

    if (!terminal.permissions.includes('orders:read')) {
      return NextResponse.json({ error: 'Missing permission' }, { status: 403 })
    }

    const { data: tables, error } = await supabase
      .from('restaurant_tables')
      .select(`
        id,
        table_number,
        status,
        tabs!inner(
          id,
          status,
          total,
          payment_preference,
          members,
          orders(
            id,
            order_number,
            total,
            status,
            payment_status,
            terminal_pushed_at,
            items,
            placed_at,
            member_session_id,
            session_id
          )
        )
      `)
      .eq('restaurant_id', terminal.restaurantId)
      .eq('status', 'occupied')
      .in('tabs.status', ['open', 'ready_to_pay'])
      .order('table_number', { ascending: true })

    if (error) {
      console.error('[terminal/tables GET]', error)
      return NextResponse.json({ error: 'Failed to load tables' }, { status: 500 })
    }

    const allOrderIds = (tables ?? []).flatMap((table: any) => {
      const tab = table.tabs?.[0] ?? null
      const orders = tab?.orders ?? []
      return orders.map((o: any) => String(o.id)).filter(Boolean)
    })

    const projections = await getPaymentProjections(
      supabase,
      terminal.restaurantId,
      allOrderIds,
    )

    // One clock for the whole response, so two orders pushed at the same moment cannot be
    // reported on opposite sides of the timeout within a single payload.
    const now = new Date()
    const cardInFlight = (order: any) =>
      isCardPaymentStillInFlight(order.payment_status, order.terminal_pushed_at, now)

    // Compute canClose and unpaidTotal server-side
    const enriched = (tables ?? []).map((table: any) => {
      const tab = table.tabs?.[0] ?? null
      if (!tab) return { ...table, tab: null, canClose: false }

      /**
       * #288. The terminal renders `{item.member_name || 'Guest'}` and nothing ever sent
       * `member_name`, so every order on every table read as "Guest" -- which makes the
       * per-order "Settle Selected" flow unusable as intended, because staff cannot tell which
       * orders are whose. Resolved here from `tabs.members[]`; an unmatched order gets `null`
       * and the terminal's own fallback handles it. Never guessed.
       */
      const memberNames = buildMemberNameLookup(tab.members)

      const orders = (tab.orders ?? []).map((order: any) => {
        const projection = projections.get(String(order.id)) ?? null
        // The raw ids are NOT spread out to the terminal: `...order` below would carry them,
        // so they are stripped and replaced by the name. A session id is a credential
        // (`ownsOrder` makes knowing one the whole authorisation) and staff have no use for it.
        const { member_session_id: _m, session_id: _s, ...safeOrder } = order
        void _m
        void _s
        return {
          ...safeOrder,
          member_name: resolveOrderMemberName(order, memberNames),
          // Distinct from orders.payment_status (paid/pending settlement flag).
          payment_status_derived: projection?.paymentStatus ?? null,
          refunded_amount: projection?.refundedAmount ?? 0,
          // Per-order settlement affordances, so the terminal can render and disable the
          // cash action without duplicating the status or timeout rules client-side.
          can_settle_card: isClaimablePaymentStatus(order.payment_status),
          // Cash is blocked only while a card attempt is genuinely live; once the attempt
          // times out the button becomes available again with no staff intervention.
          can_settle_cash:
            isCashSettleablePaymentStatus(order.payment_status) ||
            (String(order.payment_status ?? '').trim().toLowerCase() === 'terminal_pending' &&
              !cardInFlight(order)),
          card_payment_in_flight: cardInFlight(order),
          card_in_flight_seconds: cardInFlight(order)
            ? Math.round(secondsSincePush(order.terminal_pushed_at, now) ?? 0)
            : null,
        }
      })
      // Everything still OWED counts, not just what a card settlement happens to be able to
      // claim. cash_pending, failed and terminal_pending orders are unpaid money; excluding
      // them understated the tab and let can_close report true over genuine debt. Cancelled
      // (and any other terminal status) still correctly falls out.
      const unpaidOrders = orders.filter((o: any) => owesMoney(o.payment_status))
      const unpaidTotal = unpaidOrders.reduce(
        (sum: number, o: any) => sum + Number(o.total), 0
      )
      const canClose = unpaidOrders.length === 0

      return {
        id: table.id,
        table_number: table.table_number,
        status: table.status,
        tab: {
          id: tab.id,
          status: tab.status,
          total: tab.total,
          unpaid_total: unpaidTotal,
          payment_preference: tab.payment_preference,
          orders,
        },
        can_close: canClose,
      }
    })

    return NextResponse.json({
      tables: enriched,
      // Lets the terminal show an accurate countdown without hardcoding the server's value.
      card_in_flight_timeout_seconds: CARD_IN_FLIGHT_TIMEOUT_SECONDS,
    })
  } catch (err: unknown) {
    if (err instanceof Response) return err
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
}
