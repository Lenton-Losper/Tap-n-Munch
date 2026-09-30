/**
 * THE ORDINARY CLOSE DOES NOT WRITE OFF A DEBT (RC-RACES, 2026-09-30, E7 / D1).
 *
 * `POST /api/terminal/tables/{id}/close` is gated on `orders:update`, which every terminal JWT
 * carries. The walkout-close route's header records why closing a table that still owes money is a
 * different act -- a manager-PIN write-off -- and says the ordinary close is "right for closing a
 * table that has been paid". Nothing on the server enforced that: the terminal's own preflight
 * (closeTableRefusals rule 5) refused an owed tab, but a round added by another waiter after that
 * preflight -- or a payment that was still being recorded -- reached close_table_session and the
 * tab was settled over unpaid food with no PIN and no write-off record.
 *
 * The figure is the one financial projection (lib/orders/order-financials.ts, contract C1), so a
 * cancelled order, a voided line and an item already paid by allocation owe nothing here exactly as
 * they owe nothing on the terminal's screen. FAILS CLOSED: a projection that cannot be read is not
 * permission to close.
 */
import {
  FINANCIAL_ORDER_COLUMNS,
  projectOrderRows,
  type FinancialOrderInput,
} from '@/lib/orders/order-financials'

type Supabase = { from: (table: string) => any }

export type CloseBalanceVerdict =
  | { blocked: false }
  | { blocked: true; status: number; body: Record<string, unknown> }

export async function guardCloseOutstandingBalance(
  supabase: Supabase,
  params: { restaurantId: string; tableId: string },
): Promise<CloseBalanceVerdict> {
  const unreadable: CloseBalanceVerdict = {
    blocked: true,
    status: 503,
    body: { error: 'Could not check what this table still owes. Try again.', code: 'OUTSTANDING_BALANCE_UNREADABLE' },
  }
  try {
    const { data: tabs, error: tabsError } = await supabase
      .from('tabs')
      .select('id')
      .eq('restaurant_id', params.restaurantId)
      .eq('table_id', params.tableId)
      .in('status', ['open', 'ready_to_pay', 'active'])
    if (tabsError) return unreadable
    const tabIds = (tabs ?? []).map((t: { id: unknown }) => String(t.id))
    if (tabIds.length === 0) return { blocked: false }

    const { data: orders, error: ordersError } = await supabase
      .from('orders')
      .select(FINANCIAL_ORDER_COLUMNS)
      .eq('restaurant_id', params.restaurantId)
      .in('tab_id', tabIds)
    if (ordersError) return unreadable
    const rows = (orders ?? []) as FinancialOrderInput[]
    if (rows.length === 0) return { blocked: false }

    const financials = await projectOrderRows(supabase as never, rows)
    const owing = rows
      .map((o) => ({ id: String(o.id), cents: financials.get(String(o.id))?.outstandingCents ?? 0 }))
      .filter((o) => o.cents > 0)
    if (owing.length === 0) return { blocked: false }

    return {
      blocked: true,
      status: 409,
      body: {
        error:
          'This table still owes money. Take payment first, or close it as a walkout with a ' +
          'manager PIN.',
        code: 'TAB_HAS_OUTSTANDING_BALANCE',
        outstanding_cents: owing.reduce((s, o) => s + o.cents, 0),
        order_ids: owing.map((o) => o.id),
      },
    }
  } catch (err) {
    console.error('[guardCloseOutstandingBalance] could not project the table', err)
    return unreadable
  }
}
