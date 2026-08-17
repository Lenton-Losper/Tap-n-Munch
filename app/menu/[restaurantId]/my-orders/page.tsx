// @ts-nocheck
'use client'

export const dynamic = "force-dynamic";

import { useEffect, useState } from 'react'
import { useParams, useSearchParams, useRouter } from 'next/navigation'
import { fetchGuestOrdersBySession, GUEST_ORDER_POLL_MS } from '@/lib/guest-orders/client'
import { lineConfigurationSummary } from '@/lib/orders/line-configuration'
import { getCurrentSession, clearSession, getSessionInfo } from '@/lib/session'
import { readTabSessionId } from '@/lib/tab-storage'
import { Button } from '@/components/ui/button'
import { ArrowLeft } from 'lucide-react'
import { mapOrderStatusToBadge } from '@/components/receipt/receipt-types'
import { useTab } from '@/contexts/tab-context'
import { useRestaurant } from '@/contexts/restaurant-context'
import { TAB_FIGURES_COPY } from '@/lib/tabs/tab-outstanding'
import {
  customerOrderState,
  customerStateNeedsAttention,
  customerStatusLabel,
} from '@/lib/orders/customer-status'
import {
  EDIT_COPY,
  editRefusalReason,
  requestEditRefusalReason,
} from '@/lib/orders/edit-lock'
import {
  ORDER_PLACED_BANNER_MS,
  ORDER_PLACED_PARAM,
  QR_REDESIGN_PENDING_COPY,
  shouldShowOrderPlacedBanner,
} from '@/lib/customer-copy/qr-redesign-copy'
import { orderIdentityLabel } from '@/lib/orders/order-identity'
import { aggregateOrderLines } from '@/lib/orders/aggregate-order-lines'

/**
 * Whether to offer the edit button on a list card. The row here comes from the guest API,
 * which states which table it came from (`surface`), so the two status vocabularies are not
 * guessed at. Ownership is judged on the ids this BROWSER holds, never the row's own.
 */
function isEditableHere(order: any, sessionIds: string[]): boolean {
  // The BROWSER's ids, never the row's own. Echoing the row's id back would make ownership
  // trivially true, and guestCanAccessOrder releases an OPEN order on table_number alone -- so a
  // second diner at the same table would be offered an edit button on somebody else's order.
  const params = { sessionIds, nowMs: Date.now() }
  return order?.surface === 'order_requests'
    ? requestEditRefusalReason(order, params) == null
    : editRefusalReason(order, params) == null
}

