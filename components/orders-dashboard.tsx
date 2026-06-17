// @ts-nocheck
'use client'

import { useCallback, useEffect, useMemo, useRef, useState, type ComponentType } from 'react'
import { useAuth } from '@/components/auth/auth-provider'
import {
  extractFirebaseRestaurantId,
  orderRestaurantOrFilter,
  resolveOrderRestaurantScope,
  type OrderRestaurantScope,
} from '@/lib/supabase/restaurants'
import { subscribeRestaurantOrdersRealtime, getAllOpenRestaurantOrders } from '@/lib/supabase/orders'
import {
  applyOrderRealtimeEvent,
  countPendingHostedOrders,
  playNewOrderSound,
  unlockNewOrderSound,
} from '@/lib/dashboard/order-realtime'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { RefreshCw, Clock, ArrowLeft, CheckCircle2, ChefHat, Package, XCircle, Banknote, CreditCard, DollarSign, DoorClosed, Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useRouter } from 'next/navigation'
import { useToast } from '@/hooks/use-toast'
import { supabase } from '@/lib/supabase/client'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'

type TerminalStatus = 'pending' | 'failed' | null

// PART 2: Standardize Order Status Model
type OrderStatus =
  | 'pending'
  | 'accepted'
  | 'ready'
  | 'ready_for_terminal'
  | 'completed'
  | 'cancelled'

/** Dashboard tab ids (UI) may differ from Supabase order status values. */
type DashboardTabId = 'new' | 'pending_payment' | 'accepted' | 'preparing' | 'ready' | 'completed'

function supabaseStatusForTab(tab: DashboardTabId): string | null {
  if (tab === 'pending_payment') return null
  if (tab === 'new') return 'pending'
  if (tab === 'preparing') return 'ready'
  return tab
}
type Order = Record<string, any> & {
  id: string
  status: string
  payment_method: string
  payment_status: string
  placed_at: string
  total: number
  items: any[]
}

function paymentChannelOf(order: Order): string {
  return String((order as Order & { payment_channel?: string }).payment_channel || '').toLowerCase()
}

function isOrderPaid(order: Order): boolean {
  return String(order.payment_status || '').toLowerCase() === 'paid'
}

function canMarkManualPaid(order: Order): boolean {
  if (isOrderPaid(order)) return false
  const ps = String(order.payment_status || '').toLowerCase()
  const workflowStatus = String(order.status || '').toLowerCase()
  if (ps === 'cancelled') return false
  if (workflowStatus === 'completed' && ps === 'paid') return false
  const ch = paymentChannelOf(order)
  if (ch === 'cash' || ch === 'card_manual') return true
  if (order.payment_method === 'cash' && (ps === 'cash_pending' || ps === 'pending')) return true
  return false
}

/** At-table payment channels stay in New Orders until staff advances workflow status. */
function isAtTablePaymentChannel(order: Order): boolean {
  const ch = paymentChannelOf(order)
  return ch === 'cash' || ch === 'card_manual' || ch === 'other'
}

function isCustomerReadyToPay(order: Order): boolean {
  return order.customer_ready_to_pay === true
}

function tabIdOf(order: Order): string {
  return String((order as Order & { tab_id?: string | null }).tab_id || '').trim()
}

/** Orders added to an open tab — pay at settlement, must stay visible on the kitchen dashboard. */
function isTabOrder(order: Order): boolean {
  return tabIdOf(order) !== ''
}

const tabs: { id: DashboardTabId; label: string }[] = [
  { id: 'new', label: 'New Orders' },
  { id: 'pending_payment', label: 'Pending Payment' },
  { id: 'accepted', label: 'Accepted' },
  { id: 'preparing', label: 'Preparing' },
  { id: 'ready', label: 'Ready' },
  { id: 'completed', label: 'Completed' },
]

function orderActionKey(orderId: string, action: string) {
  return `${orderId}:${action}`
}

function ButtonSpinner({ className }: { className?: string }) {
  return <Loader2 className={cn('h-4 w-4 animate-spin', className)} aria-hidden />
}

function ActionButtonContent({
  loading,
  icon: Icon,
  label,
  loadingLabel,
}: {
  loading: boolean
  icon?: ComponentType<{ className?: string }>
  label: string
  loadingLabel?: string
}) {
  return (
    <>
      {loading ? (
        <ButtonSpinner className="mr-2" />
      ) : Icon ? (
        <Icon className="h-4 w-4 mr-2" />
      ) : null}
      {loading ? loadingLabel ?? label : label}
    </>
  )
}

