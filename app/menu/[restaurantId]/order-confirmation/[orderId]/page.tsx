'use client'

export const dynamic = 'force-dynamic'

import { hasAllocatedOrderNumber } from '@/lib/orders/order-identity'
import { useEffect, useState } from 'react'
import { useParams, useSearchParams, useRouter } from 'next/navigation'
import { useRestaurant } from '@/contexts/restaurant-context'
import { Button } from '@/components/ui/button'
import Link from 'next/link'
import {
  ReadyToPayTerminalButton,
  ReadyToPayTerminalNotified,
} from '@/components/ready-to-pay-terminal'
import { ReadyToPayCashButton, ReadyToPayCashNotified } from '@/components/ready-to-pay-cash'
import { perOrderReadyToPayAllowed } from '@/lib/tabs/ready-to-pay-placement'
import {
  showCashReadyToPayButton,
  showCashReadyToPayNotified,
} from '@/lib/orders/cash-ready-to-pay'
import { getCurrentSession } from '@/lib/session'
import { readTabSessionId, heldSessionIds } from '@/lib/tab-storage'
import { OrderConfirmationView } from '@/components/receipt/order-confirmation-view'
import type { OrderStatusKey } from '@/components/receipt/receipt-types'
import { InfoBanner } from '@/components/receipt/info-banner'
import { fetchGuestOrderById, GUEST_ORDER_POLL_MS } from '@/lib/guest-orders/client'
import { OrderEditPanel } from '@/components/order-edit-panel'
import { MENU_COPY } from '@/lib/customer-copy/menu-copy'
import { deriveIsCounterService, serviceCopy } from '@/lib/customer-copy/service-model'

type Order = {
  id: string
  /** `null` on an order_request: that table has no order_number column at all. */
  order_number: number | null
  status: OrderStatusKey
  placed_at: string
  payment_method: string
  payment_status: string
  payment_channel?: string | null
  customer_ready_to_pay?: boolean | null
  total: number
  subtotal?: number
  tax?: number
  table_number?: number
  items: Array<{ quantity: number; name: string; subtotal: number }>
}

function mapGuestRowToOrder(row: Record<string, unknown>): Order {
  return {
    id: String(row.id || ''),
    /**
     * THE SOURCE OF "Order #0" ON PRODUCTION, 2026-08-19.
     *
     * This was `row.order_number != null ? Number(row.order_number) : null`. The guest-order
     * mapper handed it a literal `0` for an order_request -- that table has no order_number
     * column at all -- and `0 != null` is true, so a real customer was shown "Order #0".
     *
     * The mapper is fixed at source (lib/guest-orders/queries.ts now yields null), and this stays
     * on the helper so the two cannot disagree if another producer ever sends 0 again.
     *
     * `hasAllocatedOrderNumber` is the one test for "is there a number", and it already rejects
     * 0, '' and null together. Used here so the mapper cannot disagree with the render.
     */
    order_number: hasAllocatedOrderNumber({ order_number: row.order_number })
      ? Number(row.order_number)
      : null,
    status: String(row.status || 'pending') as OrderStatusKey,
    placed_at: String(row.placed_at || row.created_at || ''),
    payment_method: String(row.payment_method || ''),
    payment_status: String(row.payment_status || ''),
    payment_channel: row.payment_channel != null ? String(row.payment_channel) : null,
    customer_ready_to_pay:
      row.customer_ready_to_pay === true || row.customer_ready_to_pay === false
        ? Boolean(row.customer_ready_to_pay)
        : null,
    total: Number(row.total || 0),
    subtotal: row.subtotal != null ? Number(row.subtotal) : undefined,
    tax: row.tax != null ? Number(row.tax) : undefined,
    table_number: row.table_number != null ? Number(row.table_number) : undefined,
    /**
     * #295: `total` and `tax` are carried through. This narrowed to
     * `{quantity, name, subtotal}` and threw the charged figure away, so the only number
     * OrderSummary could render was the ex-VAT base.
     */
    items: Array.isArray(row.items)
      ? (row.items as Array<{
          quantity: number
          name: string
          subtotal: number
          total?: number
          tax?: number
          // #298: carried through so the screen can tell two same-named lines apart.
          size?: unknown
          addons?: unknown
          selectedVariants?: unknown
        }>)
      : [],
  }
}

/**
 * #121. These three used to be private copies here. They are now imported from
 * `lib/orders/cash-ready-to-pay.ts`, which is the SAME module
 * `app/api/orders/[orderId]/ready-to-pay-cash/route.ts` asks before it allows the write.
 *
 * That is the whole reason for the move. While the button decided visibility from one copy of the
 * rule and the server decided permission from another, the two could drift — and a button that is
 * visible and then refuses is a worse failure than either half alone. #121 was the mirror of it: a
 * button that was visible, reported success, and did nothing.
 *
 * ONE BEHAVIOUR CHANGE, named rather than buried. `cashReadyToPayRefusal` adds a terminal-status
 * check the copy here never had, so the button no longer renders on a `completed`, `cancelled` or
 * `declined` order. It can only ever HIDE the button — never show it somewhere new — and pressing
 * it in those states did nothing anyway.
 *
 * It asks `isTerminalOrderStatus`, not `!isActiveOrderStatus`: `orders.status` DEFAULTS to `'new'`,
 * which is not in ACTIVE_ORDER_STATUSES, so the obvious form of that guard would have hidden the
 * button on every freshly created order.
 */
