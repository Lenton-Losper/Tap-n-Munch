'use client'

import { useEffect, useState } from 'react'
import { useAuth } from '@/components/auth/auth-provider'
import { subscribeToOrders, updateOrderStatus, updateOrderPayment, Order } from '@/lib/firebase/orders'
import { getRestaurant } from '@/lib/firebase/restaurants'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { RefreshCw, Clock, ArrowLeft, CheckCircle2, ChefHat, Package, XCircle, Banknote, CreditCard, DollarSign, DoorClosed } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useRouter } from 'next/navigation'
import { useToast } from '@/hooks/use-toast'
import { collection, query, where, getDocs, updateDoc, doc, serverTimestamp } from 'firebase/firestore'
import { db } from '@/lib/firebase/config'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'

// PART 2: Standardize Order Status Model
// Use ONLY: new, accepted, preparing, ready, completed, cancelled
type OrderStatus = 'new' | 'accepted' | 'preparing' | 'ready' | 'completed' | 'cancelled'

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
  const [loading, setLoading] = useState(true)
  const [markingPaidOrderId, setMarkingPaidOrderId] = useState<string | null>(null)
  const [showMarkPaidDialog, setShowMarkPaidDialog] = useState(false)
  const [closingTableNumber, setClosingTableNumber] = useState<number | null>(null)
  const [showCloseTableDialog, setShowCloseTableDialog] = useState(false)

  useEffect(() => {
    if (!restaurantId) {
      console.log('⚠️ Dashboard: No restaurantId available')
      setLoading(false)
      return
    }

    console.log('🔍 Dashboard: Subscribing to orders for restaurant:', restaurantId, 'status:', activeTab)

    // Subscribe to real-time orders
    const unsubscribe = subscribeToOrders(restaurantId, activeTab, (newOrders) => {
      console.log('📦 Dashboard: Received', newOrders.length, 'orders for status:', activeTab)
      if (newOrders.length > 0) {
        console.log('📦 Dashboard: First order details:', {
          id: newOrders[0].id,
          order_number: newOrders[0].order_number,
          status: newOrders[0].status,
          restaurant_id: newOrders[0].restaurant_id,
          table_number: newOrders[0].table_number,
        })
      }
      setOrders(newOrders)
      setLoading(false)
      
      // Play notification sound for new orders (optional)
      if (activeTab === 'new' && newOrders.length > 0) {
        // You can add a notification sound here
      }
      
      // PART 5: Safety Logging - Log when 0 orders found
      if (newOrders.length === 0) {
        console.log('⚠️ Dashboard: No orders found for status:', activeTab)
        console.log('⚠️ Dashboard: Query parameters:', {
          restaurantId,
          status: activeTab,
        })
      }
    })

    return () => unsubscribe()
  }, [restaurantId, activeTab])

  const handleStatusUpdate = async (orderId: string, newStatus: OrderStatus) => {
    if (!restaurantId) {
      toast({
        title: 'Update failed',
        description: 'Restaurant ID is missing',
        variant: 'destructive',
      })
      return
    }
    
    console.log('🔄 [DASHBOARD] Updating order status to:', newStatus, {
      orderId,
      restaurantId,
    })
    
    try {
      await updateOrderStatus(restaurantId, orderId, newStatus)
      console.log('✅ [DASHBOARD] Order status updated successfully')
      toast({
        title: 'Order updated',
        description: `Order status changed to ${newStatus}`,
      })
    } catch (error: any) {
      console.error('❌ [DASHBOARD] Failed to update order status:', {
        orderId,
        restaurantId,
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
    if (!restaurantId) {
      toast({
        title: 'Update failed',
        description: 'Restaurant ID is missing',
        variant: 'destructive',
      })
      return
    }
    
    try {
      setMarkingPaidOrderId(orderId)
      await updateOrderPayment(restaurantId, orderId, 'paid', user?.id)
      toast({
        title: 'Payment recorded',
        description: 'Order has been marked as paid',
      })
      setShowMarkPaidDialog(false)
      setMarkingPaidOrderId(null)
    } catch (error: any) {
      console.error('❌ [DASHBOARD] Failed to mark order as paid:', {
        orderId,
        restaurantId,
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
    if (!db || !restaurantId) {
      toast({
        title: 'Error',
        description: 'Unable to close table. Missing restaurant ID.',
        variant: 'destructive',
      })
      return
    }

    try {
      setClosingTableNumber(tableNumber)
      
      // PART 4: Find table by table_number to get tableId
      const { getTableByNumber } = require('@/lib/firebase/tables')
      const table = await getTableByNumber(restaurantId, tableNumber)
      if (!table) {
        toast({
          title: 'Table not found',
          description: `Table ${tableNumber} not found.`,
          variant: 'destructive',
        })
        setClosingTableNumber(null)
        return
      }
      const tableId = table.id

      // PART 4: Find active table session for this table
      // NEW: Use hierarchical path
      const { tableSessionsPath, tableSessionPath, ordersPath, orderPath } = require('@/lib/firebase/paths')
      const sessionsRef = collection(db, tableSessionsPath(restaurantId, tableId))
      const q = query(
        sessionsRef,
        where('status', '==', 'active')
      )

      const snapshot = await getDocs(q)
      
      if (snapshot.empty) {
        toast({
          title: 'No active session',
          description: `Table ${tableNumber} doesn't have an active session.`,
          variant: 'destructive',
        })
        setClosingTableNumber(null)
        return
      }

      // PART 4: Close all active sessions for this table
      // NEW: Use hierarchical path
      const sessionUpdatePromises = snapshot.docs.map((sessionDoc) =>
        updateDoc(doc(db, tableSessionPath(restaurantId, tableId, sessionDoc.id)), {
          status: 'closed',
          closed_at: serverTimestamp(),
        })
      )

      // PART 4: Update all orders for this table
      // Set table_closed = true and status = 'completed' to prevent order leakage
      // NEW: Use hierarchical path - restaurant_id is in the path
      const ordersRef = collection(db, ordersPath(restaurantId))
      const ordersQuery = query(
        ordersRef,
        where('table_number', '==', tableNumber),
        where('table_closed', '==', false)
      )

      const ordersSnapshot = await getDocs(ordersQuery)
      
      // NEW: Use hierarchical path
      const orderUpdatePromises = ordersSnapshot.docs.map((orderDoc) =>
        updateDoc(doc(db, orderPath(restaurantId, orderDoc.id)), {
          table_closed: true,
          status: 'completed',
          completed_at: serverTimestamp(),
          updated_at: serverTimestamp(),
        })
      )

      // Execute all updates in parallel
      await Promise.all([...sessionUpdatePromises, ...orderUpdatePromises])

      console.log(`✅ PART 4: Closed table ${tableNumber}:`, {
        sessionsClosed: sessionUpdatePromises.length,
        ordersClosed: orderUpdatePromises.length,
      })

      toast({
        title: 'Table closed',
        description: `Table ${tableNumber} has been closed. ${orderUpdatePromises.length} order(s) marked as completed.`,
      })
      
      setShowCloseTableDialog(false)
      setClosingTableNumber(null)
    } catch (error: any) {
      console.error('Error closing table:', error)
      toast({
        title: 'Failed to close table',
        description: error.message || 'Failed to close table session',
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

  const getPaymentStatusBadge = (order: Order) => {
    if (order.payment_status === 'paid') {
      return (
        <Badge className="bg-green-500 text-white">
          <CheckCircle2 className="h-3 w-3 mr-1" />
          Paid
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
              onClick={() => router.push('/')}
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
              const count = orders.filter((o) => o.status === tab.id).length
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
                    {getStatusBadge(normalizedOrder.status)}
                    {getPaymentStatusBadge(normalizedOrder)}
                    <div className="flex items-center gap-1 text-sm text-muted-foreground">
                      {getPaymentMethodIcon(normalizedOrder.payment_method)}
                      <span className="capitalize">{normalizedOrder.payment_method || 'cash'}</span>
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
                          {item?.quantity ?? 1}× {item?.name ?? 'Unknown Item'}
                        </span>
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

                {/* Payment Status Button */}
                {normalizedOrder.payment_status === 'pending' && (
                  <div className="pt-2">
                    <Button
                      className="w-full bg-[#FF6B35] hover:bg-[#e55a28]"
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

                {/* Action Buttons */}
                <div className="flex gap-3 pt-2">
                  {normalizedOrder.status === 'new' && (
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