export default function MyOrdersPage() {
  const params = useParams()
  const searchParams = useSearchParams()
  const router = useRouter()
  const restaurantId = params.restaurantId as string
  const tableNumber = searchParams.get('table') || ''
  const [orders, setOrders] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const sessionId = getCurrentSession()
  // Every id this browser holds. The order carries whichever the placing screen used, and the
  // cart submits the tab-context one, so a single id both empties this list and 404s the edit.
  const editSessionIds = [sessionId, readTabSessionId()].filter(Boolean) as string[]
  const sessionInfo = getSessionInfo()
  /**
   * The pending figure comes from the SERVER (useTab -> /api/tabs/[tabId]/view), not from a sum
   * over the rows on this screen. Two reasons: it is the same number every other surface shows,
   * so they cannot disagree; and summing `orders` here would be a client-derived money figure,
   * which is the thing that made /tab wrong.
   *
   * It is the TAB's pending, not this session's — a customer looking at My Orders is being told
   * what the restaurant has not yet confirmed for their table, which is what the copy says.
   */
  const { tabPending } = useTab()
  const { currency } = useRestaurant()
  const pendingAmount = Number(tabPending) || 0

  /**
   * The post-order banner (spec section 16). Raised from `?placed=1` rather than fired as a
   * toast from the cart, so it cannot be lost to the navigation that carries the customer here.
   *
   * The parameter is stripped from the URL as soon as it is read. Otherwise a refresh, a Back,
   * or a shared link re-announces an order that was placed some time ago -- the same class of
   * problem as the confirmation page this replaces, where returning to a URL re-entered a flow
   * the customer had already finished (spec Event Q).
   */
  /**
   * Decided in the INITIALISER, not in an effect.
   *
   * `react-hooks/set-state-in-effect` is an error under `eslint . --max-warnings=0`, which is a
   * blocking gate on the staging deploy — and it is right here for a reason beyond lint: setting
   * this from an effect body renders the screen once without the banner and again with it, so the
   * customer's first paint after ordering is the one that does not confirm anything. Reading the
   * parameter at first render means the banner is there in the first frame.
   *
   * The effect keeps only the two things that are genuinely effects: stripping the parameter from
   * the URL, and the timer. `setShowPlacedBanner(false)` inside the timeout callback is not a
   * synchronous set in an effect body and is not what the rule is about.
   */
  const [showPlacedBanner, setShowPlacedBanner] = useState(() =>
    shouldShowOrderPlacedBanner(searchParams.get(ORDER_PLACED_PARAM))
  )
  useEffect(() => {
    if (!showPlacedBanner) return

    const url = new URL(window.location.href)
    url.searchParams.delete(ORDER_PLACED_PARAM)
    window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`)

    const timer = window.setTimeout(() => setShowPlacedBanner(false), ORDER_PLACED_BANNER_MS)
    return () => window.clearTimeout(timer)
    // Deliberately mount-only: the parameter is removed above, so re-running would never see it
    // again and would only risk cancelling a live banner.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (!sessionId) {
      alert('No active session. Please scan the QR code to start ordering.')
      router.push(`/menu/${restaurantId}?table=${tableNumber}`)
      return
    }

    const loadOrders = async () => {
      const { orders } = await fetchGuestOrdersBySession({
        restaurantId,
        sessionId,
        // Orders placed from the tab flow carry the tab-context session id, not this one;
        // querying with only getCurrentSession() shows the customer an empty list.
        sessionIds: [sessionId, readTabSessionId()],
        // This is the RECORD of what the customer ordered, not the live view. A declined
        // request used to drop out of it entirely, leaving no trace that the order was ever
        // placed -- while the staff decline dialog promised the customer would see it.
        includeDeclined: true,
      })
      const ordersList = (orders || []).filter((order: any) => order.is_closed !== true)
      setOrders(ordersList)
      setLoading(false)
    }
    void loadOrders()

    const interval = window.setInterval(() => {
      void loadOrders()
    }, GUEST_ORDER_POLL_MS)

    return () => {
      window.clearInterval(interval)
    }
  }, [sessionId, restaurantId, tableNumber, router])

  const handleEndSession = () => {
    if (confirm('Are you sure you want to end your session?')) {
      clearSession()
      alert('Session ended. Thank you!')
      router.push(`/menu/${restaurantId}/v2?table=${tableNumber}`)
    }
  }

  /**
   * ONE VOCABULARY, and it lives in lib/orders/customer-status.ts.
   *
   * What was here was a private seven-entry map ending
   * `return configs[status] || configs.pending`, where `configs.pending` is `{🎉, 'New'}`. So
   * EVERY status the map did not know rendered as a brand new order — a `ready_for_terminal`
   * order, a `cancelled` one, anything added later. Spec section 34 removes the NEW badge;
   * removing it without replacing the fallback would only move the lie somewhere less visible.
   *
   * There were four more copies of this vocabulary in the product (the six-step tracker,
   * `mapOrderStatusToBadge`, the confirmation view, and this). Nothing is restated here.
   */
  const statusLabel = (order: any) => customerStatusLabel(order?.status, order?.payment_status)
  const statusNeedsAttention = (order: any) =>
    customerStateNeedsAttention(
      customerOrderState({ status: order?.status, paymentStatus: order?.payment_status }),
    )

  const isDeclined = (order: any) => order?.status === 'declined'

  /**
   * REMOVED FROM THE SCREEN 2026-08-16 (spec section 18), and the function deleted with it.
   *
   * It rendered as **"Total Spent"** and it was not what anyone had spent: it summed this
   * session's orders whether or not they had been paid for, and whether or not the restaurant
   * had even accepted them. A customer three minutes into a meal was shown a "Total Spent" of
   * N$288 against N$0 actually taken.
   *
   * It was also the last customer-facing money figure derived on the device, which is the
   * standing rule this project settled in the other direction: every figure a customer sees
   * comes from the server. The two questions it was ambiguously answering both have server-side
   * homes now — what the TABLE owes is `payable_total`, what it has committed to is
   * `pending_total`, and both are on the Tab where the shared bill belongs.
   *
   * Nothing replaced it. Spec section 18: "Do not display analytics merely because the data
   * exists. A restaurant customer does not need a dashboard of their meal."
   *
   * The old docblock is kept below so the reasoning that led here is not lost:
   *
   * ---
   *
   * NOT THE TAB TOTAL, and deliberately left as-is pending a ruling.
   *
   * This sums THIS SESSION'S OWN orders. It is neither of the two tab figures defined in
   * lib/tabs/tab-outstanding.ts -- not what the table owes, and not what the table has ordered --
   * so it must never be used to answer either, and no tab screen may import it.
   *
   * It is also the last customer-facing money figure derived on the device. Two things are
   * unresolved and both are product questions: whether "Total Spent" should count orders that
   * have not been paid for (it currently does), and whether a per-session figure should come
   * from a server read like the tab total now does. Raised rather than answered here.
   *
   * A declined request was never accepted, so its total is not money the customer spent.
   * Leaving it in this sum would have made the fix above state something untrue about money.
   */
  function getTimeAgo(date: Date): string {
    const seconds = Math.floor((new Date().getTime() - date.getTime()) / 1000)
    if (seconds < 60) return 'Just now'
    if (seconds < 3600) return `${Math.floor(seconds / 60)} mins ago`
    if (seconds < 86400) return `${Math.floor(seconds / 3600)} hours ago`
    return `${Math.floor(seconds / 86400)} days ago`
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="text-center">
          <div className="w-10 h-10 border-2 border-border border-t-foreground animate-spin mx-auto" />
          <p className="mt-6 text-muted-foreground font-sans">Loading your orders...</p>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-background">
      <div className="max-w-2xl mx-auto p-6">
        {showPlacedBanner && (
          <div
            role="status"
            aria-live="polite"
            className="mb-4 flex items-center gap-3 border border-emerald-600/30 bg-emerald-50 px-4 py-3 font-sans text-sm font-semibold text-emerald-900"
          >
            <span aria-hidden>✓</span>
            <span>{QR_REDESIGN_PENDING_COPY.orderPlacedBanner}</span>
          </div>
        )}
        {/* Header */}
        <div className="bg-card border border-border p-6 mb-6">
          <div className="flex items-center justify-between mb-6">
            <button
              onClick={() => router.back()}
              className="flex items-center gap-2 text-foreground font-sans font-semibold hover:opacity-70 transition"
            >
              <ArrowLeft className="w-4 h-4 stroke-[1.5]" />
              Back
            </button>
            <button
              onClick={handleEndSession}
              className="text-destructive font-sans font-semibold text-sm hover:opacity-70 transition"
            >
              End Session
            </button>
          </div>

          <h1 className="text-3xl font-serif font-bold text-foreground mb-2">My Orders</h1>
          {/* "Session active since N/A" is gone. `sessionInfo.created` is unset for every
              customer who reached this screen through the tab flow, so the line rendered the
              literal string "N/A" as a matter of course (QRA-13) — and a session start time was
              never something a diner needed. The table number stays; it is how they know they
              are looking at the right table. */}
          <p className="text-muted-foreground font-sans text-sm">Table {sessionInfo.table}</p>

          {/* NO DASHBOARD. Spec section 18.
              "Total Orders" and "Total Spent" used to sit here. Total Spent counted orders that
              had not been paid for and requests the restaurant had not accepted, so a customer
              three minutes into a meal was shown a spend of N$288 against N$0 actually taken.
              It was also the last customer-facing money figure derived on the device.

              What survives is the one figure that is actionable and server-derived: the amount
              the table has committed to that the restaurant has not yet confirmed. It is read
              from the tab view, not summed here. */}
          {pendingAmount > 0 && (
            <p className="mt-4 text-xs font-sans text-amber-600">
              {TAB_FIGURES_COPY.myOrdersPendingNotice.replace(
                '{pending}',
                `${currency}${pendingAmount.toFixed(2)}`,
              )}
            </p>
          )}
        </div>

        {/* Orders List */}
        {orders.length === 0 ? (
          <div className="bg-card border border-border p-16 text-center">
            <div className="text-6xl mb-6">🍽️</div>
            <h2 className="text-xl font-serif font-bold text-foreground mb-2">No orders yet</h2>
            <p className="text-muted-foreground font-sans mb-8">
              Start by browsing the menu and placing your first order
            </p>
            <Button
              onClick={() => router.push(`/menu/${restaurantId}/browse?table=${tableNumber}`)}
              className="bg-foreground text-background hover:bg-foreground/90 font-sans px-8"
            >
              Browse Menu
            </Button>
          </div>
        ) : (
          <div className="space-y-4">
            {orders.map((order) => {
              const placedAt = order.placed_at?.toDate
                ? order.placed_at.toDate()
                : order.placed_at
                ? (typeof order.placed_at === 'string' ? new Date(order.placed_at) : new Date())
                : new Date()
              const timeAgo = getTimeAgo(placedAt)

              return (
                <div
                  key={order.id}
                  className="bg-card border border-border p-6 cursor-pointer hover:border-foreground/30 transition"
                  onClick={() =>
                    router.push(`/order-confirmation?orderId=${order.id}${tableNumber ? `&table=${tableNumber}` : ''}`)
                  }
                >
                  {/* Order Header */}
                  <div className="flex justify-between items-start mb-4">
                    <div>
                      <h3 className="font-sans font-bold text-foreground text-lg">
                        {orderIdentityLabel(order)}
                      </h3>
                      <p className="text-sm text-muted-foreground font-sans">{timeAgo}</p>
                    </div>
                    <div className="text-right">
                      <p className="text-xl font-bold text-foreground font-sans">
                        N${order.total?.toFixed(2)}
                      </p>
                      {/* One vocabulary, from lib/orders/customer-status.ts. A state that
                          expects something of the customer is styled apart from one that does
                          not -- "Needs you" must not look like "Being prepared". */}
                      <span
                        className={`inline-block px-3 py-1 text-xs font-semibold uppercase tracking-wide mt-2 ${
                          statusNeedsAttention(order)
                            ? 'bg-amber-100 text-amber-900'
                            : 'bg-muted text-foreground'
                        }`}
                      >
                        {statusLabel(order)}
                      </span>
                    </div>
                  </div>

                  {/* Order Items Preview */}
                  <div className="border-t border-border pt-4">
                    <p className="text-sm text-muted-foreground font-sans mb-2">
                      {order.items?.length || 0} item{order.items?.length !== 1 ? 's' : ''}:
                    </p>
                    {/*
                      #307: LOTS ARE AGGREGATED FOR DISPLAY, never for storage.

                      Additions append, so ordering one more Pork Star produced a second identical
                      row with no total and no explanation -- the #297/#299 complaint, guaranteed by
                      the per-line addition model. `aggregateOrderLines` merges lots ONLY when the
                      server proves item, configuration AND authoritative unit price are identical,
                      and it SUMS the stored figures rather than recomputing quantity x price.

                      When the prices DIFFER the group keeps one row per price, each with its own
                      figure. Hiding that behind a single averaged line is the one thing the ruling
                      forbids outright.
                    */}
                    <div className="space-y-1">
                      {aggregateOrderLines(order.items ?? []).slice(0, 3).map((group, idx: number) => (
                        <div key={idx}>
                          <p className="text-sm text-foreground font-sans">
                            {group.quantity}× {String((group.sample as any).displayName || (group.sample as any).name || 'Item')}
                            {lineConfigurationSummary(group.sample as any) ? (
                              <span className="block text-xs text-muted-foreground">
                                {lineConfigurationSummary(group.sample as any)}
                              </span>
                            ) : null}
                          </p>
                          {group.hasMixedPrices && (
                            <span className="block pl-4 text-xs text-muted-foreground">
                              {group.rows.map((row, ri) => (
                                <span key={ri} className="block">
                                  {row.quantity}× {currency}
                                  {(row.unitPrice ?? 0).toFixed(2)} — {currency}
                                  {row.total.toFixed(2)}
                                </span>
                              ))}
                            </span>
                          )}
                        </div>
                      ))}
                      {aggregateOrderLines(order.items ?? []).length > 3 && (
                        <p className="text-sm text-muted-foreground font-sans italic">
                          +{aggregateOrderLines(order.items ?? []).length - 3} more item
                          {aggregateOrderLines(order.items ?? []).length - 3 !== 1 ? 's' : ''}
                        </p>
                      )}
                    </div>
                  </div>

                  {/* Edit entry point. Routes to the per-order confirmation screen, which is
                      where the editor lives — one place a customer can change an order from,
                      rather than a second editor embedded in a list card. The button appears
                      only while the order is still open to editing; the server refuses
                      regardless, so this only avoids offering a dead control. */}
                  {isEditableHere(order, editSessionIds) && (
                    <div className="mt-4">
                      <Button
                        variant="outline"
                        className="w-full font-sans font-semibold"
                        onClick={(event) => {
                          event.stopPropagation()
                          router.push(
                            `/menu/${restaurantId}/order-confirmation/${order.id}${tableNumber ? `?table=${tableNumber}` : ''}`,
                          )
                        }}
                      >
                        {EDIT_COPY.editCta}
                      </Button>
                    </div>
                  )}

                  {/* Payment Status.
                      Suppressed for a declined request: it never became an order, so its
                      payment_status is 'declined' and the badge below would have rendered the
                      fallback "⏳ Pending" -- telling the customer they still owe for something
                      the restaurant refused. The decline is stated in words instead. */}
                  {isDeclined(order) ? (
                    <p className="mt-4 text-sm font-sans text-muted-foreground">
                      {/* Same sentence the direct link already shows, so arriving by list and
                          arriving by link do not tell the customer two different things. */}
                      {mapOrderStatusToBadge('declined').description}
                    </p>
                  ) : (
                    <div className="mt-4 flex items-center gap-4 text-sm font-sans">
                      <span className="text-muted-foreground">
                        Payment: {order.payment_method === 'card' ? '💳' : '💵'} {order.payment_method}
                      </span>
                      <span className={`px-2 py-1 text-xs font-semibold uppercase tracking-wide ${
                        order.payment_status === 'paid'
                          ? 'bg-foreground text-background'
                          : 'bg-muted text-foreground'
                      }`}>
                        {order.payment_status === 'paid' ? '✓ Paid' : '⏳ Pending'}
                      </span>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}

        {/* Order More Button */}
        {orders.length > 0 && (
          <div className="mt-8">
            <Button
              onClick={() => router.push(`/menu/${restaurantId}/browse?table=${tableNumber}`)}
              className="w-full bg-foreground text-background hover:bg-foreground/90 font-sans font-semibold py-6 text-base"
            >
              Order More Items
            </Button>
          </div>
        )}
      </div>
    </div>
  )
}