/* The call sites below use the imported names directly — no local alias, so a reader who greps
   showCashReadyToPayButton finds this screen as well as the route. */

function normalizeCurrency(raw?: string): string {
  const c = String(raw || 'NAD').trim()
  if (c === 'N$' || c.startsWith('N$')) return 'NAD'
  return c.replace(/\$/g, '').trim() || 'NAD'
}

export default function OrderConfirmationPage() {
  const params = useParams()
  const searchParams = useSearchParams()
  const router = useRouter()
  const restaurantId = params.restaurantId as string
  const orderId = params.orderId as string
  const tableNumber = parseInt(searchParams.get('table') || '0')
  const terminalNotice = searchParams.get('notice') === 'terminal'
  const { restaurant, currency: restaurantCurrency } = useRestaurant()
  /** #334 round two: "a staff member will come to your table" at a counter venue. */
  const copy = serviceCopy(deriveIsCounterService({ restaurant }))

  const [order, setOrder] = useState<Order | null>(null)
  // The raw guest row as well as the mapped one. The edit panel needs fields the Order type
  // above deliberately does not carry (surface, payment_checkout_url, the lock state), and
  // widening that type would push them through every prop of OrderConfirmationView.
  const [orderRow, setOrderRow] = useState<Record<string, unknown> | null>(null)
  const [loading, setLoading] = useState(true)
  const [terminalNotifiedLocal, setTerminalNotifiedLocal] = useState(false)
  const [editReloadKey, setEditReloadKey] = useState(0)

  useEffect(() => {
    let cancelled = false

    const loadData = async () => {
      try {
        setLoading(true)
        const row = await fetchGuestOrderById(orderId, {
          restaurantId,
          tableNumber: tableNumber > 0 ? tableNumber : undefined,
          // Every id this browser holds. This load previously matched only via the
          // table_number branch of guestCanAccessOrder — the session comparison was wrong and
          // masked. Verified on live staging traffic before this change: the session branch
          // alone resolves the order with no table_number, so this is not the only thing
          // holding the page up (see #279, which narrows that branch afterwards).
          sessionIds: heldSessionIds(),
        })

        if (cancelled) return

        if (!row) {
          /**
           * A MISSING ORDER IS NOT AN ENDED SESSION (#294).
           *
           * This used to `router.push('/menu/<id>')`. The landing then validates the stored
           * token, and if the tab has since been settled or the table's session version moved,
           * `/api/session/validate` answers 410 and the landing calls `handleSessionExpired` --
           * which wipes the token, the tab id, the table and the cart and lands the customer on
           * "Your dining session has ended".
           *
           * So a 404 on ONE order read evicted the customer from a tab that was still open. The
           * route out of their own bill was destroyed, and a joiner who never knew the PIN could
           * not get back at all. `fetchGuestOrderById` returns null only on a 404; every other
           * failure throws and is handled below.
           */
          setLoading(false)
          return
        }

        setOrder(mapGuestRowToOrder(row as Record<string, unknown>))
        setOrderRow(row as Record<string, unknown>)
        setLoading(false)
      } catch (err) {
        console.error('Failed to load order:', err)
        if (!cancelled) setLoading(false)
      }
    }

    if (orderId && restaurantId) {
      void loadData()
    }

    return () => {
      cancelled = true
    }
  }, [orderId, restaurantId, router, tableNumber, editReloadKey])

  useEffect(() => {
    if (!orderId || !order) return
    if (String(order.payment_status || '').toLowerCase() === 'paid') return

    let cancelled = false

    const pollPaymentStatus = async () => {
      const row = await fetchGuestOrderById(orderId, {
        restaurantId,
        tableNumber: tableNumber > 0 ? tableNumber : order.table_number,
        sessionIds: heldSessionIds(),
      })
      if (cancelled || !row) return
      setOrder(mapGuestRowToOrder(row as Record<string, unknown>))
      setOrderRow(row as Record<string, unknown>)
    }

    const interval = window.setInterval(() => {
      void pollPaymentStatus()
    }, GUEST_ORDER_POLL_MS)

    void pollPaymentStatus()

    return () => {
      cancelled = true
      window.clearInterval(interval)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- orderId + payment_status gate the poll lifecycle
  }, [orderId, order?.payment_status, tableNumber, restaurantId])

  if (loading) {
    return (
      <div className="min-h-screen bg-[#F8FAFC] flex items-center justify-center">
        <div className="w-10 h-10 border-2 border-[#E5E7EB] border-t-[#16A34A] animate-spin rounded-full" />
      </div>
    )
  }

  if (!order) {
    return (
      <div className="min-h-screen bg-[#F8FAFC] flex items-center justify-center p-6">
        <div className="max-w-md w-full bg-white rounded-2xl border border-[#E5E7EB] p-8 text-center shadow-sm">
          <h1 className="text-2xl font-serif font-bold text-[#111827] mb-4">{MENU_COPY.orderNotFound}</h1>
          <p className="text-[#6B7280] mb-6">The order you&apos;re looking for doesn&apos;t exist.</p>
          <Link href={`/menu/${restaurantId}${tableNumber > 0 ? `?table=${tableNumber}` : ''}`}>
            <Button className="w-full bg-[#16A34A] hover:bg-green-700 text-white font-semibold">
              {MENU_COPY.backMenu}
            </Button>
          </Link>
        </div>
      </div>
    )
  }

  const effectiveTableNumber =
    tableNumber > 0 ? tableNumber : Number(order.table_number || 0)
  const currency = normalizeCurrency(restaurantCurrency)
  const paymentStatusLower = String(order.payment_status || '').toLowerCase()
  const isTerminalChannel =
    String(order.payment_channel || '').toLowerCase() === 'terminal'
  const isCardTerminal =
    order.payment_method === 'card' && (isTerminalChannel || terminalNotice)
  const paymentPending = paymentStatusLower !== 'paid' && paymentStatusLower !== 'cancelled'
  const waiterNotified =
    terminalNotifiedLocal ||
    order.customer_ready_to_pay === true ||
    order.status === 'ready_for_terminal'
  /**
   * Spec section 30: on a TAB, settlement lives on the Tab and this per-order control is the
   * second of two competing "call the waiter" mechanisms writing to two different tables
   * (audit D8). Off a tab it is the customer's only way to ask, so it stays.
   * The rule is in lib/tabs/ready-to-pay-placement.ts; this site does not restate it.
   */
  const perOrderSettlementAllowed = perOrderReadyToPayAllowed(orderRow)
  const showTerminalPayCta = isCardTerminal && paymentPending && perOrderSettlementAllowed

  return (
    <OrderConfirmationView
      orderNumber={order.order_number}
      tableNumber={effectiveTableNumber > 0 ? effectiveTableNumber : undefined}
      createdAt={order.placed_at}
      orderStatus={order.status}
      paymentMethod={order.payment_method}
      paymentStatus={order.payment_status}
      paymentChannel={order.payment_channel}
      /**
       * Read from the RAW row, not the mapped `order`: the Order type above deliberately does not
       * carry tab_id, and widening it would push the field through every prop of this view for
       * one boolean. `orderRow` is the same row the edit panel already reads for the same reason.
       */
      isTabOrder={Boolean(String(orderRow?.tab_id ?? '').trim())}
      items={order.items}
      total={order.total}
      subtotal={order.subtotal}
      tax={order.tax}
      currency={currency}
      showTerminalPayMessage={terminalNotice || isCardTerminal}
      showReadyToPayHint={showTerminalPayCta && !waiterNotified}
      waiterNotified={false}
      readyToPaySlot={
        showTerminalPayCta ? (
          waiterNotified ? (
            <ReadyToPayTerminalNotified />
          ) : (
            <ReadyToPayTerminalButton
              restaurantId={restaurantId}
              orderId={order.id}
              tableNumber={effectiveTableNumber}
              sessionId={getCurrentSession()}
              alreadyNotified={waiterNotified}
              onNotified={() => setTerminalNotifiedLocal(true)}
            />
          )
        ) : undefined
      }
      cashReadySlot={
        showCashReadyToPayButton(order) && perOrderSettlementAllowed ? (
          <ReadyToPayCashButton orderId={order.id} />
        ) : undefined
      }
      cashNotifiedSlot={
        showCashReadyToPayNotified(order) ? (
          <InfoBanner variant="notify">{MENU_COPY.staffHasBeenNotifiedThey}</InfoBanner>
        ) : undefined
      }
      editSlot={
        orderRow ? (
          <OrderEditPanel
            orderId={order.id}
            restaurantId={restaurantId}
            /**
             * BOTH ids this BROWSER holds — and deliberately NOT the row's own session_id.
             *
             * The order carries whichever the placing screen held (the cart submits the
             * tab-context one), so passing only getCurrentSession() sent the customer their own
             * order as a 404. But echoing the row's id back would make the server's ownership
             * check pass unconditionally, and `guestCanAccessOrder` releases an OPEN order on
             * table_number alone — so a second diner at the same table could load this page for
             * someone else's order and edit it. That is the hole redactGuestOrderRow exists to
             * close, reopened from the other end.
             */
            sessionIds={[getCurrentSession(), readTabSessionId()]}
            order={orderRow}
            currency={currency === 'NAD' ? 'N$' : `${currency} `}
            onEdited={() => setEditReloadKey((key) => key + 1)}
          />
        ) : undefined
      }
      orderReadyBanner={
        order.status === 'ready' ? (
          <InfoBanner variant="success">
            {copy.orderReady}
          </InfoBanner>
        ) : undefined
      }
    />
  )
}
