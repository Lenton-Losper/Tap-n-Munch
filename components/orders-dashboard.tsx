// @ts-nocheck
'use client'

import { useCallback, useEffect, useMemo, useRef, useState, Fragment, type ComponentType } from 'react'
import { useAuth } from '@/components/auth/auth-provider'
import {
  resolveOrderRestaurantScope,
  type OrderRestaurantScope,
} from '@/lib/supabase/restaurants'
import { subscribeRestaurantOrdersRealtime, getAllOpenRestaurantOrders } from '@/lib/supabase/orders'
import {
  subscribeOrderRequestsRealtime,
  getWaitingOrderRequests,
  applyOrderRequestRealtimeEvent,
  type OrderRequest,
} from '@/lib/supabase/order-requests'
import {
  applyOrderRealtimeEvent,
  countPendingHostedOrders,
  playNewOrderSound,
  unlockNewOrderSound,
} from '@/lib/dashboard/order-realtime'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { RefreshCw, Clock, ArrowLeft, CheckCircle2, ChefHat, Package, XCircle, Banknote, CreditCard, DollarSign, DoorClosed, Loader2, Mail, Printer, Pencil, Minus, ClipboardList } from 'lucide-react'
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
import { Input } from '@/components/ui/input'
import { getAccessToken, onboardingFetch } from '@/lib/onboarding/api-client'
import {
  filterOrdersByStationScope,
  orderVisibleForStationScope,
} from '@/lib/order-routing'
import { usePermissions } from '@/hooks/use-permissions'
import { PERMISSIONS } from '@/lib/permissions'

async function markFirstPaymentSetupComplete() {
  try {
    await onboardingFetch('/api/admin/setup-status', {
      method: 'PATCH',
      body: JSON.stringify({ flag: 'first_payment_completed' }),
    })
  } catch {
    // non-blocking
  }
}

type TerminalStatus = 'pending' | 'failed' | null

// PART 2: Standardize Order Status Model
type OrderStatus =
  | 'pending'
  | 'accepted'
  | 'preparing'
  | 'ready'
  | 'ready_for_terminal'
  | 'completed'
  | 'cancelled'

/** Dashboard tab ids (UI) may differ from Supabase order status values. */
type DashboardTabId =
  | 'waiting_review'
  | 'new'
  | 'pending_payment'
  | 'accepted'
  | 'preparing'
  | 'ready'
  | 'completed'

