'use client'

export const dynamic = 'force-dynamic'

import { useEffect, useState } from 'react'
import { useParams, useSearchParams, useRouter } from 'next/navigation'
import { supabase } from '@/lib/supabase/client'
import { getRestaurant } from '@/lib/supabase/restaurants'
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

const ORDER_SELECT =
  'id, order_number, status, placed_at, payment_method, payment_status, payment_channel, customer_ready_to_pay, total, subtotal, tax, table_number, items'

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

  const [order, setOrder] = useState<Order | null>(null)
  const [restaurant, setRestaurant] = useState<{ currency?: string; name?: string } | null>(null)
  const [loading, setLoading] = useState(true)
  const [terminalNotifiedLocal, setTerminalNotifiedLocal] = useState(false)

  useEffect(() => {
    const loadData = async () => {
      try {
        setLoading(true)
        const [orderResult, restaurantData] = await Promise.all([
          supabase.from('orders').select(ORDER_SELECT).eq('id', orderId).single(),
          getRestaurant(restaurantId),
        ])
        const orderData = (orderResult.data as Order | null) || null

        if (!orderData) {
          router.push(`/menu/${restaurantId}`)
          return
        }

        setOrder(orderData)
        setRestaurant(restaurantData)
        setLoading(false)
      } catch (err) {
        console.error('Failed to load order:', err)
        setLoading(false)
      }
    }

    if (orderId && restaurantId) {
      loadData()
    }
  }, [orderId, restaurantId, router])

  useEffect(() => {
    if (!orderId) return

    const channel = supabase
      .channel(`order-confirmation-${orderId}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'orders',
          filter: `id=eq.${orderId}`,
        },
        async () => {
          const { data: updatedOrder } = await supabase
            .from('orders')
            .select(ORDER_SELECT)
            .eq('id', orderId)
            .single()
          if (updatedOrder) {
            setOrder(updatedOrder as Order)
          }
        }
      )
      .subscribe()

    return () => {
      supabase.removeChannel(channel)
    }
  }, [orderId])

  useEffect(() => {
    if (!orderId || !order) return
    if (String(order.payment_status || '').toLowerCase() === 'paid') return

    const pollPaymentStatus = async () => {
      const { data: updatedOrder } = await supabase
        .from('orders')
        .select(ORDER_SELECT)
        .eq('id', orderId)
        .maybeSingle()
      if (updatedOrder) {
        setOrder(updatedOrder as Order)
      }
    }

    const interval = setInterval(() => {
      void pollPaymentStatus()
    }, 3000)

    return () => clearInterval(interval)
  }, [orderId, order?.payment_status])

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
  const currency = normalizeCurrency(restaurant?.currency)
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
