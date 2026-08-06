/**
 * Issue #176 — what a merchant is told before clearing a table.
 *
 * Clearing settles the tab, expires every customer session and bumps the table's session
 * version, so the next scan of the same printed QR starts fresh. That part is safe.
 *
 * The part that is NOT safe to do silently: the close route detaches UNPAID orders from the
 * table with payment_status, paid_at, status and completed_at deliberately untouched — nothing
 * is written off as revenue — but it sets is_closed=true, and the dashboard reads through
 * is_closed=false. So money still owed stays RECORDED and becomes INVISIBLE at the same moment.
 *
 * Today that gap is narrow because nothing in the dashboard calls the route. A one-click button
 * widens it, which is why an unpaid count and an explicit confirmation are not optional here.
 */
import { isPaidPaymentStatus } from '@/lib/payments/payment-integrity'
import type { OrderRestaurantScope } from '@/lib/supabase/restaurants'

export type ClearTableOrder = {
  id?: string | number
  payment_status?: string | null
  total?: number | string | null
}

/** The slice of the Supabase client this needs, so the query itself is testable. */
export type ClearTableQueryClient = {
  from: (table: string) => {
    select: (columns: string) => {
      eq: (column: string, value: unknown) => {
        eq: (column: string, value: unknown) => {
          eq: (
            column: string,
            value: unknown,
          ) => PromiseLike<{ data: ClearTableOrder[] | null; error: { message: string } | null }>
        }
      }
    }
  }
}

/**
 * The orders the close route would act on, fetched the SAME way the route fetches them.
 *
 * This exists as its own function because it was the one piece of #176 nothing covered:
 * `summariseClearImpact` was unit-tested with arrays, and the end-to-end test drove the route
 * handler directly. The seam between the button and the money check — the client-side query —
 * was the only untested new code, and it was the piece that broke.
 *
 * `scope.restaurantId` is passed explicitly, NOT the scope object. `resolveOrderRestaurantScope`
 * returns `{ restaurantId, firebaseRestaurantId }`, and handing that whole object to a filter
 * throws "object is not iterable" at query-build time — before any request is sent.
 *
 * Filters match the route exactly (restaurant, table number, is_closed=false) and deliberately
 * do NOT exclude completed/cancelled orders: the route does not either, so excluding them here
 * would make the confirmation disagree with what the server acts on.
 */
export async function fetchOpenOrdersForTable(
  client: ClearTableQueryClient,
  scope: OrderRestaurantScope,
  tableNumber: number,
): Promise<ClearTableOrder[]> {
  const { data, error } = await client
    .from('orders')
    .select('id, payment_status, total')
    .eq('restaurant_id', scope.restaurantId)
    .eq('table_number', tableNumber)
    .eq('is_closed', false)

  if (error) throw new Error(error.message)
  return data ?? []
}

export type ClearTableImpact = {
  total: number
  paid: number
  unpaid: number
  unpaidTotal: number
  /** True when clearing would hide money still owed. The confirmation MUST be explicit here. */
  requiresConfirmation: boolean
}

/**
 * Partition with the shared normaliser, never a raw equality check.
 *
 * The close route itself partitions in JS for exactly this reason: PostgREST comparisons are
 * byte-exact, so a stray 'Paid' or ' paid' is classified wrongly by the database. If this
 * summary counted differently from the route, the confirmation would state one thing while the
 * server did another — and a confirmation that lies is worse than no confirmation at all.
 */
export function summariseClearImpact(orders: ClearTableOrder[] | null | undefined): ClearTableImpact {
  const list = orders ?? []
  let paid = 0
  let unpaid = 0
  let unpaidTotal = 0

  for (const order of list) {
    if (isPaidPaymentStatus(order.payment_status)) {
      paid += 1
      continue
    }
    unpaid += 1
    const amount = Number(order.total)
    if (Number.isFinite(amount)) unpaidTotal += amount
  }

  return {
    total: list.length,
    paid,
    unpaid,
    unpaidTotal,
    requiresConfirmation: unpaid > 0,
  }
}

/** Namibian dollar, matching how totals are shown elsewhere in the dashboard. */
export function formatClearAmount(amount: number): string {
  return `N$${(Number.isFinite(amount) ? amount : 0).toFixed(2)}`
}

/**
 * The wording the merchant sees. Deliberately different in kind, not just in degree, when money
 * is involved — "3 orders will be completed" and "1 order for N$120.00 is unpaid" must not read
 * like variations of the same sentence.
 */
export function clearTableConfirmationMessage(impact: ClearTableImpact): string {
  if (impact.total === 0) {
    return 'There are no open orders on this table. Clearing it will end the current session so the next customer starts fresh.'
  }

  const paidPart =
    impact.paid > 0
      ? `${impact.paid} paid order${impact.paid === 1 ? '' : 's'} will be completed.`
      : ''

  if (impact.unpaid === 0) {
    return `${paidPart} The session will end so the next customer starts fresh.`.trim()
  }

  const owed = formatClearAmount(impact.unpaidTotal)
  const unpaidPart =
    `${impact.unpaid} order${impact.unpaid === 1 ? '' : 's'} for ${owed} ${impact.unpaid === 1 ? 'is' : 'are'} UNPAID. ` +
    `That money stays owed and is still recorded, but it will no longer appear on the dashboard.`

  return `${paidPart} ${unpaidPart}`.trim()
}