export function OrdersDashboard() {
  const { user, restaurantId, restaurant } = useAuth()
  const router = useRouter()
  const { toast } = useToast()
  const toastRef = useRef(toast)
  toastRef.current = toast
  const [activeTab, setActiveTab] = useState<DashboardTabId>('new')
  const [pendingHostedCount, setPendingHostedCount] = useState(0)
  const [cancellingHostedOrderId, setCancellingHostedOrderId] = useState<string | null>(null)
  const [orders, setOrders] = useState<Order[]>([])
  const [allOrders, setAllOrders] = useState<Order[]>([])
  const [loading, setLoading] = useState(true)
  const [markingPaidOrderId, setMarkingPaidOrderId] = useState<string | null>(null)
  const [markPaidTargetOrderId, setMarkPaidTargetOrderId] = useState<string | null>(null)
  const [showMarkPaidDialog, setShowMarkPaidDialog] = useState(false)
  const [closeTableTargetNumber, setCloseTableTargetNumber] = useState<number | null>(null)
  const [closingTableNumber, setClosingTableNumber] = useState<number | null>(null)
  const [showCloseTableDialog, setShowCloseTableDialog] = useState(false)
  const [statusUpdateKey, setStatusUpdateKey] = useState<string | null>(null)
  const [sendingToTerminalOrderId, setSendingToTerminalOrderId] = useState<string | null>(null)
  const [cancelingTerminalOrderId, setCancelingTerminalOrderId] = useState<string | null>(null)
  const [terminalPollingOrderIds, setTerminalPollingOrderIds] = useState<string[]>([])
  const [terminalStatusByOrderId, setTerminalStatusByOrderId] = useState<Record<string, TerminalStatus>>({})
  const dashboardRestaurantId = String((restaurant as { id?: string } | null)?.id || restaurantId || '')
  const dashboardFirebaseRestaurantId = extractFirebaseRestaurantId(
    restaurant as Record<string, unknown> | null
  )
  const [orderScope, setOrderScope] = useState<OrderRestaurantScope | null>(null)
  const orderScopeRef = useRef<OrderRestaurantScope | null>(null)
  const subscribedRestaurantIdRef = useRef<string | null>(null)
  orderScopeRef.current = orderScope

  const toDate = (timestamp: unknown): Date | null => {
    if (!timestamp) return null
    if (timestamp instanceof Date) return Number.isNaN(timestamp.getTime()) ? null : timestamp
    if (typeof (timestamp as { toDate?: unknown })?.toDate === 'function') {
      const date = (timestamp as { toDate: () => Date }).toDate()
      return Number.isNaN(date.getTime()) ? null : date
    }
    if (typeof timestamp === 'string' || typeof timestamp === 'number') {
      const date = new Date(timestamp)
      return Number.isNaN(date.getTime()) ? null : date
    }
    return null
  }

  const isRecentCardPendingOrder = (order: Order) => {
    if (order.payment_method !== 'card' || order.payment_status !== 'pending') return false
    const ch = paymentChannelOf(order)
    if (ch === 'card_manual' || ch === 'other') return false
    if (ch === 'terminal') return true
    const createdDate = toDate((order as Order & { created_at?: unknown }).created_at) || toDate(order.placed_at)
    if (!createdDate) return true
    return Date.now() - createdDate.getTime() < 5 * 60 * 1000
  }

  const shouldDisplayOrder = (order: Order) => {
    const isPaidSettlementOrder =
      String((order as Order & { tab_settlement_for_tab_id?: string | null }).tab_settlement_for_tab_id || '').trim() !== '' &&
      String(order.payment_status || '').toLowerCase() === 'paid'
    if (isPaidSettlementOrder) return false

    if (isTabOrder(order)) return true

    const ch = paymentChannelOf(order)
    if (ch === 'cash' || ch === 'card_manual' || ch === 'other') return true
    if (order.payment_method === 'other') return true
    if (order.payment_method === 'cash') return true
    if (order.payment_method === 'card_terminal') return true
    if (order.payment_method === 'card') {
      if (ch === 'card_manual' && order.payment_status === 'pending') return true
      if (ch === 'terminal' && order.payment_status === 'pending') return true
      if (order.payment_status === 'paid') return true
      return isRecentCardPendingOrder(order)
    }
    return true
  }

  useEffect(() => {
    if (!dashboardRestaurantId) {
      setOrderScope(null)
      return
    }

    if (restaurant?.id) {
      const supabaseUuid = String(restaurant.id)
      setOrderScope({
        input: dashboardRestaurantId || supabaseUuid,
        supabaseUuid,
        firebaseRestaurantId:
          extractFirebaseRestaurantId(restaurant as Record<string, unknown>) || supabaseUuid,
      })
      return
    }

    let cancelled = false
    void resolveOrderRestaurantScope(dashboardRestaurantId, {
      firebaseRestaurantId: dashboardFirebaseRestaurantId || undefined,
    })
      .then((scope) => {
        if (!cancelled) setOrderScope(scope)
      })
      .catch((err) => {
        console.error(err)
        if (!cancelled) setOrderScope(null)
      })
    return () => {
      cancelled = true
    }
  }, [dashboardRestaurantId, dashboardFirebaseRestaurantId, restaurant])

  // Single Realtime subscription for all order INSERT/UPDATE/DELETE events
  useEffect(() => {
    if (!user) {
      setLoading(false)
      return
    }

    if (!dashboardRestaurantId) {
      setLoading(false)
      return
    }

    if (subscribedRestaurantIdRef.current === dashboardRestaurantId) {
      return
    }

    let cancelled = false
    let unsubscribe: (() => void) | undefined

    const start = async () => {
      let scope = orderScopeRef.current
      if (!scope) {
        try {
          scope = await resolveOrderRestaurantScope(dashboardRestaurantId, {
            firebaseRestaurantId: dashboardFirebaseRestaurantId || undefined,
          })
        } catch (err) {
          console.error(err)
          if (!cancelled) setLoading(false)
          return
        }
      }

      if (cancelled || !scope) return

      if (subscribedRestaurantIdRef.current === dashboardRestaurantId) return
      subscribedRestaurantIdRef.current = dashboardRestaurantId

      setLoading(true)

      unsubscribe = subscribeRestaurantOrdersRealtime(
        dashboardRestaurantId,
        {
          onInitial: (incoming) => {
            if (cancelled) return
            const list = Array.isArray(incoming) ? (incoming as Order[]) : []
            setAllOrders(list)
            setPendingHostedCount(countPendingHostedOrders(list))
            setLoading(false)
          },
          onChange: (payload) => {
            if (cancelled) return
            setAllOrders((prev) => {
              const next = applyOrderRealtimeEvent(prev, payload)
              setPendingHostedCount(countPendingHostedOrders(next))
              return next
            })

            if (payload.eventType === 'INSERT') {
              const row = payload.new as Order | null
              if (row && String(row.status || '').toLowerCase() === 'pending') {
                playNewOrderSound()
                toastRef.current({
                  title: 'New order',
                  description: `Order #${row.order_number ?? '?'} — Table ${row.table_number ?? '?'}`,
                })
              }
            }
          },
        },
        scope
      )

      if (cancelled) {
        unsubscribe()
        if (subscribedRestaurantIdRef.current === dashboardRestaurantId) {
          subscribedRestaurantIdRef.current = null
        }
      }
    }

    void start()

    return () => {
      cancelled = true
      if (subscribedRestaurantIdRef.current === dashboardRestaurantId) {
        subscribedRestaurantIdRef.current = null
      }
      unsubscribe?.()
    }
  }, [user, dashboardRestaurantId])

  const mergedSourceOrders = useMemo(() => {
    if (activeTab === 'pending_payment') {
      return allOrders.filter(
        (order) =>
          paymentChannelOf(order) === 'hosted' &&
          String(order.payment_status || '').toLowerCase() === 'pending'
      )
    }
    if (activeTab === 'new') {
      return allOrders.filter(
        (order) => order.status === 'pending' || order.status === 'ready_for_terminal'
      )
    }
    const mappedStatus = supabaseStatusForTab(activeTab)
    if (!mappedStatus) return []
    return allOrders.filter((order) => order.status === mappedStatus)
  }, [activeTab, allOrders])

  const tabCounts = useMemo(() => {
    const newCandidates = allOrders.filter(
      (order) => order.status === 'pending' || order.status === 'ready_for_terminal'
    )
    return {
      pending_payment: countPendingHostedOrders(allOrders),
      new: newCandidates.length,
      accepted: allOrders.filter((order) => order.status === 'accepted').length,
      preparing: allOrders.filter((order) => order.status === 'ready').length,
      ready: allOrders.filter((order) => order.status === 'ready').length,
      completed: allOrders.filter((order) => order.status === 'completed').length,
    } as Record<DashboardTabId, number>
  }, [allOrders])

  useEffect(() => {
    if (!user || !dashboardRestaurantId) return

    const newOrders = mergedSourceOrders

    const visibleOrders = newOrders.filter((order) => {
      if (activeTab === 'pending_payment') {
        return paymentChannelOf(order) === 'hosted' && order.payment_status === 'pending'
      }
      if (!shouldDisplayOrder(order)) {
        return false
      }
      if (activeTab === 'new') {
        if (isTabOrder(order)) return true
        if (isAtTablePaymentChannel(order)) return true
        if (order.payment_method === 'cash' || order.payment_method === 'other') return true
        if (order.payment_method === 'card_terminal' && order.payment_status === 'terminal_pending') return true
        if (paymentChannelOf(order) === 'terminal') return true
        if (order.payment_method === 'card' && order.payment_status === 'paid') return true
        if (
          order.payment_method === 'card' &&
          order.payment_status === 'pending' &&
          paymentChannelOf(order) === 'hosted'
        ) {
          return isRecentCardPendingOrder(order)
        }
        return false
      }
      return true
    })

    const sortNewTab = (list: Order[]) => {
      if (activeTab !== 'new') return list
      const rank = (o: Order) => {
        const term = paymentChannelOf(o) === 'terminal'
        if (term && o.status === 'ready_for_terminal') return 0
        if (term && o.payment_status === 'pending') return 1
        return 2
      }
      return [...list].sort((a, b) => {
        const ra = rank(a)
        const rb = rank(b)
        if (ra !== rb) return ra - rb
        const ta = toDate(a.placed_at)?.getTime() || 0
        const tb = toDate(b.placed_at)?.getTime() || 0
        return ta - tb
      })
    }

    const completedSortTime = (order: Order) =>
      toDate((order as Order & { completed_at?: unknown }).completed_at)?.getTime() ||
      toDate((order as Order & { accepted_at?: unknown }).accepted_at)?.getTime() ||
      toDate((order as Order & { updated_at?: unknown }).updated_at)?.getTime() ||
      toDate(order.placed_at)?.getTime() ||
      0

    const sortOrdersForTab = (list: Order[]) => {
      if (activeTab === 'new') return sortNewTab(list)
      if (activeTab === 'completed') {
        return [...list].sort((a, b) => completedSortTime(b) - completedSortTime(a))
      }
      return list
    }

    const sorted =
      activeTab === 'pending_payment' ? visibleOrders : sortOrdersForTab(visibleOrders)

    setOrders(sorted)
  }, [user, dashboardRestaurantId, activeTab, mergedSourceOrders])

  const refreshPendingHostedCount = useCallback(async () => {
    if (!dashboardRestaurantId || !orderScope) return
    const { count } = await supabase
      .from('orders')
      .select('*', { count: 'exact', head: true })
      .or(orderRestaurantOrFilter(orderScope))
      .eq('payment_status', 'pending')
      .eq('payment_channel', 'hosted')
      .eq('is_closed', false)
    setPendingHostedCount(count ?? 0)
  }, [dashboardRestaurantId, orderScope])

  const cancelAndFreeHostedOrder = async (orderId: string) => {
    if (!dashboardRestaurantId) return
    try {
      setCancellingHostedOrderId(orderId)
      const response = await fetch(`/api/orders/${encodeURIComponent(orderId)}/status`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          status: 'cancelled',
          payment_status: 'cancelled',
        }),
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(data?.error || 'Failed to cancel order')
      toast({
        title: 'Order cancelled',
        description: 'Checkout was cleared — staff can track new orders as usual.',
      })
      await refreshPendingHostedCount()
    } catch (e: unknown) {
      toast({
        title: 'Cancel failed',
        description: e instanceof Error ? e.message : 'Please try again.',
        variant: 'destructive',
      })
    } finally {
      setCancellingHostedOrderId(null)
    }
  }

  const minutesSincePlaced = (order: Order) => {
    const d = toDate(order.placed_at) || toDate((order as Order & { created_at?: unknown }).created_at)
    if (!d) return 0
    return Math.max(0, Math.floor((Date.now() - d.getTime()) / 60_000))
  }

  const isStatusUpdating = (orderId: string, action: string) =>
    statusUpdateKey === orderActionKey(orderId, action)

  const isOrderStatusBusy = (orderId: string) =>
    Boolean(statusUpdateKey?.startsWith(`${orderId}:`))

  const handleStatusUpdate = async (orderId: string, newStatus: OrderStatus) => {
    if (!dashboardRestaurantId) {
      toast({
        title: 'Update failed',
        description: 'Restaurant ID is missing',
        variant: 'destructive',
      })
      return
    }

    const actionKey = orderActionKey(orderId, newStatus)
    if (statusUpdateKey) return

    setStatusUpdateKey(actionKey)
    try {
      const response = await fetch(`/api/orders/${encodeURIComponent(orderId)}/status`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: newStatus }),
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) {
        throw new Error(data?.error || 'Failed to update order status')
      }
      const timestampField = `${newStatus}_at`
      setAllOrders((prev) =>
        prev.map((order) =>
          order.id === orderId
            ? { ...order, status: newStatus, [timestampField]: new Date().toISOString() }
            : order
        )
      )
      toast({
        title: 'Order updated',
        description: `Order status changed to ${newStatus}`,
      })
    } catch (error: any) {
      console.error(error)
      toast({
        title: 'Update failed',
        description: error.message || 'Failed to update order status',
        variant: 'destructive',
      })
    } finally {
      setStatusUpdateKey(null)
    }
  }

  const closeMarkPaidDialog = useCallback(() => {
    setShowMarkPaidDialog(false)
    setMarkPaidTargetOrderId(null)
  }, [])

  const applyPaidLocally = useCallback((orderId: string, paidAt: string) => {
    const paidPatch = { payment_status: 'paid', paid_at: paidAt }
    setAllOrders((list) =>
      list.map((order) => (order.id === orderId ? { ...order, ...paidPatch } : order))
    )
  }, [])

  const handleMarkAsPaid = async (orderId: string) => {
    if (!dashboardRestaurantId) {
      toast({
        title: 'Update failed',
        description: 'Restaurant ID is missing',
        variant: 'destructive',
      })
      return
    }

    if (markingPaidOrderId) return

    const previousOrder = orders.find((order) => order.id === orderId)
    setMarkingPaidOrderId(orderId)

    try {
      const response = await fetch(`/api/orders/${encodeURIComponent(orderId)}/status`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ payment_status: 'paid' }),
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) {
        throw new Error(data?.error || 'Failed to mark as paid')
      }

      const paidAt = String(data?.order?.paid_at || new Date().toISOString())
      applyPaidLocally(orderId, paidAt)
      closeMarkPaidDialog()

      toast({
        title: 'Payment recorded',
        description: 'Order has been marked as paid',
      })
    } catch (error: any) {
      if (previousOrder) {
        const revertPatch = {
          payment_status: previousOrder.payment_status,
          paid_at: (previousOrder as Order & { paid_at?: string | null }).paid_at ?? null,
        }
        const revert = (list: Order[]) =>
          list.map((order) => (order.id === orderId ? { ...order, ...revertPatch } : order))
        setAllOrders(revert)
      }

      console.error(error)
      toast({
        title: 'Failed to mark as paid',
        description: error.message || 'Failed to update payment status',
        variant: 'destructive',
      })
    } finally {
      setMarkingPaidOrderId(null)
    }
  }

  const handleSendToTerminal = async (order: Order, bypassReadyCheck = false) => {
    if (!dashboardRestaurantId) return
    if (sendingToTerminalOrderId === order.id) return
    try {
      setSendingToTerminalOrderId(order.id)
      setTerminalStatusByOrderId((prev) => ({ ...prev, [order.id]: 'pending' }))
      const response = await fetch('/api/payments/push-to-terminal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          orderId: order.id,
          amount: Number(order.total) || 0,
          tableNumber: order.table_number,
          orderNumber: order.order_number,
          restaurantId: dashboardRestaurantId,
          bypassReadyCheck,
        }),
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok || data?.success === false) {
        throw new Error(data?.error || 'Failed to send payment to terminal')
      }
      setTerminalPollingOrderIds((prev) => (prev.includes(order.id) ? prev : [...prev, order.id]))
      toast({ title: 'Payment sent to terminal' })
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Please try again.'
      setTerminalStatusByOrderId((prev) => ({ ...prev, [order.id]: 'failed' }))
      toast({
        title: 'Failed to send to terminal',
        description: message,
        variant: 'destructive',
      })
    } finally {
      setSendingToTerminalOrderId(null)
    }
  }

  const handleCancelTerminalPayment = async (order: Order) => {
    if (!dashboardRestaurantId) return
    try {
      setCancelingTerminalOrderId(order.id)
      const response = await fetch('/api/payments/cancel-terminal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orderId: order.id, restaurantId: dashboardRestaurantId }),
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok || data?.success === false) {
        throw new Error(data?.error || 'Failed to cancel terminal payment')
      }
      setTerminalPollingOrderIds((prev) => prev.filter((id) => id !== order.id))
      setTerminalStatusByOrderId((prev) => ({ ...prev, [order.id]: null }))
      toast({
        title: 'Terminal payment cancelled',
        description: 'Order reverted to cash pending.',
      })
    } catch (error: any) {
      toast({
        title: 'Cancel failed',
        description: error?.message || 'Please try again.',
        variant: 'destructive',
      })
    } finally {
      setCancelingTerminalOrderId(null)
    }
  }

  useEffect(() => {
    if (!dashboardRestaurantId || terminalPollingOrderIds.length === 0) return
    const timer = setInterval(async () => {
      const doneIds: string[] = []
      for (const orderId of terminalPollingOrderIds) {
        try {
          const { data } = await supabase
            .from('orders')
            .select('id,payment_status,order_number,terminal_status')
            .eq('id', orderId)
            .single()
          const orderRow = (data || null) as any
          const status = String(orderRow?.payment_status || '').toLowerCase()
          const terminalStatus = String(orderRow?.terminal_status || '').toLowerCase()
          if (status === 'paid') {
            doneIds.push(orderId)
            setTerminalStatusByOrderId((prev) => ({ ...prev, [orderId]: null }))
            toast({
              title: 'Payment confirmed',
              description: `Order #${orderRow?.order_number || orderId.slice(-6)} was paid on terminal.`,
            })
          } else if (terminalStatus === 'failed') {
            doneIds.push(orderId)
            setTerminalStatusByOrderId((prev) => ({ ...prev, [orderId]: 'failed' }))
          } else if (status !== 'terminal_pending') {
            doneIds.push(orderId)
          }
        } catch (e) {
          // keep polling on transient failures
        }
      }
      if (doneIds.length > 0) {
        setTerminalPollingOrderIds((prev) => prev.filter((id) => !doneIds.includes(id)))
      }
    }, 5000)
    return () => clearInterval(timer)
  }, [dashboardRestaurantId, terminalPollingOrderIds, toast])

  useEffect(() => {
    const terminalPendingIds = orders
      .filter((o) => o.payment_status === 'terminal_pending')
      .map((o) => o.id)
    if (terminalPendingIds.length === 0) return
    setTerminalPollingOrderIds((prev) => {
      const next = new Set([...prev, ...terminalPendingIds])
      return Array.from(next)
    })
  }, [orders])

  /**
   * STEP 4: Close Table functionality
   * 
   * Staff action to close a table session:
   * - Updates table_sessions/{id} status to "closed"
   * - Sets closed_at timestamp
   * - Once closed: Customer banner disappears, orders remain for audit
   * - Next QR scan creates a NEW session
   */
  const handleCloseTable = async (tableNumber: number) => {
    if (!dashboardRestaurantId) {
      toast({
        title: 'Error',
        description: 'Unable to close table. Missing restaurant ID.',
        variant: 'destructive',
      })
      return
    }

    const tableNum = Number(tableNumber)
    if (isNaN(tableNum) || tableNum <= 0) {
      toast({
        title: 'Invalid table number',
        description: `Table number ${tableNumber} is invalid.`,
        variant: 'destructive',
      })
      return
    }

    if (closingTableNumber !== null) return

    setClosingTableNumber(tableNum)
    try {
      if (!orderScope) {
        throw new Error('Restaurant scope not loaded')
      }
      const { data: openOrders, error: countError } = await supabase
        .from('orders')
        .select('id')
        .or(orderRestaurantOrFilter(orderScope))
        .eq('table_number', tableNum)
        .eq('is_closed', false)
      if (countError) throw countError

      const response = await fetch(`/api/tables/${encodeURIComponent(String(tableNum))}/close`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ restaurantId: dashboardRestaurantId }),
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) {
        throw new Error(data?.error || 'Failed to close table')
      }

      toast({
        title: 'Table closed',
        description: `Table ${tableNum} closed. ${openOrders?.length || 0} order(s) completed.`,
      })

      setShowCloseTableDialog(false)
      setCloseTableTargetNumber(null)
    } catch (error: any) {
      console.error(error)

      toast({
        title: 'Failed to close table',
        description: error.message || 'Failed to close table.',
        variant: 'destructive',
      })
    } finally {
      setClosingTableNumber(null)
    }
  }

  const getPaymentMethodIcon = (method: Order['payment_method']) => {
    switch (method) {
      case 'cash':
        return <Banknote className="h-4 w-4" />
      case 'card':
        return <CreditCard className="h-4 w-4" />
      default:
        return <DollarSign className="h-4 w-4" />
    }
  }

  const getPaymentMethodLabel = (order: Order) => {
    if (paymentChannelOf(order) === 'terminal') return 'Card Terminal'
    if (isTabOrder(order) && !paymentChannelOf(order)) return 'Tab'
    return String(order.payment_method || 'cash').replace(/_/g, ' ')
  }

  const getPaymentChannelBadge = (order: Order) => {
    const ch = paymentChannelOf(order)

    // Tab line items have no payment channel until the tab is settled — TAB badge is shown separately
    if (isTabOrder(order) && !ch) {
      return null
    }

    // Finatic hosted checkout only (never infer "online" from payment_method alone)
    if (ch === 'hosted') {
      return <Badge className="bg-blue-600 text-white font-semibold text-xs px-2.5 py-0.5">ONLINE</Badge>
    }
    if (ch === 'cash' || (order.payment_method === 'cash' && !ch)) {
      return <Badge className="bg-green-600 text-white font-semibold text-xs px-2.5 py-0.5">CASH</Badge>
    }
    if (ch === 'card_manual' || ch === 'terminal') {
      return <Badge className="bg-orange-500 text-white font-semibold text-xs px-2.5 py-0.5">CARD</Badge>
    }
    if (ch === 'other' || order.payment_method === 'other') {
      return <Badge className="bg-gray-500 text-white font-semibold text-xs px-2.5 py-0.5">OTHER</Badge>
    }
    if (order.payment_method === 'cash') {
      return <Badge className="bg-green-600 text-white font-semibold text-xs px-2.5 py-0.5">CASH</Badge>
    }
    return null
  }

  const getPaymentStatusBadge = (order: Order) => {
    if (order.payment_status === 'paid') {
      return (
        <Badge className="bg-green-500 text-white">
          <CheckCircle2 className="h-3 w-3 mr-1" />
          Paid
        </Badge>
      )
    }
    if (order.payment_status === 'terminal_pending') {
      return (
        <Badge className="bg-amber-500 text-white">
          <Clock className="h-3 w-3 mr-1" />
          Terminal Payment Pending
        </Badge>
      )
    }
    return (
      <Badge variant="outline" className="border-yellow-500 text-yellow-700 bg-yellow-50">
        <Clock className="h-3 w-3 mr-1" />
        Pending
      </Badge>
    )
  }

  const getTerminalStatus = (order: Order): TerminalStatus => {
    const local = terminalStatusByOrderId[order.id]
    if (local) return local
    const raw = String((order as Order & { terminal_status?: string | null }).terminal_status || '').toLowerCase()
    if (raw === 'pending' || raw === 'failed') return raw
    if (order.payment_status === 'terminal_pending') return 'pending'
    return null
  }

  const formatTimeAgo = (timestamp: any) => {
    if (!timestamp) return 'Just now'
    
    // Handle Firestore Timestamp objects
    let date: Date
    if (timestamp && typeof timestamp.toDate === 'function') {
      date = timestamp.toDate()
    } else if (timestamp instanceof Date) {
      date = timestamp
    } else if (typeof timestamp === 'string') {
      date = new Date(timestamp)
    } else if (typeof timestamp === 'number') {
      date = new Date(timestamp)
    } else {
      return 'Just now'
    }
    
    // Validate the date
    if (isNaN(date.getTime())) {
      return 'Just now'
    }
    
    const now = new Date()
    const diffMs = now.getTime() - date.getTime()
    
    // Handle negative differences (future dates)
    if (diffMs < 0) return 'Just now'
    
    const diffMins = Math.floor(diffMs / 60000)
    
    if (diffMins < 1) return 'Just now'
    if (diffMins < 60) return `${diffMins}m ago`
    const diffHours = Math.floor(diffMins / 60)
    if (diffHours < 24) return `${diffHours}h ago`
    const diffDays = Math.floor(diffHours / 24)
    return `${diffDays}d ago`
  }

  const getStatusColor = (status: OrderStatus) => {
    switch (status) {
      case 'pending':
        return 'border-red-500'
      case 'accepted':
        return 'border-blue-500'
      case 'preparing':
        return 'border-orange-500'
      case 'ready':
        return 'border-green-500'
      case 'ready_for_terminal':
        return 'border-orange-600'
      case 'completed':
        return 'border-gray-300'
      case 'cancelled':
        return 'border-red-300'
      default:
        return 'border-border'
    }
  }

  const getStatusBadge = (status: OrderStatus) => {
    switch (status) {
      case 'pending':
        return <Badge variant="destructive">New</Badge>
      case 'accepted':
        return <Badge className="bg-blue-500">Accepted</Badge>
      case 'preparing':
        return <Badge className="bg-orange-500">Preparing</Badge>
      case 'ready':
        return <Badge className="bg-green-500">Ready</Badge>
      case 'ready_for_terminal':
        return (
          <Badge className="bg-gradient-to-r from-orange-600 to-red-600 text-white border-0">READY FOR TERMINAL</Badge>
        )
      case 'completed':
        return <Badge variant="secondary">Completed</Badge>
      case 'cancelled':
        return <Badge variant="destructive">Cancelled</Badge>
      default:
        return <Badge variant="outline">{status}</Badge>
    }
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-muted/30 flex items-center justify-center">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-[#FF6B35]"></div>
      </div>
    )
  }

  return (
    <div
      className="min-h-screen bg-muted/30"
      onPointerDown={unlockNewOrderSound}
    >
      {/* Header */}
      <header className="bg-card border-b border-border">
        <div className="container mx-auto px-6 py-6 flex items-center justify-between">
          <div className="flex items-center gap-4">
            <Button
              variant="ghost"
              size="icon"
              onClick={() => router.push('/dashboard')}
              className="h-11 w-11"
            >
              <ArrowLeft className="h-5 w-5" />
            </Button>
            <h1 className="text-3xl font-bold">Live Orders</h1>
          </div>
          <Button
            variant="outline"
            size="icon"
            onClick={() => {
              setLoading(true)
              const scope = orderScopeRef.current
              if (!dashboardRestaurantId || !scope) {
                setLoading(false)
                return
              }
              void getAllOpenRestaurantOrders(dashboardRestaurantId, scope)
                .then((incoming) => {
                  const list = Array.isArray(incoming) ? (incoming as Order[]) : []
                  setAllOrders(list)
                  setPendingHostedCount(countPendingHostedOrders(list))
                })
                .catch((err) => console.error(err))
                .finally(() => setLoading(false))
            }}
          >
            <RefreshCw className="h-5 w-5" />
          </Button>
        </div>
      </header>

      {/* Tab Navigation */}
      <div className="bg-card border-b border-border">
        <div className="container mx-auto px-6">
          <div className="flex gap-2 overflow-x-auto">
            {tabs.map((tab) => {
              const count = tabCounts[tab.id] ?? 0
              return (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => setActiveTab(tab.id)}
                  className={cn(
                    'relative px-4 py-3 font-medium border-b-2 transition-colors whitespace-nowrap',
                    activeTab === tab.id
                      ? 'border-[#FF6B35] text-[#FF6B35]'
                      : 'border-transparent text-muted-foreground hover:text-foreground'
                  )}
                >
                  {tab.label} {count > 0 && `(${count})`}
                  {tab.id === 'pending_payment' && pendingHostedCount > 0 && (
                    <span className="absolute -top-1 -right-1 bg-yellow-500 text-white text-xs rounded-full min-w-[1rem] h-4 px-1 flex items-center justify-center">
                      {pendingHostedCount > 99 ? '99+' : pendingHostedCount}
                    </span>
                  )}
                </button>
              )
            })}
          </div>
        </div>
      </div>

      {/* Orders List */}
      <div className="container mx-auto px-6 py-6">
        {activeTab === 'pending_payment' ? (
          orders.length === 0 ? (
            <div className="text-center py-12 bg-card border rounded-lg">
              <div className="max-w-md mx-auto">
                <div className="text-6xl mb-4">💳</div>
                <h3 className="text-xl font-semibold mb-2">No pending online checkouts</h3>
                <p className="text-muted-foreground">
                  Customers who open Finatic but don&apos;t pay within 10 minutes are expired automatically.
                </p>
              </div>
            </div>
          ) : (
            <div className="grid gap-4 max-w-3xl">
              {orders.map((order) => {
                const items = Array.isArray(order.items) ? order.items : []
                const line = items
                  .map((item: { quantity?: number; name?: string; display_name?: string }) => {
                    const q = item?.quantity ?? 1
                    const n = item?.display_name || item?.name || 'Item'
                    return `${q}× ${n}`
                  })
                  .join(', ')
                return (
                  <div
                    key={order.id}
                    className="border border-yellow-200 bg-yellow-50 rounded-lg p-4 text-left"
                  >
                    <div className="flex justify-between items-start gap-3 mb-2">
                      <div>
                        <span className="font-bold text-foreground">Table {order.table_number ?? '—'}</span>
                        <Badge className="ml-2 bg-yellow-500 text-white border-0">Awaiting Payment</Badge>
                        <p className="text-yellow-800 text-sm mt-1 font-sans">
                          Awaiting payment for {minutesSincePlaced(order)} min
                          {minutesSincePlaced(order) === 1 ? '' : 's'}
                        </p>
                      </div>
                      <Button
                        type="button"
                        size="sm"
                        className="bg-red-500 text-white hover:bg-red-600 shrink-0"
                        disabled={cancellingHostedOrderId === order.id}
                        onClick={() => void cancelAndFreeHostedOrder(order.id)}
                      >
                        <ActionButtonContent
                          loading={cancellingHostedOrderId === order.id}
                          label="Cancel & Free Table"
                          loadingLabel="Cancelling…"
                        />
                      </Button>
                    </div>
                    <p className="text-sm text-muted-foreground font-sans line-clamp-3">
                      {line || 'No line items'}
                    </p>
                    <p className="font-bold mt-2 font-sans text-foreground">
                      {restaurant?.currency || 'N$'}
                      {(Number(order.total) || 0).toFixed(2)}
                    </p>
                  </div>
                )
              })}
            </div>
          )
        ) : orders.length === 0 ? (
          <div className="text-center py-12 bg-card border rounded-lg">
            <div className="max-w-md mx-auto">
              <div className="text-6xl mb-4">📋</div>
              <h3 className="text-xl font-semibold mb-2">No {activeTab} orders</h3>
              <p className="text-muted-foreground">
                {activeTab === 'new' 
                  ? 'New orders will appear here when customers place them.'
                  : `No ${activeTab} orders at the moment.`
                }
              </p>
            </div>
          </div>
        ) : (
          <div className="grid gap-4 lg:grid-cols-2">
            {orders.map((order) => {
              // DEFENSIVE NORMALIZATION: Ensure items is always an array before rendering
              // This prevents "Cannot read property 'length' of undefined" errors
              const normalizedOrder = {
                ...order,
                items: Array.isArray(order.items) ? order.items : [],
                customer: order.customer || {},
              }

              const customerReadyToPay = isCustomerReadyToPay(normalizedOrder)

              return (
              <div
                key={order.id}
                className={cn(
                  'bg-card border-2 rounded-lg p-6 space-y-4',
                  getStatusColor(order.status as OrderStatus),
                  customerReadyToPay && 'order-card-ready-to-pay'
                )}
              >
                {/* Order Header */}
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3 flex-wrap">
                    <span className="text-lg font-bold">#{normalizedOrder.order_number || 'N/A'}</span>
                    <Badge variant="secondary">Table {normalizedOrder.table_number || 0}</Badge>
                    {normalizedOrder.tab_id && (
                      <Badge className="bg-purple-600 text-white">
                        TAB {String(normalizedOrder.tab_id).slice(-6)}
                      </Badge>
                    )}
                    {getStatusBadge(normalizedOrder.status as OrderStatus)}
                    {getPaymentChannelBadge(normalizedOrder)}
                    {getPaymentStatusBadge(normalizedOrder)}
                  </div>
                  <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Clock className="h-4 w-4" />
                    {formatTimeAgo(normalizedOrder.placed_at)}
                  </div>
                </div>

                <div className="text-right">
                  <span className="text-lg font-bold">
                    {restaurant?.currency || 'N$'}{(normalizedOrder.total ?? 0).toFixed(2)}
                  </span>
                </div>

                {/* Order Items - DEFENSIVE: Use normalizedOrder.items which is guaranteed to be an array */}
                <div className="space-y-2 border-t pt-3">
                  {normalizedOrder.items.length > 0 ? (
                    normalizedOrder.items.map((item: any, index: number) => (
                      <div key={index} className="text-sm">
                        <span className="font-medium">
                          {item?.quantity ?? 1}× {item?.display_name || item?.name || 'Unknown Item'}
                        </span>
                        {item?.selected_variants && typeof item.selected_variants === 'object' && (
                          <span className="text-muted-foreground ml-2">
                            {Object.values(item.selected_variants).filter(Boolean).join(' / ')}
                          </span>
                        )}
                        {item?.selected_size?.name && (
                          <span className="text-muted-foreground ml-2">
                            ({item.selected_size.name})
                          </span>
                        )}
                        {Array.isArray(item?.selected_addons) && item.selected_addons.length > 0 && (
                          <span className="text-muted-foreground ml-2">
                            +{item.selected_addons.map((a: any) => a?.name ?? '').filter(Boolean).join(', ')}
                          </span>
                        )}
                        {item?.special_instructions && (
                          <div className="text-xs text-muted-foreground italic mt-1">
                            "{item.special_instructions}"
                          </div>
                        )}
                      </div>
                    ))
                  ) : (
                    <div className="text-sm text-muted-foreground italic">
                      No items in this order
                    </div>
                  )}
                </div>

                {/* Order Instructions */}
                {normalizedOrder.order_instructions && (
                  <div className="bg-yellow-50 border border-yellow-200 rounded-md p-3">
                    <p className="text-sm text-yellow-900 font-medium">Order Instructions:</p>
                    <p className="text-sm text-yellow-800">{normalizedOrder.order_instructions}</p>
                  </div>
                )}

                {/* Table Session Info */}
                {normalizedOrder.table_session_id && (
                  <div className="text-sm text-muted-foreground">
                    Session: {normalizedOrder.table_session_id.slice(0, 12)}...
                  </div>
                )}

                {customerReadyToPay && (
                  <div
                    className="w-full rounded-md bg-amber-500 px-4 py-3 text-center text-sm font-bold text-white shadow-sm"
                    role="status"
                    aria-live="polite"
                  >
                    🔔 Customer is ready to pay
                  </div>
                )}

                {/* Close Table Button - Only show for staff */}
                {normalizedOrder.table_number && (
                  <div className="pt-2">
                    <Button
                      variant="outline"
                      className="w-full border-red-300 text-red-600 hover:bg-red-50"
                      onClick={() => {
                        setCloseTableTargetNumber(normalizedOrder.table_number)
                        setShowCloseTableDialog(true)
                      }}
                      disabled={closingTableNumber === normalizedOrder.table_number}
                    >
                      <ActionButtonContent
                        loading={closingTableNumber === normalizedOrder.table_number}
                        icon={DoorClosed}
                        label="Close Table"
                        loadingLabel="Closing..."
                      />
                    </Button>
                  </div>
                )}

                {/* Manual payment: mark paid for cash and card at table */}
                {canMarkManualPaid(normalizedOrder) && !isOrderPaid(normalizedOrder) && (
                    <div className="pt-2 space-y-2">
                      <Button
                        variant="outline"
                        className="w-full"
                        onClick={() => {
                          setMarkPaidTargetOrderId(normalizedOrder.id)
                          setShowMarkPaidDialog(true)
                        }}
                        disabled={markingPaidOrderId === normalizedOrder.id}
                      >
                        <ActionButtonContent
                          loading={markingPaidOrderId === normalizedOrder.id}
                          icon={DollarSign}
                          label="Mark as Paid"
                          loadingLabel="Marking as Paid..."
                        />
                      </Button>
                    </div>
                  )}

                {/* Card + physical terminal (Finatic): wait for customer, then push */}
                {normalizedOrder.payment_method === 'card' &&
                  paymentChannelOf(normalizedOrder) === 'terminal' &&
                  normalizedOrder.payment_status === 'pending' && (
                    <div className="pt-2 space-y-2">
                      {getTerminalStatus(normalizedOrder) === 'failed' && (
                        <div className="bg-red-100 text-red-700 px-3 py-1 rounded text-sm font-medium">
                          Payment Failed - Retry
                        </div>
                      )}
                      {getTerminalStatus(normalizedOrder) === 'pending' && (
                        <div className="bg-yellow-100 text-yellow-700 px-3 py-1 rounded text-sm font-medium inline-flex items-center gap-2">
                          <RefreshCw className="h-3 w-3 animate-spin" />
                          Awaiting Payment...
                        </div>
                      )}
                      {(() => {
                        const readyAt = Boolean(
                          (normalizedOrder as Order & { ready_for_terminal_at?: unknown })
                            .ready_for_terminal_at
                        )
                        const ready =
                          normalizedOrder.status === 'ready_for_terminal' || readyAt
                        const canSendToTerminal =
                          ready || paymentChannelOf(normalizedOrder) === 'terminal'
                        const isSending = sendingToTerminalOrderId === normalizedOrder.id
                        return (
                          <>
                            {!ready && (
                              <p className="text-sm text-muted-foreground font-sans">
                                Waiting for customer to request terminal
                              </p>
                            )}
                            <Button
                              className="w-full bg-[#FF6B35] hover:bg-[#e55a28] disabled:opacity-50 disabled:pointer-events-none"
                              onClick={() => handleSendToTerminal(normalizedOrder)}
                              disabled={isSending || !canSendToTerminal || getTerminalStatus(normalizedOrder) === 'pending'}
                            >
                              <ActionButtonContent
                                loading={isSending}
                                icon={CreditCard}
                                label="Send to Terminal"
                                loadingLabel="Sending to terminal..."
                              />
                            </Button>
                            {!ready && (
                              <Button
                                variant="ghost"
                                className="h-auto w-full p-0 text-xs font-normal text-muted-foreground hover:text-foreground"
                                onClick={() => handleSendToTerminal(normalizedOrder, true)}
                                disabled={isSending}
                              >
                                {isSending ? (
                                  <span className="inline-flex items-center gap-2 py-1">
                                    <ButtonSpinner />
                                    Sending...
                                  </span>
                                ) : (
                                  'Send Anyway'
                                )}
                              </Button>
                            )}
                          </>
                        )
                      })()}
                    </div>
                  )}

                {normalizedOrder.payment_status === 'terminal_pending' && (
                  <div className="pt-2 space-y-2">
                    <Button
                      className="w-full bg-amber-600 hover:bg-amber-700"
                      disabled
                    >
                      <Clock className="h-4 w-4 mr-2" />
                      Waiting for payment...
                    </Button>
                    <Button
                      variant="outline"
                      className="w-full border-red-300 text-red-600 hover:bg-red-50"
                      onClick={() => handleCancelTerminalPayment(normalizedOrder)}
                      disabled={cancelingTerminalOrderId === normalizedOrder.id}
                    >
                      <ActionButtonContent
                        loading={cancelingTerminalOrderId === normalizedOrder.id}
                        label="Cancel Terminal Payment"
                        loadingLabel="Canceling terminal payment..."
                      />
                    </Button>
                  </div>
                )}

                {/* Action Buttons */}
                <div className="flex gap-3 pt-2">
                  {(normalizedOrder.status === 'pending' || normalizedOrder.status === 'ready_for_terminal') && (
                    <>
                      <Button
                        variant="outline"
                        className="flex-1"
                        onClick={() => handleStatusUpdate(normalizedOrder.id, 'cancelled')}
                        disabled={isOrderStatusBusy(normalizedOrder.id)}
                      >
                        <ActionButtonContent
                          loading={isStatusUpdating(normalizedOrder.id, 'cancelled')}
                          icon={XCircle}
                          label="Decline"
                          loadingLabel="Declining..."
                        />
                      </Button>
                      <Button
                        className="flex-1 bg-[#FF6B35] hover:bg-[#e55a28]"
                        onClick={() => handleStatusUpdate(normalizedOrder.id, 'accepted')}
                        disabled={isOrderStatusBusy(normalizedOrder.id)}
                      >
                        <ActionButtonContent
                          loading={isStatusUpdating(normalizedOrder.id, 'accepted')}
                          icon={CheckCircle2}
                          label="Accept & Start"
                          loadingLabel="Accepting..."
                        />
                      </Button>
                    </>
                  )}
                  {normalizedOrder.status === 'accepted' && (
                    <Button
                      className="flex-1 bg-blue-500 hover:bg-blue-600"
                      onClick={() => handleStatusUpdate(normalizedOrder.id, 'ready')}
                      disabled={isOrderStatusBusy(normalizedOrder.id)}
                    >
                      <ActionButtonContent
                        loading={isStatusUpdating(normalizedOrder.id, 'ready')}
                        icon={ChefHat}
                        label="Start Preparing"
                        loadingLabel="Updating..."
                      />
                    </Button>
                  )}
                  {normalizedOrder.status === 'ready' && (
                    <Button
                      className="flex-1 bg-green-500 hover:bg-green-600"
                      onClick={() => handleStatusUpdate(normalizedOrder.id, 'completed')}
                      disabled={isOrderStatusBusy(normalizedOrder.id)}
                    >
                      <ActionButtonContent
                        loading={isStatusUpdating(normalizedOrder.id, 'completed')}
                        icon={CheckCircle2}
                        label="Complete Order"
                        loadingLabel="Completing..."
                      />
                    </Button>
                  )}
                </div>
              </div>
            )})}
          </div>
        )}
      </div>

      {/* Mark as Paid Confirmation Dialog */}
      <Dialog
        open={showMarkPaidDialog}
        onOpenChange={(open) => {
          setShowMarkPaidDialog(open)
          if (!open) {
            setMarkPaidTargetOrderId(null)
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Mark Order as Paid</DialogTitle>
            <DialogDescription>
              Are you sure you want to mark this order as paid? This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={closeMarkPaidDialog}
              disabled={Boolean(markingPaidOrderId)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              className="bg-[#FF6B35] hover:bg-[#e55a28]"
              onClick={() => {
                if (markPaidTargetOrderId) {
                  void handleMarkAsPaid(markPaidTargetOrderId)
                }
              }}
              disabled={!markPaidTargetOrderId || Boolean(markingPaidOrderId)}
            >
              <ActionButtonContent
                loading={Boolean(markingPaidOrderId)}
                label="Mark as Paid"
                loadingLabel="Marking as Paid..."
              />
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Close Table Confirmation Dialog */}
      <Dialog
        open={showCloseTableDialog}
        onOpenChange={(open) => {
          if (!open && closingTableNumber === null) {
            setShowCloseTableDialog(false)
            setCloseTableTargetNumber(null)
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Close Table</DialogTitle>
            <DialogDescription>
              Are you sure you want to close Table {closeTableTargetNumber}? 
              This will end the current session. Customers will need to scan the QR code again to start a new session.
              Existing orders will remain for audit purposes.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setShowCloseTableDialog(false)
                setCloseTableTargetNumber(null)
              }}
              disabled={closingTableNumber !== null}
            >
              Cancel
            </Button>
            <Button
              className="bg-red-600 hover:bg-red-700 text-white"
              onClick={() => {
                if (closeTableTargetNumber) {
                  void handleCloseTable(closeTableTargetNumber)
                }
              }}
              disabled={!closeTableTargetNumber || closingTableNumber !== null}
            >
              <ActionButtonContent
                loading={closingTableNumber !== null}
                icon={DoorClosed}
                label="Close Table"
                loadingLabel="Closing..."
              />
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
