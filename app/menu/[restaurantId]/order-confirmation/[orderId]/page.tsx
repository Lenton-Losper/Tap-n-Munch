'use client'

export const dynamic = 'force-dynamic'

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
import { getCurrentSession } from '@/lib/session'
import { OrderConfirmationView } from '@/components/receipt/order-confirmation-view'
import type { OrderStatusKey } from '@/components/receipt/receipt-types'
import { InfoBanner } from '@/components/receipt/info-banner'
import { fetchGuestOrderById, GUEST_ORDER_POLL_MS } from '@/lib/guest-orders/client'

type Order = {
  id: string
  order_number: number
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
    order_number: Number(row.order_number || 0),
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
    items: Array.isArray(row.items)
      ? (row.items as Array<{ quantity: number; name: string; subtotal: number }>)
      : [],
  }
}

function isCashPaymentOrder(order: Order): boolean {
  const paymentStatus = String(order.payment_status || '').toLowerCase()
  return (
    String(order.payment_channel || '').toLowerCase() === 'cash' ||
    String(order.payment_method || '').toLowerCase() === 'cash' ||
    paymentStatus === 'cash_pending'
  )
}

function showReadyToPayCashButton(order: Order): boolean {
  const paymentStatus = String(order.payment_status || '').toLowerCase()
  if (paymentStatus === 'paid' || paymentStatus === 'cancelled') return false
  return (
    isCashPaymentOrder(order) &&
    (order.customer_ready_to_pay === false || order.customer_ready_to_pay == null)
  )
}

function showReadyToPayCashNotified(order: Order): boolean {
  return isCashPaymentOrder(order) && order.customer_ready_to_pay === true
}

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
  const { currency: restaurantCurrency } = useRestaurant()

  const [order, setOrder] = useState<Order | null>(null)
  const [loading, setLoading] = useState(true)
  const [terminalNotifiedLocal, setTerminalNotifiedLocal] = useState(false)

  useEffect(() => {
    let cancelled = false

    const loadData = async () => {
      try {
        setLoading(true)
        const row = await fetchGuestOrderById(orderId, {
          tableNumber: tableNumber > 0 ? tableNumber : undefined,
          sessionId: getCurrentSession() || undefined,
        })

        if (cancelled) return

        if (!row) {
          router.push(`/menu/${restaurantId}`)
          return
        }

        setOrder(mapGuestRowToOrder(row as Record<string, unknown>))
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
  }, [orderId, restaurantId, router, tableNumber])

  useEffect(() => {
    if (!orderId || !order) return
    if (String(order.payment_status || '').toLowerCase() === 'paid') return

    let cancelled = false

    const pollPaymentStatus = async () => {
      const row = await fetchGuestOrderById(orderId, {
        tableNumber: tableNumber > 0 ? tableNumber : order.table_number,
        sessionId: getCurrentSession() || undefined,
      })
      if (cancelled || !row) return
      setOrder(mapGuestRowToOrder(row as Record<string, unknown>))
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
  }, [orderId, order?.payment_status, tableNumber])

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
          <h1 className="text-2xl font-serif font-bold text-[#111827] mb-4">Order Not Found</h1>
          <p className="text-[#6B7280] mb-6">The order you&apos;re looking for doesn&apos;t exist.</p>
          <Link href={`/menu/${restaurantId}${tableNumber > 0 ? `?table=${tableNumber}` : ''}`}>
            <Button className="w-full bg-[#16A34A] hover:bg-green-700 text-white font-semibold">
              Back to Menu
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
  const showTerminalPayCta = isCardTerminal && paymentPending

  return (
    <OrderConfirmationView
      orderNumber={order.order_number}
      tableNumber={effectiveTableNumber > 0 ? effectiveTableNumber : undefined}
      createdAt={order.placed_at}
      orderStatus={order.status}
      paymentMethod={order.payment_method}
      paymentStatus={order.payment_status}
      paymentChannel={order.payment_channel}
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
      cashReadySlot={showReadyToPayCashButton(order) ? <ReadyToPayCashButton orderId={order.id} /> : undefined}
      cashNotifiedSlot={
        showReadyToPayCashNotified(order) ? (
          <InfoBanner variant="notify">Staff has been notified. They will be with you shortly.</InfoBanner>
        ) : undefined
      }
      orderReadyBanner={
        order.status === 'ready' ? (
          <InfoBanner variant="success">
            Your order is ready! A staff member will come to your table shortly.
          </InfoBanner>
        ) : undefined
      }
    />
  )
}