function supabaseStatusForTab(tab: DashboardTabId): string | null {
  if (tab === 'waiting_review') return null
  if (tab === 'pending_payment') return null
  if (tab === 'new') return 'pending'
  if (tab === 'preparing') return 'preparing'
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
  { id: 'waiting_review', label: 'Waiting for Review' },
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

function requestItemLabel(item: Record<string, any>): string {
  const parts: string[] = []
  if (item?.size) parts.push(String(item.size))
  const addons = Array.isArray(item?.addons) ? item.addons : []
  for (const addon of addons) {
    if (typeof addon === 'string') parts.push(addon)
    else if (addon?.name) parts.push(String(addon.name))
  }
  return parts.join(', ')
}

/**
 * One card in the Waiting for Review tab. Item edits (remove / quantity) are staged locally
 * and only sent to the server on "Save Review" -- the parent then persists items_reviewed via
 * calculateOrderPricing server-side (never re-priced client-side here).
 */
function OrderRequestCard({
  request,
  currency,
  timeAgoLabel,
  busy,
  onSaveReview,
  onAccept,
  onDecline,
}: {
  request: OrderRequest & Record<string, any>
  currency: string
  timeAgoLabel: string
  busy: boolean
  onSaveReview: (requestId: string, items: Record<string, any>[]) => Promise<void>
  onAccept: (requestId: string) => void
  onDecline: (requestId: string) => void
}) {
  const originalItems = Array.isArray(request.items) ? request.items : []
  const reviewedItems = Array.isArray(request.items_reviewed) ? request.items_reviewed : null
  const isReviewed = reviewedItems != null

  const [editing, setEditing] = useState(false)
  const [workingItems, setWorkingItems] = useState<Record<string, any>[]>(reviewedItems ?? originalItems)
  const [saving, setSaving] = useState(false)

  const displayItems = editing ? workingItems : reviewedItems ?? originalItems
  const displaySubtotal = isReviewed ? request.subtotal_reviewed : request.subtotal
  const displayTax = isReviewed ? request.tax_reviewed : request.tax
  const displayTotal = isReviewed ? request.total_reviewed : request.total

  const startEditing = () => {
    setWorkingItems((reviewedItems ?? originalItems).map((item) => ({ ...item })))
    setEditing(true)
  }

  const decrementQuantity = (index: number) => {
    setWorkingItems((prev) => {
      const next = [...prev]
      const item = { ...next[index] }
      const qty = Number(item.quantity) || 1
      if (qty <= 1) {
        next.splice(index, 1)
        return next
      }
      item.quantity = qty - 1
      next[index] = item
      return next
    })
  }

  const removeItem = (index: number) => {
    setWorkingItems((prev) => prev.filter((_, i) => i !== index))
  }

  const handleSave = async () => {
    setSaving(true)
    try {
      await onSaveReview(request.id, workingItems)
      setEditing(false)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="border border-border bg-card rounded-lg p-4">
      <div className="flex justify-between items-start gap-3 mb-2">
        <div>
          <span className="font-bold text-foreground">
            {request.channel === 'kiosk'
              ? `Kiosk${request.customer_name ? ` — ${request.customer_name}` : ''}`
              : `Table ${request.table_number ?? '—'}`}
          </span>
          <Badge className="ml-2 bg-purple-500 text-white border-0">Waiting for Review</Badge>
          {isReviewed && (
            <Badge variant="outline" className="ml-2">
              Edited
            </Badge>
          )}
          <p className="text-muted-foreground text-sm mt-1">Requested {timeAgoLabel}</p>
        </div>
      </div>

      <div className="space-y-1 mb-3">
        {displayItems.length === 0 && (
          <p className="text-sm text-destructive">No items left — decline this request.</p>
        )}
        {displayItems.map((item, index) => (
          <div key={index} className="flex justify-between items-center gap-2 text-sm">
            <div className="flex-1">
              <span className="font-medium">{item.quantity}× {item.displayName || item.name}</span>
              {requestItemLabel(item) && (
                <span className="text-muted-foreground"> ({requestItemLabel(item)})</span>
              )}
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <span className="text-muted-foreground">
                {currency}
                {(Number(item.subtotal) || 0).toFixed(2)}
              </span>
              {editing && (
                <>
                  <Button
                    type="button"
                    size="icon"
                    variant="outline"
                    className="h-6 w-6"
                    onClick={() => decrementQuantity(index)}
                  >
                    <Minus className="h-3 w-3" />
                  </Button>
                  <Button
                    type="button"
                    size="icon"
                    variant="outline"
                    className="h-6 w-6"
                    onClick={() => removeItem(index)}
                  >
                    <XCircle className="h-3 w-3" />
                  </Button>
                </>
              )}
            </div>
          </div>
        ))}
      </div>

      {request.order_instructions && (
        <p className="text-sm text-muted-foreground italic mb-2 break-words">&quot;{request.order_instructions}&quot;</p>
      )}

      <div className="flex justify-between items-baseline mb-3 pt-2 border-t border-border">
        <span className="text-sm text-muted-foreground">
          Subtotal {currency}{(Number(displaySubtotal) || 0).toFixed(2)} · Tax {currency}{(Number(displayTax) || 0).toFixed(2)}
        </span>
        <span className="font-bold text-foreground">
          {currency}
          {(Number(displayTotal) || 0).toFixed(2)}
        </span>
      </div>

      {editing ? (
        <div className="flex gap-2">
          <Button
            variant="outline"
            className="flex-1"
            onClick={() => setEditing(false)}
            disabled={saving}
          >
            Cancel
          </Button>
          <Button
            className="flex-1 bg-blue-500 hover:bg-blue-600"
            onClick={handleSave}
            disabled={saving || workingItems.length === 0}
          >
            <ActionButtonContent loading={saving} label="Save Review" loadingLabel="Saving..." />
          </Button>
        </div>
      ) : (
        <div className="flex gap-2">
          <Button variant="outline" className="flex-1" onClick={startEditing} disabled={busy}>
            <ActionButtonContent icon={Pencil} loading={false} label="Edit Items" />
          </Button>
          <Button
            variant="outline"
            className="flex-1 border-red-300 text-red-600 hover:bg-red-50"
            onClick={() => onDecline(request.id)}
            disabled={busy}
          >
            <ActionButtonContent icon={XCircle} loading={false} label="Decline" />
          </Button>
          <Button
            className="flex-1 bg-[#FF6B35] hover:bg-[#e55a28]"
            onClick={() => onAccept(request.id)}
            disabled={busy}
          >
            <ActionButtonContent loading={busy} icon={CheckCircle2} label="Accept" loadingLabel="Accepting..." />
          </Button>
        </div>
      )}
    </div>
  )
}

export function OrdersDashboard() {
  const { user, restaurantId, restaurant } = useAuth()
  const { hasPermission, permissionsLoaded } = usePermissions()
  const router = useRouter()
  const { toast } = useToast()
  const toastRef = useRef(toast)
  useEffect(() => {
    toastRef.current = toast
  }, [toast])
  const [activeTab, setActiveTab] = useState<DashboardTabId>('new')
  const [pendingHostedCount, setPendingHostedCount] = useState(0)
  const [cancellingHostedOrderId, setCancellingHostedOrderId] = useState<string | null>(null)
  const [allOrders, setAllOrders] = useState<Order[]>([])
  const [completedOrders, setCompletedOrders] = useState<Order[]>([])
  const [orderRequests, setOrderRequests] = useState<OrderRequest[]>([])
  const [requestActionKey, setRequestActionKey] = useState<string | null>(null)
  const [declineTargetRequestId, setDeclineTargetRequestId] = useState<string | null>(null)
  const [declineReason, setDeclineReason] = useState('')
  const [showDeclineDialog, setShowDeclineDialog] = useState(false)
  const [loading, setLoading] = useState(true)
  const [markingPaidOrderId, setMarkingPaidOrderId] = useState<string | null>(null)
  const [markPaidTargetOrderId, setMarkPaidTargetOrderId] = useState<string | null>(null)
  const [showMarkPaidDialog, setShowMarkPaidDialog] = useState(false)
  const [closeTableTargetNumber, setCloseTableTargetNumber] = useState<number | null>(null)
  const [closingTableNumber, setClosingTableNumber] = useState<number | null>(null)
  const [showCloseTableDialog, setShowCloseTableDialog] = useState(false)
  const [emailReceiptTargetOrderId, setEmailReceiptTargetOrderId] = useState<string | null>(null)
  const [showEmailReceiptDialog, setShowEmailReceiptDialog] = useState(false)
  const [emailReceiptAddress, setEmailReceiptAddress] = useState('')
  const [sendingReceiptEmailOrderId, setSendingReceiptEmailOrderId] = useState<string | null>(null)
  const [printingReceiptOrderId, setPrintingReceiptOrderId] = useState<string | null>(null)
  const [statusUpdateKey, setStatusUpdateKey] = useState<string | null>(null)
  const [sendingToTerminalOrderId, setSendingToTerminalOrderId] = useState<string | null>(null)
  const [cancelingTerminalOrderId, setCancelingTerminalOrderId] = useState<string | null>(null)
  const [terminalDismissedPollingIds, setTerminalDismissedPollingIds] = useState<string[]>([])
  const [terminalStatusByOrderId, setTerminalStatusByOrderId] = useState<Record<string, TerminalStatus>>({})
  const [nowMs, setNowMs] = useState(() => Date.now())
  const dashboardRestaurantId = String((restaurant as { id?: string } | null)?.id || restaurantId || '')
  const showDashboardLoading = loading && Boolean(user)
  const [orderScope, setOrderScope] = useState<OrderRestaurantScope | null>(null)
  const [orderScopeRestaurantId, setOrderScopeRestaurantId] = useState(dashboardRestaurantId)
  if (orderScopeRestaurantId !== dashboardRestaurantId) {
    setOrderScopeRestaurantId(dashboardRestaurantId)
    if (!dashboardRestaurantId) setOrderScope(null)
  }
  const [tabInfoById, setTabInfoById] = useState<
    Record<string, { status: string; payment_preference: string | null; members: any[] }>
  >({})
  const tabInfoScopeId = orderScope?.restaurantId ?? ''
  const [tabInfoScopeKey, setTabInfoScopeKey] = useState(tabInfoScopeId)
  if (tabInfoScopeKey !== tabInfoScopeId) {
    setTabInfoScopeKey(tabInfoScopeId)
    if (!tabInfoScopeId) setTabInfoById({})
  }
  const orderScopeRef = useRef<OrderRestaurantScope | null>(null)
  const subscribedRestaurantIdRef = useRef<string | null>(null)
  useEffect(() => {
    orderScopeRef.current = orderScope
  }, [orderScope])

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

  const isRecentCardPendingOrder = useCallback((order: Order) => {
    if (order.payment_method !== 'card' || order.payment_status !== 'pending') return false
    const ch = paymentChannelOf(order)
    if (ch === 'card_manual' || ch === 'other') return false
    if (ch === 'terminal') return true
    const createdDate = toDate((order as Order & { created_at?: unknown }).created_at) || toDate(order.placed_at)
    if (!createdDate) return true
    return Date.now() - createdDate.getTime() < 5 * 60 * 1000
  }, [])

  const shouldDisplayOrder = useCallback((order: Order) => {
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
  }, [isRecentCardPendingOrder])

  useEffect(() => {
    const id = window.setInterval(() => setNowMs(Date.now()), 60_000)
    return () => window.clearInterval(id)
  }, [])

  /* eslint-disable react-hooks/set-state-in-effect -- scope/tab hydration guards; React Query refactor out of scope */
  useEffect(() => {
    if (!dashboardRestaurantId) {
      return
    }

    if (restaurant?.id) {
      setOrderScope({
        restaurantId: String(restaurant.id),
      })
      return
    }

    let cancelled = false
    void resolveOrderRestaurantScope(dashboardRestaurantId)
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
  }, [dashboardRestaurantId, restaurant])
  /* eslint-enable react-hooks/set-state-in-effect */

  /* eslint-disable react-hooks/set-state-in-effect -- tab info hydration; React Query refactor out of scope */
  useEffect(() => {
    const restaurantUuid = orderScope?.restaurantId
    if (!restaurantUuid) {
      return
    }

    const tabIds = [
      ...new Set(allOrders.map((order) => tabIdOf(order)).filter(Boolean)),
    ] as string[]
    if (!tabIds.length) {
      setTabInfoById({})
      return
    }

    let cancelled = false
    const loadTabs = async () => {
      const { data, error } = await supabase
        .from('tabs')
        .select('id, status, payment_preference, members')
        .eq('restaurant_id', restaurantUuid)
        .in('id', tabIds)

      if (cancelled) return
      if (error) {
        console.error('[DASHBOARD] tab fetch error', error)
        return
      }

      const next: Record<string, { status: string; payment_preference: string | null; members: any[] }> = {}
      for (const row of data || []) {
        next[String(row.id)] = {
          status: String(row.status || ''),
          payment_preference: row.payment_preference ? String(row.payment_preference) : null,
          members: Array.isArray(row.members) ? row.members : [],
        }
      }
      setTabInfoById(next)
    }

    void loadTabs()
    return () => {
      cancelled = true
    }
  }, [allOrders, orderScope?.restaurantId])
  /* eslint-enable react-hooks/set-state-in-effect */

  useEffect(() => {
    const restaurantUuid = orderScope?.restaurantId
    if (!restaurantUuid) return

    const channel = supabase
      .channel(`tabs-dash-${restaurantUuid}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'tabs',
          filter: `restaurant_id=eq.${restaurantUuid}`,
        },
        (payload) => {
          const row = payload.new as {
            id?: string
            status?: string
            payment_preference?: string | null
            members?: unknown
          }
          if (!row?.id) return
          setTabInfoById((prev) => ({
            ...prev,
            [String(row.id)]: {
              status: String(row.status || ''),
              payment_preference: row.payment_preference ? String(row.payment_preference) : null,
              members: Array.isArray(row.members)
                ? row.members
                : prev[String(row.id)]?.members ?? [],
            },
          }))
        }
      )
      .subscribe()

    return () => {
      supabase.removeChannel(channel)
    }
  }, [orderScope?.restaurantId])

  // Single Realtime subscription for all order INSERT/UPDATE/DELETE events
  /* eslint-disable react-hooks/set-state-in-effect -- subscription lifecycle guards; React Query refactor out of scope */
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
          scope = await resolveOrderRestaurantScope(dashboardRestaurantId)
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
  /* eslint-enable react-hooks/set-state-in-effect */

  useEffect(() => {
    if (!dashboardRestaurantId) return
    let cancelled = false
    let unsubscribe: (() => void) | undefined

    const start = async () => {
      let scope = orderScopeRef.current
      if (!scope) {
        try {
          scope = await resolveOrderRestaurantScope(dashboardRestaurantId)
        } catch (err) {
          console.error(err)
          return
        }
      }
      if (cancelled || !scope) return

      unsubscribe = subscribeOrderRequestsRealtime(
        dashboardRestaurantId,
        {
          onInitial: (incoming) => {
            if (cancelled) return
            setOrderRequests(incoming)
          },
          onChange: (payload) => {
            if (cancelled) return
            setOrderRequests((prev) => applyOrderRequestRealtimeEvent(prev, payload))

            if (payload.eventType === 'INSERT') {
              const row = payload.new
              playNewOrderSound()
              toastRef.current({
                title: 'New order request',
                description: row?.channel === 'kiosk'
                  ? 'A kiosk order is waiting for review.'
                  : `A table order is waiting for review (Table ${row?.table_number ?? '?'}).`,
              })
            }
          },
        },
        scope,
      )
    }

    void start()

    return () => {
      cancelled = true
      unsubscribe?.()
    }
  }, [dashboardRestaurantId])

  useEffect(() => {
    if (activeTab !== 'completed' || !dashboardRestaurantId) return

    const fetchCompleted = async () => {
      const { data } = await supabase
        .from('orders')
        .select('*')
        .eq('restaurant_id', dashboardRestaurantId)
        .eq('status', 'completed')
        .order('placed_at', { ascending: false })
        .limit(100)

      if (data) setCompletedOrders(data as Order[])
    }

    void fetchCompleted()
  }, [activeTab, dashboardRestaurantId])

  const stationScope = useMemo(
    () => ({
      hasKitchenStation:
        permissionsLoaded && hasPermission(PERMISSIONS.ORDERS_STATION_KITCHEN),
      hasBarStation: permissionsLoaded && hasPermission(PERMISSIONS.ORDERS_STATION_BAR),
    }),
    [permissionsLoaded, hasPermission]
  )

  const stationFilteredOrders = useMemo(() => {
    if (!permissionsLoaded) return allOrders
    return filterOrdersByStationScope(allOrders, stationScope)
  }, [allOrders, stationScope, permissionsLoaded])

  const mergedSourceOrders = useMemo(() => {
    if (activeTab === 'pending_payment') {
      return stationFilteredOrders.filter(
        (order) =>
          paymentChannelOf(order) === 'hosted' &&
          String(order.payment_status || '').toLowerCase() === 'pending'
      )
    }
    if (activeTab === 'new') {
      return stationFilteredOrders.filter(
        (order) => order.status === 'pending' || order.status === 'ready_for_terminal'
      )
    }
    if (activeTab === 'completed') {
      const fromRealtime = stationFilteredOrders.filter((order) => order.status === 'completed')
      const merged = [...fromRealtime]
      for (const order of completedOrders) {
        if (!orderVisibleForStationScope(order, stationScope)) continue
        if (!merged.find((existing) => existing.id === order.id)) {
          merged.push(order)
        }
      }
      return merged
    }
    const mappedStatus = supabaseStatusForTab(activeTab)
    if (!mappedStatus) return []
    return stationFilteredOrders.filter((order) => order.status === mappedStatus)
  }, [activeTab, stationFilteredOrders, completedOrders, stationScope])

  const tabCounts = useMemo(() => {
    const newCandidates = stationFilteredOrders.filter(
      (order) => order.status === 'pending' || order.status === 'ready_for_terminal'
    )
    return {
      waiting_review: orderRequests.length,
      pending_payment: countPendingHostedOrders(stationFilteredOrders),
      new: newCandidates.length,
      accepted: stationFilteredOrders.filter((order) => order.status === 'accepted').length,
      preparing: stationFilteredOrders.filter((order) => order.status === 'preparing').length,
      ready: stationFilteredOrders.filter((order) => order.status === 'ready').length,
      completed: stationFilteredOrders.filter((order) => order.status === 'completed').length,
    } as Record<DashboardTabId, number>
  }, [stationFilteredOrders, orderRequests])

  const orders = useMemo(() => {
    if (!user || !dashboardRestaurantId) return []

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

    return activeTab === 'pending_payment' ? visibleOrders : sortOrdersForTab(visibleOrders)
  }, [user, dashboardRestaurantId, activeTab, mergedSourceOrders, shouldDisplayOrder, isRecentCardPendingOrder])

  const terminalPendingFromOrders = useMemo(
    () => orders.filter((o) => o.payment_status === 'terminal_pending').map((o) => o.id),
    [orders]
  )

  const terminalPollingOrderIds = useMemo(
    () => terminalPendingFromOrders.filter((id) => !terminalDismissedPollingIds.includes(id)),
    [terminalPendingFromOrders, terminalDismissedPollingIds]
  )

  const groupedOrders = useMemo(() => {
    const kiosk = orders.filter((o) => String(o.channel || '') === 'kiosk')
    const table = orders.filter((o) => String(o.channel || '') !== 'kiosk')
    return [...kiosk, ...table]
  }, [orders])

  const refreshPendingHostedCount = useCallback(async () => {
    if (!dashboardRestaurantId || !orderScope) return
    const { count } = await supabase
      .from('orders')
      .select('*', { count: 'exact', head: true })
      .eq('restaurant_id', orderScope.restaurantId)
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
    return Math.max(0, Math.floor((nowMs - d.getTime()) / 60_000))
  }

  const isStatusUpdating = (orderId: string, action: string) =>
    statusUpdateKey === orderActionKey(orderId, action)

  const isOrderStatusBusy = (orderId: string) =>
    Boolean(statusUpdateKey?.startsWith(`${orderId}:`))

  const handleSaveRequestReview = async (requestId: string, items: Record<string, any>[]) => {
    try {
      const response = await fetch(`/api/order-requests/${encodeURIComponent(requestId)}/review`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items }),
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(data?.error || 'Failed to save review')
      setOrderRequests((prev) =>
        prev.map((request) => (request.id === requestId ? { ...request, ...data.request } : request)),
      )
      toast({ title: 'Review saved' })
    } catch (error: any) {
      toast({
        title: 'Failed to save review',
        description: error?.message || 'Please try again.',
        variant: 'destructive',
      })
    }
  }

  const handleAcceptRequest = async (requestId: string) => {
    if (requestActionKey) return
    setRequestActionKey(orderActionKey(requestId, 'accept'))
    try {
      const response = await fetch(`/api/order-requests/${encodeURIComponent(requestId)}/accept`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(data?.error || 'Failed to accept order')
      setOrderRequests((prev) => prev.filter((request) => request.id !== requestId))
      toast({ title: 'Order accepted', description: 'It now appears in New Orders.' })
    } catch (error: any) {
      toast({
        title: 'Failed to accept order',
        description: error?.message || 'Please try again.',
        variant: 'destructive',
      })
    } finally {
      setRequestActionKey(null)
    }
  }

  const openDeclineDialog = (requestId: string) => {
    setDeclineTargetRequestId(requestId)
    setDeclineReason('')
    setShowDeclineDialog(true)
  }

  const handleDeclineRequest = async () => {
    const requestId = declineTargetRequestId
    if (!requestId || requestActionKey) return
    setRequestActionKey(orderActionKey(requestId, 'decline'))
    try {
      const response = await fetch(`/api/order-requests/${encodeURIComponent(requestId)}/decline`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: declineReason.trim() || null }),
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(data?.error || 'Failed to decline order')
      setOrderRequests((prev) => prev.filter((request) => request.id !== requestId))
      setShowDeclineDialog(false)
      setDeclineTargetRequestId(null)
      toast({ title: 'Order declined' })
    } catch (error: any) {
      toast({
        title: 'Failed to decline order',
        description: error?.message || 'Please try again.',
        variant: 'destructive',
      })
    } finally {
      setRequestActionKey(null)
    }
  }

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

      void markFirstPaymentSetupComplete()

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

  const openEmailReceiptDialog = (orderId: string) => {
    setEmailReceiptTargetOrderId(orderId)
    setEmailReceiptAddress('')
    setShowEmailReceiptDialog(true)
  }

  const closeEmailReceiptDialog = () => {
    setShowEmailReceiptDialog(false)
    setEmailReceiptTargetOrderId(null)
    setEmailReceiptAddress('')
  }

  const handleSendReceiptEmail = async () => {
    const orderId = emailReceiptTargetOrderId
    const email = emailReceiptAddress.trim()
    if (!orderId || !email) return
    if (sendingReceiptEmailOrderId) return

    setSendingReceiptEmailOrderId(orderId)
    try {
      const response = await fetch(`/api/orders/${encodeURIComponent(orderId)}/receipt/email`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) {
        throw new Error(data?.error || 'Failed to send receipt email')
      }

      closeEmailReceiptDialog()
      toast({
        title: 'Receipt emailed',
        description: `Sent to ${email}`,
      })
    } catch (error: any) {
      console.error(error)
      toast({
        title: 'Failed to email receipt',
        description: error.message || 'Please try again.',
        variant: 'destructive',
      })
    } finally {
      setSendingReceiptEmailOrderId(null)
    }
  }

  // "Print from this computer" -- renders the receipt in a new tab and calls window.print()
  // there. Deliberately separate from the terminal's own Bluetooth/built-in printer flow,
  // which prints from the terminal device itself, not the manager's machine.
  const handlePrintReceipt = async (orderId: string) => {
    if (printingReceiptOrderId) return
    setPrintingReceiptOrderId(orderId)
    // Open synchronously, before the await below -- opening after an async gap can lose
    // the user-activation flag and get silently popup-blocked in some browsers.
    const printWindow = window.open('', '_blank')
    try {
      if (!printWindow) {
        throw new Error('Pop-up blocked -- allow pop-ups to print receipts from this computer')
      }

      const response = await fetch(`/api/orders/${encodeURIComponent(orderId)}/receipt`)
      const data = await response.json().catch(() => ({}))
      if (!response.ok) {
        throw new Error(data?.error || 'Failed to load receipt')
      }

      printWindow.document.open()
      printWindow.document.write(String(data.html || ''))
      printWindow.document.close()
      printWindow.focus()
      printWindow.onload = () => {
        printWindow.print()
      }
    } catch (error: any) {
      printWindow?.close()
      console.error(error)
      toast({
        title: 'Failed to print receipt',
        description: error.message || 'Please try again.',
        variant: 'destructive',
      })
    } finally {
      setPrintingReceiptOrderId(null)
    }
  }

  const handleSendToTerminal = async (order: Order, bypassReadyCheck = false) => {
    if (!dashboardRestaurantId) return
    if (sendingToTerminalOrderId === order.id) return
    try {
      setSendingToTerminalOrderId(order.id)
      setTerminalStatusByOrderId((prev) => ({ ...prev, [order.id]: 'pending' }))
      const token = await getAccessToken()
      const response = await fetch('/api/payments/push-to-terminal', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          orderId: order.id,
          tableNumber: order.table_number,
          orderNumber: order.order_number,
          bypassReadyCheck,
        }),
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok || data?.success === false) {
        throw new Error(data?.error || 'Failed to send payment to terminal')
      }
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
      const token = await getAccessToken()
      const response = await fetch('/api/payments/cancel-terminal', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ orderId: order.id }),
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok || data?.success === false) {
        throw new Error(data?.error || 'Failed to cancel terminal payment')
      }
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
      try {
        // Single batched request for all pending-terminal-payment orders instead of one
        // round trip per order -- was previously N sequential .eq('id', orderId).single()
        // calls in a for loop every 5s.
        const { data } = await supabase
          .from('orders')
          .select('id,payment_status,order_number,terminal_status')
          .in('id', terminalPollingOrderIds)
        const rows = (data || []) as any[]
        const rowsById = new Map(rows.map((row) => [String(row.id), row]))

        for (const orderId of terminalPollingOrderIds) {
          const orderRow = rowsById.get(orderId) || null
          const status = String(orderRow?.payment_status || '').toLowerCase()
          const terminalStatus = String(orderRow?.terminal_status || '').toLowerCase()
          if (status === 'paid') {
            doneIds.push(orderId)
            setTerminalStatusByOrderId((prev) => ({ ...prev, [orderId]: null }))
            void markFirstPaymentSetupComplete()
            toast({
              title: 'Payment confirmed',
              description: `Order #${orderRow?.order_number || orderId.slice(-6)} was paid on terminal.`,
            })
          } else if (terminalStatus === 'failed') {
            doneIds.push(orderId)
            setTerminalStatusByOrderId((prev) => ({ ...prev, [orderId]: 'failed' }))
            toast({
              title: 'Terminal payment failed',
              description: `Order #${orderRow?.order_number || orderId.slice(-6)} failed on the terminal. You can retry.`,
              variant: 'destructive',
            })
          } else if (status !== 'terminal_pending') {
            doneIds.push(orderId)
          }
        }
      } catch (e) {
        // keep polling on transient failures
      }
      if (doneIds.length > 0) {
        setTerminalDismissedPollingIds((prev) => Array.from(new Set([...prev, ...doneIds])))
      }
    }, 5000)
    return () => clearInterval(timer)
  }, [dashboardRestaurantId, terminalPollingOrderIds, toast])

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
        .eq('restaurant_id', orderScope.restaurantId)
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
    const tabStatus = String((order as Order & { tab_status?: string | null }).tab_status || '')

    // Tab orders: payment method is chosen at Ready to Pay, not when items are added
    if (isTabOrder(order) && tabStatus !== 'ready_to_pay') {
      return null
    }

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
    if (String(order.payment_status || '').toLowerCase() === 'cancelled') {
      return (
        <Badge variant="destructive">
          <XCircle className="h-3 w-3 mr-1" />
          Cancelled
        </Badge>
      )
    }
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

  if (showDashboardLoading) {
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
        {activeTab === 'waiting_review' ? (
          orderRequests.length === 0 ? (
            <div className="text-center py-12 bg-card border rounded-lg">
              <div className="max-w-md mx-auto">
                <div className="text-6xl mb-4">🕒</div>
                <h3 className="text-xl font-semibold mb-2">No requests waiting for review</h3>
                <p className="text-muted-foreground">
                  New table and kiosk order requests will appear here first.
                </p>
              </div>
            </div>
          ) : (
            <div className="grid gap-4 max-w-3xl">
              {orderRequests.map((request) => (
                <OrderRequestCard
                  key={request.id}
                  request={request}
                  currency={restaurant?.currency || 'N$'}
                  timeAgoLabel={formatTimeAgo(request.placed_at)}
                  busy={requestActionKey?.startsWith(`${request.id}:`) ?? false}
                  onSaveReview={handleSaveRequestReview}
                  onAccept={handleAcceptRequest}
                  onDecline={openDeclineDialog}
                />
              ))}
            </div>
          )
        ) : activeTab === 'pending_payment' ? (
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
            {groupedOrders.map((order, index, arr) => {
              const prevOrder = index > 0 ? arr[index - 1] : null
              const isKioskOrder = String(order.channel || '') === 'kiosk'
              const showKioskHeader =
                isKioskOrder && (index === 0 || String(prevOrder?.channel || '') !== 'kiosk')
              const showTableHeader =
                !isKioskOrder && prevOrder != null && String(prevOrder.channel || '') === 'kiosk'
              // DEFENSIVE NORMALIZATION: Ensure items is always an array before rendering
              // This prevents "Cannot read property 'length' of undefined" errors
              const tabInfo = tabIdOf(order) ? tabInfoById[tabIdOf(order)] : null
              const memberNameMap: Record<string, string> = {}
              tabInfo?.members?.forEach((m: any) => {
                if (m?.session_id) {
                  memberNameMap[String(m.session_id)] = String(m.display_name || '').trim() || 'Guest'
                }
              })
              const memberSessionId = String(
                (order as Order & { member_session_id?: string | null }).member_session_id || ''
              ).trim()
              const normalizedOrder = {
                ...order,
                items: Array.isArray(order.items) ? order.items : [],
                customer: order.customer || {},
                tab_status: tabInfo?.status ?? null,
                tab_ready_to_pay: tabInfo?.status === 'ready_to_pay',
                tab_payment_preference: tabInfo?.payment_preference ?? null,
              }

              const customerReadyToPay =
                order.customer_ready_to_pay === true ||
                tabInfo?.status === 'ready_to_pay'

              return (
              <Fragment key={order.id}>
                {showKioskHeader && (
                  <div className="col-span-full">
                    <h3 className="text-xs font-semibold text-purple-600 uppercase tracking-wider mb-1 px-1">
                      Kiosk Orders
                    </h3>
                  </div>
                )}
                {showTableHeader && (
                  <div className="col-span-full mt-2">
                    <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1 px-1">
                      Table Orders
                    </h3>
                  </div>
                )}
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
                    {normalizedOrder.channel === 'kiosk' ? (
                      <Badge variant="secondary" className="bg-purple-100 text-purple-800">
                        🖥 Kiosk
                      </Badge>
                    ) : (
                      <Badge variant="secondary">Table {normalizedOrder.table_number || 0}</Badge>
                    )}
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
                  {normalizedOrder.tab_status === 'ready_to_pay' && normalizedOrder.tab_payment_preference && (
                    <div className="flex items-center justify-end gap-1.5 mt-1">
                      <span className="text-sm">
                        {normalizedOrder.tab_payment_preference === 'cash'
                          ? '💵'
                          : normalizedOrder.tab_payment_preference === 'other'
                            ? '🤝'
                            : '💳'}
                      </span>
                      <span className="text-xs font-medium text-muted-foreground font-sans">
                        {normalizedOrder.tab_payment_preference === 'cash'
                          ? 'Cash'
                          : normalizedOrder.tab_payment_preference === 'card'
                            ? 'Card'
                            : 'Other'}
                      </span>
                    </div>
                  )}
                </div>

                {/* Order Items - DEFENSIVE: Use normalizedOrder.items which is guaranteed to be an array */}
                <div className="space-y-2 border-t pt-3">
                  {normalizedOrder.channel === 'kiosk' && (
                    <div className="flex items-center gap-2 mb-2">
                      {normalizedOrder.kiosk_order_number && (
                        <span className="text-sm font-bold text-purple-700">
                          K-{String(normalizedOrder.kiosk_order_number).padStart(3, '0')}
                        </span>
                      )}
                      {normalizedOrder.customer_name && (
                        <>
                          <span className="text-gray-400">—</span>
                          <span className="text-sm font-medium">👤 {normalizedOrder.customer_name}</span>
                        </>
                      )}
                    </div>
                  )}
                  {memberSessionId && memberNameMap[memberSessionId] && (
                    <div className="flex items-center gap-1.5 mb-2">
                      <span className="text-sm">👤</span>
                      <span className="text-sm font-medium text-foreground font-sans">
                        {memberNameMap[memberSessionId]}
                      </span>
                    </div>
                  )}
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
                          <div className="text-xs text-muted-foreground italic mt-1 break-words">
                            &ldquo;{item.special_instructions}&rdquo;
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
                    {/* Rows written before the client cap can be any length, and an unbroken
                        run of characters would otherwise push the card sideways. */}
                    <p className="text-sm text-yellow-800 break-words">{normalizedOrder.order_instructions}</p>
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

                {/* After a successful push, payment_status is terminal_pending (canonical
                    value since push-to-terminal was introduced). Failure feedback must live
                    here — gating only on payment_status === 'pending' misses this state. */}
                {normalizedOrder.payment_status === 'terminal_pending' && (
                  <div className="pt-2 space-y-2">
                    {getTerminalStatus(normalizedOrder) === 'failed' ? (
                      <>
                        <div className="bg-red-100 text-red-700 px-3 py-1 rounded text-sm font-medium">
                          Payment Failed - Retry
                        </div>
                        <Button
                          className="w-full bg-[#FF6B35] hover:bg-[#e55a28]"
                          onClick={() => handleSendToTerminal(normalizedOrder, true)}
                          disabled={sendingToTerminalOrderId === normalizedOrder.id}
                        >
                          <ActionButtonContent
                            loading={sendingToTerminalOrderId === normalizedOrder.id}
                            icon={CreditCard}
                            label="Send to Terminal"
                            loadingLabel="Sending to terminal..."
                          />
                        </Button>
                      </>
                    ) : (
                      <Button
                        className="w-full bg-amber-600 hover:bg-amber-700"
                        disabled
                      >
                        <Clock className="h-4 w-4 mr-2" />
                        Waiting for payment...
                      </Button>
                    )}
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
                          label="Accept Order"
                          loadingLabel="Accepting..."
                        />
                      </Button>
                    </>
                  )}
                  {normalizedOrder.status === 'accepted' && (
                    <Button
                      className="flex-1 bg-blue-500 hover:bg-blue-600"
                      onClick={() => handleStatusUpdate(normalizedOrder.id, 'preparing')}
                      disabled={isOrderStatusBusy(normalizedOrder.id)}
                    >
                      <ActionButtonContent
                        loading={isStatusUpdating(normalizedOrder.id, 'preparing')}
                        icon={ChefHat}
                        label="Start Preparing"
                        loadingLabel="Updating..."
                      />
                    </Button>
                  )}
                  {normalizedOrder.status === 'preparing' && (
                    <Button
                      className="flex-1 bg-blue-500 hover:bg-blue-600"
                      onClick={() => handleStatusUpdate(normalizedOrder.id, 'ready')}
                      disabled={isOrderStatusBusy(normalizedOrder.id)}
                    >
                      <ActionButtonContent
                        loading={isStatusUpdating(normalizedOrder.id, 'ready')}
                        icon={ChefHat}
                        label="Mark Ready"
                        loadingLabel="Updating..."
                      />
                    </Button>
                  )}
                  {normalizedOrder.status === 'ready' &&
                    (isOrderPaid(normalizedOrder) || isTabOrder(normalizedOrder)) && (
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
                  {normalizedOrder.status === 'completed' && (
                    <>
                      <Button
                        variant="outline"
                        className="flex-1"
                        onClick={() => openEmailReceiptDialog(normalizedOrder.id)}
                        disabled={sendingReceiptEmailOrderId === normalizedOrder.id}
                      >
                        <ActionButtonContent
                          loading={sendingReceiptEmailOrderId === normalizedOrder.id}
                          icon={Mail}
                          label="Email receipt"
                          loadingLabel="Sending..."
                        />
                      </Button>
                      <Button
                        variant="outline"
                        className="flex-1"
                        title="Print from this computer -- not the terminal's Bluetooth or built-in printer"
                        onClick={() => handlePrintReceipt(normalizedOrder.id)}
                        disabled={printingReceiptOrderId === normalizedOrder.id}
                      >
                        <ActionButtonContent
                          loading={printingReceiptOrderId === normalizedOrder.id}
                          icon={Printer}
                          label="Print from this computer"
                          loadingLabel="Preparing..."
                        />
                      </Button>
                    </>
                  )}
                </div>
              </div>
              </Fragment>
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

      {/* Decline Order Request Dialog */}
      <Dialog
        open={showDeclineDialog}
        onOpenChange={(open) => {
          setShowDeclineDialog(open)
          if (!open) {
            setDeclineTargetRequestId(null)
            setDeclineReason('')
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Decline Order Request</DialogTitle>
            <DialogDescription>
              This request will never become an order. The customer will see the request was declined, but not this note.
            </DialogDescription>
          </DialogHeader>
          <Input
            /*
             * "shown to staff only" was not merely imprecise -- it was false about the only
             * thing it claimed. `declined_reason` is WRITE-ONLY: a repo-wide grep for it
             * returns exactly two lines, both in
             * app/api/order-requests/[requestId]/decline/route.ts (:14 reads it off the body,
             * :49 writes it), and nothing anywhere reads it back. Not a customer surface, and
             * not a staff one either. The note is stored and rendered to nobody.
             *
             * So the label now says only what is certainly true -- the customer does not see it
             * -- rather than promising a staff surface that does not exist. Whether to BUILD
             * that surface or to relabel the field as an internal note is a product decision
             * (#210); this wording is correct under either.
             */
            placeholder="Reason (optional, not shown to the customer)"
            value={declineReason}
            onChange={(e) => setDeclineReason(e.target.value)}
          />
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setShowDeclineDialog(false)}
              disabled={Boolean(requestActionKey)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              className="bg-red-500 hover:bg-red-600 text-white"
              onClick={() => void handleDeclineRequest()}
              disabled={!declineTargetRequestId || Boolean(requestActionKey)}
            >
              <ActionButtonContent
                loading={Boolean(requestActionKey)}
                label="Decline Order"
                loadingLabel="Declining..."
              />
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Email Receipt Dialog */}
      <Dialog
        open={showEmailReceiptDialog}
        onOpenChange={(open) => {
          if (!open) closeEmailReceiptDialog()
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Email Receipt</DialogTitle>
            <DialogDescription>
              Enter the customer&apos;s email address to send this receipt.
            </DialogDescription>
          </DialogHeader>
          <Input
            type="email"
            placeholder="customer@example.com"
            value={emailReceiptAddress}
            onChange={(e) => setEmailReceiptAddress(e.target.value)}
            disabled={Boolean(sendingReceiptEmailOrderId)}
          />
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={closeEmailReceiptDialog}
              disabled={Boolean(sendingReceiptEmailOrderId)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              className="bg-[#FF6B35] hover:bg-[#e55a28]"
              onClick={() => void handleSendReceiptEmail()}
              disabled={!emailReceiptAddress.trim() || Boolean(sendingReceiptEmailOrderId)}
            >
              <ActionButtonContent
                loading={Boolean(sendingReceiptEmailOrderId)}
                icon={Mail}
                label="Send Receipt"
                loadingLabel="Sending..."
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
