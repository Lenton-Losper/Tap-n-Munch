'use client'

import { useEffect, useMemo, useState } from 'react'
import { useAuth } from '@/components/auth/auth-provider'
import { subscribeToOrders, updateOrderPayment, Order } from '@/lib/firebase/orders'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { RefreshCw, Clock, ArrowLeft, CheckCircle2, ChefHat, Package, XCircle, Banknote, CreditCard, DollarSign, DoorClosed } from 'lucide-react'
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

// PART 2: Standardize Order Status Model
type OrderStatus =
  | 'new'
  | 'accepted'
  | 'preparing'
  | 'ready'
  | 'ready_for_terminal'
  | 'completed'
  | 'cancelled'

function paymentChannelOf(order: Order): string {
  return String((order as Order & { payment_channel?: string }).payment_channel || '').toLowerCase()
}

const tabs: { id: OrderStatus; label: string }[] = [
  { id: 'new', label: 'New Orders' },
  { id: 'accepted', label: 'Accepted' },
  { id: 'preparing', label: 'Preparing' },
  { id: 'ready', label: 'Ready' },
  { id: 'completed', label: 'Completed' },
]

export function OrdersDashboard() {
  const { user, restaurantId, restaurant } = useAuth()
  const router = useRouter()
  const { toast } = useToast()
  const [activeTab, setActiveTab] = useState<OrderStatus>('new')
  const [orders, setOrders] = useState<Order[]>([])
  const [primaryOrders, setPrimaryOrders] = useState<Order[]>([])
  const [readyTerminalOrders, setReadyTerminalOrders] = useState<Order[]>([])
  const [loading, setLoading] = useState(true)
  const [markingPaidOrderId, setMarkingPaidOrderId] = useState<string | null>(null)
  const [showMarkPaidDialog, setShowMarkPaidDialog] = useState(false)
  const [closingTableNumber, setClosingTableNumber] = useState<number | null>(null)
  const [showCloseTableDialog, setShowCloseTableDialog] = useState(false)
  const [sendingToTerminalOrderId, setSendingToTerminalOrderId] = useState<string | null>(null)
  const [cancelingTerminalOrderId, setCancelingTerminalOrderId] = useState<string | null>(null)
  const [terminalPollingOrderIds, setTerminalPollingOrderIds] = useState<string[]>([])
  const dashboardRestaurantId = String((restaurant as { firebase_id?: string } | null)?.firebase_id || restaurantId || '')

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
    if (paymentChannelOf(order) === 'terminal') return true
    const createdDate = toDate((order as Order & { created_at?: unknown }).created_at) || toDate(order.placed_at)
    if (!createdDate) return true
    return Date.now() - createdDate.getTime() < 5 * 60 * 1000
  }

  const shouldDisplayOrder = (order: Order) => {
    const isPaidSettlementOrder =
      String((order as Order & { tab_settlement_for_tab_id?: string | null }).tab_settlement_for_tab_id || '').trim() !== '' &&
      String(order.payment_status || '').toLowerCase() === 'paid'
    if (isPaidSettlementOrder) return false

    if (order.payment_method === 'cash') return true
    if (order.payment_method === 'card_terminal') return true
    if (order.payment_method === 'card') {
      if (paymentChannelOf(order) === 'terminal' && order.payment_status === 'pending') return true
      if (order.payment_status === 'paid') return true
      return isRecentCardPendingOrder(order)
    }
    return true
  }

  // Don't run if user is null (prevents fetching when signed out)
  useEffect(() => {
    if (!user) {
      console.log('⚠️ Dashboard: User not authenticated')
      setLoading(false)
      return
    }

    if (!dashboardRestaurantId) {
      console.log('⚠️ Dashboard: No restaurantId available')
      setLoading(false)
      return
    }

    console.log('[DASHBOARD] subscribing with restaurantId:', dashboardRestaurantId)

    const unsubscribe = subscribeToOrders(dashboardRestaurantId, activeTab, (newOrders) => {
      setPrimaryOrders(newOrders)
      setLoading(false)
    })

    return () => unsubscribe()
  }, [user, dashboardRestaurantId, activeTab])

  useEffect(() => {
    if (!user || !dashboardRestaurantId || activeTab !== 'new') {
      setReadyTerminalOrders([])
      return
    }
    const unsubscribe = subscribeToOrders(dashboardRestaurantId, 'ready_for_terminal', setReadyTerminalOrders)
    return () => unsubscribe()
  }, [user, dashboardRestaurantId, activeTab])

  const mergedSourceOrders = useMemo(() => {
    if (activeTab !== 'new') return primaryOrders
    const byId = new Map<string, Order>()
    readyTerminalOrders.forEach((o) => byId.set(o.id, o))
    primaryOrders.forEach((o) => byId.set(o.id, o))
    return Array.from(byId.values())
  }, [activeTab, primaryOrders, readyTerminalOrders])

  useEffect(() => {
    if (!user || !dashboardRestaurantId) return

    const newOrders = mergedSourceOrders

    newOrders.forEach((order) => {
      const tabId = (order as Order & { tab_id?: string }).tab_id
      if (order.payment_status === 'paid' && order.status === 'new') {
        console.warn('[OrdersDashboard] PAID but workflow status still NEW (e.g. webhook missed accepted):', {
          id: order.id,
          order_number: order.order_number,
          payment_method: order.payment_method,
          tab_id: tabId ?? null,
          has_tab: Boolean(tabId),
        })
      }
      if (Number(order.order_number) === 64) {
        console.log('[OrdersDashboard] trace order #64:', {
          id: order.id,
          order_number: order.order_number,
          status: order.status,
          payment_status: order.payment_status,
          tab_id: tabId ?? null,
          activeTab,
          passes_shouldDisplay: shouldDisplayOrder(order),
        })
      }
    })

    const visibleOrders = newOrders.filter((order) => {
      if (!shouldDisplayOrder(order)) {
        return false
      }
      if (activeTab === 'new') {
        if (order.payment_method === 'cash') return true
        if (order.payment_method === 'card_terminal' && order.payment_status === 'terminal_pending') return true
        if (
          order.payment_method === 'card' &&
          order.payment_status === 'pending' &&
          isRecentCardPendingOrder(order)
        ) {
          return true
        }
        if (order.payment_method === 'card' && order.payment_status === 'paid' && order.status === 'new') {
          return true
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

    const sorted = sortNewTab(visibleOrders)

    console.log('📦 Dashboard: Received', newOrders.length, 'merged orders for status:', activeTab)
    if (sorted.length > 0) {
      console.log('📦 Dashboard: First order details:', {
        id: sorted[0].id,
        order_number: sorted[0].order_number,
        status: sorted[0].status,
        restaurant_id: sorted[0].restaurant_id,
        table_number: sorted[0].table_number,
      })
    }
    setOrders(sorted)

    if (activeTab === 'new' && sorted.length === 0) {
      console.log('⚠️ Dashboard: No orders found for status:', activeTab)
      console.log('⚠️ Dashboard: Query parameters:', {
        restaurantId: dashboardRestaurantId,
        status: activeTab,
      })
    }
  }, [user, dashboardRestaurantId, activeTab, mergedSourceOrders])

  const handleStatusUpdate = async (orderId: string, newStatus: OrderStatus) => {
    if (!dashboardRestaurantId) {
      toast({
        title: 'Update failed',
        description: 'Restaurant ID is missing',
        variant: 'destructive',
      })
      return
    }
    
    console.log('🔄 [DASHBOARD] Updating order status to:', newStatus, {
      orderId,
      restaurantId: dashboardRestaurantId,
    })
    
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
      console.log('✅ [DASHBOARD] Order status updated successfully')
      toast({
        title: 'Order updated',
        description: `Order status changed to ${newStatus}`,
      })
    } catch (error: any) {
      console.error('❌ [DASHBOARD] Failed to update order status:', {
        orderId,
        restaurantId: dashboardRestaurantId,
        newStatus,
        errorCode: error.code,
        errorMessage: error.message,
        errorStack: error.stack,
      })
      toast({
        title: 'Update failed',
        description: error.message || 'Failed to update order status',
        variant: 'destructive',
      })
    }
  }

  const handleMarkAsPaid = async (orderId: string) => {
    if (!dashboardRestaurantId) {
      toast({
        title: 'Update failed',
        description: 'Restaurant ID is missing',
        variant: 'destructive',
      })
      return
    }
    
    try {
      setMarkingPaidOrderId(orderId)
      await updateOrderPayment(dashboardRestaurantId, orderId, 'paid', user?.id)
      toast({
        title: 'Payment recorded',
        description: 'Order has been marked as paid',
      })
      setShowMarkPaidDialog(false)
      setMarkingPaidOrderId(null)
    } catch (error: any) {
      console.error('❌ [DASHBOARD] Failed to mark order as paid:', {
        orderId,
        restaurantId: dashboardRestaurantId,
        errorCode: error.code,
        errorMessage: error.message,
        errorStack: error.stack,
      })
      toast({
        title: 'Failed to mark as paid',
        description: error.message || 'Failed to update payment status',
        variant: 'destructive',
      })
      setMarkingPaidOrderId(null)
    }
  }

  const handleSendToTerminal = async (order: Order, bypassReadyCheck = false) => {
    if (!dashboardRestaurantId) return
    try {
      setSendingToTerminalOrderId(order.id)
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
            .select('id,payment_status,order_number')
            .eq('id', orderId)
            .eq('firebase_restaurant_id', dashboardRestaurantId)
            .single()
          const status = String(data?.payment_status || '').toLowerCase()
          if (status === 'paid') {
            doneIds.push(orderId)
            toast({
              title: 'Payment confirmed',
              description: `Order #${data?.order_number || orderId.slice(-6)} was paid on terminal.`,
            })
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

    try {
      setClosingTableNumber(tableNumber)
      const tableNum = Number(tableNumber)
      if (isNaN(tableNum) || tableNum <= 0) {
        toast({
          title: 'Invalid table number',
          description: `Table number ${tableNumber} is invalid.`,
          variant: 'destructive',
        })
        setClosingTableNumber(null)
        return
      }

      const { data: openOrders, error: countError } = await supabase
        .from('orders')
        .select('id')
        .eq('firebase_restaurant_id', dashboardRestaurantId)
        .eq('table_number', Number(tableNum))
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
      setClosingTableNumber(null)
    } catch (error: any) {
      console.error('❌ [CLOSE TABLE] Error closing table:', {
        error: error.message,
        code: error.code,
        tableNumber,
        restaurantId: dashboardRestaurantId,
      })

      toast({
        title: 'Failed to close table',
        description: error.message || 'Failed to close table. Please check console for details.',
        variant: 'destructive',
      })
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
    return String(order.payment_method || 'cash').replace(/_/g, ' ')
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
      console.warn('⚠️ [TIMER] Invalid timestamp format:', timestamp)
      return 'Just now'
    }
    
    // Validate the date
    if (isNaN(date.getTime())) {
      console.warn('⚠️ [TIMER] Invalid date value:', timestamp)
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
      case 'new':
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
      case 'new':
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
    <div className="min-h-screen bg-muted/30">
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
            onClick={() => setLoading(true)}
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
              const count =
                tab.id === 'new' && activeTab === 'new'
                  ? orders.length
                  : orders.filter((o) => o.status === tab.id).length
              return (
                <button
                  key={tab.id}
                  onClick={() => setActiveTab(tab.id)}
                  className={cn(
                    'px-4 py-3 font-medium border-b-2 transition-colors whitespace-nowrap',
                    activeTab === tab.id
                      ? 'border-[#FF6B35] text-[#FF6B35]'
                      : 'border-transparent text-muted-foreground hover:text-foreground'
                  )}
                >
                  {tab.label} {count > 0 && `(${count})`}
                </button>
              )
            })}
          </div>
        </div>
      </div>

      {/* Orders List */}
      <div className="container mx-auto px-6 py-6">
        {orders.length === 0 ? (
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

              return (
              <div
                key={order.id}
                className={cn(
                  'bg-card border-2 rounded-lg p-6 space-y-4',
                  getStatusColor(order.status)
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
                    {getStatusBadge(normalizedOrder.status)}
                    {getPaymentStatusBadge(normalizedOrder)}
                    <div className="flex items-center gap-1 text-sm text-muted-foreground">
                      {getPaymentMethodIcon(normalizedOrder.payment_method)}
                      <span className="capitalize">{getPaymentMethodLabel(normalizedOrder)}</span>
                    </div>
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

                {/* Close Table Button - Only show for staff */}
                {normalizedOrder.table_number && (
                  <div className="pt-2">
                    <Button
                      variant="outline"
                      className="w-full border-red-300 text-red-600 hover:bg-red-50"
                      onClick={() => {
                        setClosingTableNumber(normalizedOrder.table_number)
                        setShowCloseTableDialog(true)
                      }}
                      disabled={closingTableNumber === normalizedOrder.table_number}
                    >
                      <DoorClosed className="h-4 w-4 mr-2" />
                      {closingTableNumber === normalizedOrder.table_number ? 'Closing...' : 'Close Table'}
                    </Button>
                  </div>
                )}

                {/* Cash: mark paid only */}
                {normalizedOrder.payment_method === 'cash' &&
                  normalizedOrder.payment_status === 'cash_pending' && (
                    <div className="pt-2 space-y-2">
                      <Button
                        variant="outline"
                        className="w-full"
                        onClick={() => {
                          setMarkingPaidOrderId(normalizedOrder.id)
                          setShowMarkPaidDialog(true)
                        }}
                        disabled={markingPaidOrderId === normalizedOrder.id}
                      >
                        <DollarSign className="h-4 w-4 mr-2" />
                        {markingPaidOrderId === normalizedOrder.id ? 'Marking as Paid...' : 'Mark as Paid'}
                      </Button>
                    </div>
                  )}

                {/* Card + physical terminal (Finatic): wait for customer, then push */}
                {normalizedOrder.payment_method === 'card' &&
                  paymentChannelOf(normalizedOrder) === 'terminal' &&
                  normalizedOrder.payment_status === 'pending' && (
                    <div className="pt-2 space-y-2">
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
                              disabled={isSending || !canSendToTerminal}
                            >
                              <CreditCard className="h-4 w-4 mr-2" />
                              {isSending ? 'Sending to terminal...' : 'Send to Terminal'}
                            </Button>
                            {!ready && (
                              <Button
                                variant="ghost"
                                className="h-auto w-full p-0 text-xs font-normal text-muted-foreground hover:text-foreground"
                                onClick={() => handleSendToTerminal(normalizedOrder, true)}
                                disabled={isSending}
                              >
                                Send Anyway
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
                      {cancelingTerminalOrderId === normalizedOrder.id
                        ? 'Canceling terminal payment...'
                        : 'Cancel Terminal Payment'}
                    </Button>
                  </div>
                )}

                {/* Action Buttons */}
                <div className="flex gap-3 pt-2">
                  {(normalizedOrder.status === 'new' || normalizedOrder.status === 'ready_for_terminal') && (
                    <>
                      <Button
                        variant="outline"
                        className="flex-1"
                        onClick={() => handleStatusUpdate(normalizedOrder.id, 'cancelled')}
                      >
                        <XCircle className="h-4 w-4 mr-2" />
                        Decline
                      </Button>
                      <Button
                        className="flex-1 bg-[#FF6B35] hover:bg-[#e55a28]"
                        onClick={() => handleStatusUpdate(normalizedOrder.id, 'accepted')}
                      >
                        <CheckCircle2 className="h-4 w-4 mr-2" />
                        Accept & Start
                      </Button>
                    </>
                  )}
                  {normalizedOrder.status === 'accepted' && (
                    <Button
                      className="flex-1 bg-blue-500 hover:bg-blue-600"
                      onClick={() => handleStatusUpdate(normalizedOrder.id, 'preparing')}
                    >
                      <ChefHat className="h-4 w-4 mr-2" />
                      Start Preparing
                    </Button>
                  )}
                  {normalizedOrder.status === 'preparing' && (
                    <Button
                      className="flex-1 bg-orange-500 hover:bg-orange-600"
                      onClick={() => handleStatusUpdate(normalizedOrder.id, 'ready')}
                    >
                      <Package className="h-4 w-4 mr-2" />
                      Mark as Ready
                    </Button>
                  )}
                  {normalizedOrder.status === 'ready' && (
                    <Button
                      className="flex-1 bg-green-500 hover:bg-green-600"
                      onClick={() => handleStatusUpdate(normalizedOrder.id, 'completed')}
                    >
                      <CheckCircle2 className="h-4 w-4 mr-2" />
                      Complete Order
                    </Button>
                  )}
                </div>
              </div>
            )})}
          </div>
        )}
      </div>

      {/* Mark as Paid Confirmation Dialog */}
      <Dialog open={showMarkPaidDialog} onOpenChange={setShowMarkPaidDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Mark Order as Paid</DialogTitle>
            <DialogDescription>
              Are you sure you want to mark this order as paid? This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setShowMarkPaidDialog(false)
                setMarkingPaidOrderId(null)
              }}
            >
              Cancel
            </Button>
            <Button
              className="bg-[#FF6B35] hover:bg-[#e55a28]"
              onClick={() => {
                if (markingPaidOrderId) {
                  handleMarkAsPaid(markingPaidOrderId)
                }
              }}
              disabled={!markingPaidOrderId}
            >
              Mark as Paid
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Close Table Confirmation Dialog */}
      <Dialog open={showCloseTableDialog} onOpenChange={setShowCloseTableDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Close Table</DialogTitle>
            <DialogDescription>
              Are you sure you want to close Table {closingTableNumber}? 
              This will end the current session. Customers will need to scan the QR code again to start a new session.
              Existing orders will remain for audit purposes.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setShowCloseTableDialog(false)
                setClosingTableNumber(null)
              }}
            >
              Cancel
            </Button>
            <Button
              className="bg-red-600 hover:bg-red-700 text-white"
              onClick={() => {
                if (closingTableNumber) {
                  handleCloseTable(closingTableNumber)
                }
              }}
              disabled={!closingTableNumber}
            >
              Close Table
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
