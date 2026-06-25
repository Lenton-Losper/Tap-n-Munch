'use client'

import { useEffect, useMemo, useState } from 'react'
import { useParams, useSearchParams, useRouter } from 'next/navigation'
import { supabase } from '@/lib/supabase/client'
import { useRestaurant } from '@/contexts/restaurant-context'
import { Button } from '@/components/ui/button'
import { ArrowLeft, FileText } from 'lucide-react'
import Link from 'next/link'
import { getSessionInfo, getCurrentSession } from '@/lib/session'
import {
  ReadyToPayTerminalButton,
  ReadyToPayTerminalNotified,
} from '@/components/ready-to-pay-terminal'
import OrderStatusBanner from '@/components/OrderStatusBanner'
import { useTab } from '@/contexts/tab-context'
import { persistTabSession, readStoredTableNumber } from '@/lib/tab-storage'
import { handleSessionExpired } from '@/lib/handle-session-expired'
import {
  fetchOrdersForTab,
  fetchTabById,
  isActiveTabStatus,
  resolveStoredTabId,
  type TabRow,
} from '@/lib/tab-session'

const RECEIPT_LOOKBACK_MS = 24 * 60 * 60 * 1000

function placedAtMillis(order: { placed_at?: unknown }): number {
  const p = order?.placed_at as { toMillis?: () => number } | number | undefined
  if (p && typeof p === 'object' && typeof (p as { toMillis?: () => number }).toMillis === 'function') {
    return (p as { toMillis: () => number }).toMillis()
  }
  if (typeof p === 'number' && Number.isFinite(p)) return p
  if (typeof p === 'string') {
    const d = new Date(p)
    if (!Number.isNaN(d.getTime())) return d.getTime()
  }
  return 0
}

/** Testing mode: show open table orders from the last 24 hours regardless of session_id. */
function isOrderInReceiptTimeWindow(
  order: { placed_at?: unknown; created_at?: unknown },
  nowMs: number
): boolean {
  const placed = placedAtMillis(order)
  if (!placed) {
    const fallback = placedAtMillis({ placed_at: order.created_at })
    return fallback >= nowMs - RECEIPT_LOOKBACK_MS
  }
  return placed >= nowMs - RECEIPT_LOOKBACK_MS
}

type OrderRecord = {
  id: string
  order_number?: number
  placed_at?: unknown
  created_at?: unknown
  table_number?: unknown
  total?: number
  status?: string
  payment_status?: string
  payment_method?: string
  payment_channel?: string | null
  tab_id?: string | null
  tab_settlement_for_tab_id?: string | null
  paycloud_merchant_order_no?: string
  payment_reference?: string | null
  items?: Array<{ quantity?: number; name?: string; subtotal?: number }>
  member_session_id?: string | null
  session_id?: string | null
  customer_name?: string | null
  customer?: { name?: string } | null
}

function isOrderPaid(order: OrderRecord): boolean {
  return String(order.payment_status || '').toLowerCase() === 'paid'
}

function isOrderClosed(order: OrderRecord): boolean {
  return order.status === 'completed' || order.status === 'cancelled'
}

function shouldShowInReceipt(order: OrderRecord, nowMs: number): boolean {
  if (isOrderPaid(order)) return true
  if (isOrderClosed(order)) return false
  const placed = placedAtMillis(order)
  if (!placed) return false
  return placed >= nowMs - RECEIPT_LOOKBACK_MS
}

function isTabSettlementOrder(order: OrderRecord): boolean {
  return Boolean(String(order.tab_settlement_for_tab_id || '').trim())
}

function isUnpaidNonSettlementOrder(order: OrderRecord): boolean {
  return !isOrderPaid(order) && !isTabSettlementOrder(order)
}

function getReceiptStatusBadge(order: OrderRecord): { label: string; className: string } {
  const payment = String(order.payment_status || '').toLowerCase()
  const status = String(order.status || '').toLowerCase()

  if (payment === 'paid') {
    return { label: 'PAID', className: 'bg-green-100 text-green-800' }
  }
  if (payment === 'pending') {
    return { label: 'PENDING', className: 'bg-yellow-100 text-yellow-800' }
  }
  if (status === 'accepted' || status === 'ready') {
    return { label: status === 'accepted' ? 'ACCEPTED' : 'PREPARING', className: 'bg-orange-100 text-orange-800' }
  }
  if (status === 'pending') {
    return { label: 'NEW', className: 'bg-muted text-foreground' }
  }
  return { label: (order.status || 'unknown').toUpperCase(), className: 'bg-muted text-foreground' }
}

/** Firestore Timestamp, plain object, ISO string, or millis — never pass invalid values to `new Date` alone. */
function formatOrderTimestamp(value: unknown): string {
  if (value == null) return '—'

  if (typeof value === 'object' && value !== null && 'toDate' in value) {
    const toDate = (value as { toDate?: () => Date }).toDate
    if (typeof toDate === 'function') {
      const d = toDate.call(value)
      if (d instanceof Date && !Number.isNaN(d.getTime())) return d.toLocaleString()
    }
  }

  if (typeof value === 'object' && value !== null && 'seconds' in value) {
    const sec = Number((value as { seconds: number }).seconds)
    if (Number.isFinite(sec)) return new Date(sec * 1000).toLocaleString()
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    const d = new Date(value)
    return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString()
  }

  if (typeof value === 'string') {
    const d = new Date(value)
    return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString()
  }

  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? '—' : value.toLocaleString()
  }

  return '—'
}

function buildMemberNameMap(tab: TabRow | null): Record<string, string> {
  const map: Record<string, string> = {}
  const members = Array.isArray(tab?.members) ? tab.members : []
  for (const member of members) {
    const row = member as {
      session_id?: string
      member_session_id?: string
      id?: string
      display_name?: string
    }
    const name = String(row.display_name || '').trim() || 'Guest'
    const keys = [row.session_id, row.member_session_id, row.id]
      .map((value) => String(value || '').trim())
      .filter(Boolean)
    for (const key of keys) {
      map[key] = name
    }
  }
  return map
}

function getOrderCustomerLabel(
  order: OrderRecord,
  memberNameMap: Record<string, string>
): string {
  const customerName = String(order.customer_name || order.customer?.name || '').trim()
  if (customerName) return customerName

  const memberSessionId = String(order.member_session_id || '').trim()
  if (memberSessionId && memberNameMap[memberSessionId]) {
    return memberNameMap[memberSessionId]
  }

  const sessionId = String(order.session_id || '').trim()
  if (sessionId && memberNameMap[sessionId]) {
    return memberNameMap[sessionId]
  }

  return 'Guest'
}

export default function ReceiptPage() {
  const params = useParams()
  const searchParams = useSearchParams()
  const router = useRouter()
  const restaurantId = params.restaurantId as string
  const tableNumberFromUrl = searchParams.get('table') || ''
  const tabIdFromUrl = searchParams.get('tabId')?.trim() || ''
  const { tabStatus, refreshTab } = useTab()
  const { restaurant, currency } = useRestaurant()
  const storedTabId = resolveStoredTabId(tabIdFromUrl)
  const tableNumber =
    tableNumberFromUrl ||
    readStoredTableNumber() ||
    (typeof window !== 'undefined' ? getSessionInfo()?.table : null) ||
    ''

  const [tabRecord, setTabRecord] = useState<TabRow | null>(null)
  const [orders, setOrders] = useState<OrderRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [redirecting, setRedirecting] = useState(false)

  useEffect(() => {
    if (!restaurantId) {
      setLoading(false)
      return
    }

    const tableNum = Number(tableNumber) || 0
    if (tableNum <= 0) {
      setLoading(false)
      return
    }

    if (!storedTabId) {
      console.log('[RECEIPT] no tab_id in localStorage — redirect to landing')
      setRedirecting(true)
      handleSessionExpired(restaurantId)
      return
    }

    let cancelled = false

    const validateAndLoad = async () => {
      try {
        setLoading(true)
        const tab = await fetchTabById(storedTabId, restaurantId)
        if (cancelled) return

        if (!tab || String(tab.status || '').toLowerCase() === 'settled') {
          console.log('[RECEIPT] tab missing or settled — redirect to landing', tab?.status)
          setRedirecting(true)
          handleSessionExpired(restaurantId)
          return
        }

        if (!isActiveTabStatus(tab.status)) {
          setRedirecting(true)
          handleSessionExpired(restaurantId)
          return
        }

        setTabRecord(tab)
        if (tab.id) {
          persistTabSession(tab.id, tableNum)
        }

        const rows = await fetchOrdersForTab(storedTabId, restaurantId)
        if (cancelled) return

        const ordersList = (rows || [])
          .map((order) => ({ ...(order as OrderRecord), id: String((order as { id?: string }).id || '') }))
          .filter((order) => order.id)
          .filter((order) => !String(order.tab_settlement_for_tab_id || '').trim())

        setOrders(ordersList)
        setLoading(false)
      } catch (error) {
        if (cancelled) return
        console.error('[RECEIPT] validate/load error', error)
        setRedirecting(true)
        handleSessionExpired(restaurantId)
      }
    }

    void validateAndLoad()

    const channel = supabase
      .channel(`receipt-tab-${storedTabId}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'tabs', filter: `id=eq.${storedTabId}` },
        () => {
          void fetchTabById(storedTabId, restaurantId).then((tab) => {
            if (!tab || String(tab.status || '').toLowerCase() === 'settled' || !isActiveTabStatus(tab.status)) {
              handleSessionExpired(restaurantId)
              return
            }
            setTabRecord(tab)
          })
          void validateAndLoad()
          void refreshTab()
        }
      )
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'orders',
          filter: `tab_id=eq.${storedTabId}`,
        },
        () => {
          void validateAndLoad()
        }
      )
      .subscribe()

    return () => {
      cancelled = true
      supabase.removeChannel(channel)
    }
  }, [restaurantId, tableNumber, storedTabId, router, refreshTab])

  const tableNum = tableNumber ? Number(tableNumber) : null

  const tabGrandTotal = useMemo(
    () => orders.reduce((sum, o) => sum + (Number(o.total) || 0), 0),
    [orders]
  )

  const memberNameMap = useMemo(() => buildMemberNameMap(tabRecord), [tabRecord])

  // No table number
  if (!loading && (!tableNum || tableNum <= 0)) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center p-6">
        <OrderStatusBanner restaurantId={restaurantId} tableNumber={tableNum ?? 0} />
        <div className="max-w-md w-full bg-card border border-border p-12 text-center">
          <div className="mx-auto mb-6 flex h-16 w-16 items-center justify-center rounded-full border-2 border-border bg-muted">
            <FileText className="h-8 w-8 text-muted-foreground stroke-[1.5]" aria-hidden />
          </div>
          <h1 className="text-2xl font-serif font-bold text-foreground mb-4">Table Number Required</h1>
          <p className="text-muted-foreground font-sans mb-6">
            Please scan the QR code at your table to view your receipt.
          </p>
          {restaurantId && (
            <Link href={`/menu/${restaurantId}/browse`}>
              <Button className="bg-foreground text-background hover:bg-foreground/90 font-sans">
                Browse Menu
              </Button>
            </Link>
          )}
        </div>
      </div>
    )
  }

  if (redirecting) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="w-10 h-10 border-2 border-border border-t-foreground animate-spin mx-auto" />
      </div>
    )
  }

  // Loading
  if (loading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <OrderStatusBanner restaurantId={restaurantId} tableNumber={tableNum ?? 0} />
        <div className="text-center">
          <div className="w-10 h-10 border-2 border-border border-t-foreground animate-spin mx-auto" />
          <p className="mt-6 text-muted-foreground font-sans">Loading receipt...</p>
        </div>
      </div>
    )
  }

  // Data safety
  if (!orders || !Array.isArray(orders)) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <OrderStatusBanner restaurantId={restaurantId} tableNumber={tableNum ?? 0} />
        <div className="text-center">
          <div className="w-10 h-10 border-2 border-border border-t-foreground animate-spin mx-auto" />
          <p className="mt-6 text-muted-foreground font-sans">Loading receipt...</p>
        </div>
      </div>
    )
  }

  // No orders
  if (orders.length === 0) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center p-6">
        <OrderStatusBanner restaurantId={restaurantId} tableNumber={tableNum ?? 0} />
        <div className="max-w-md w-full bg-card border border-border p-12 text-center">
          <div className="mx-auto mb-6 flex h-16 w-16 items-center justify-center rounded-full border-2 border-border bg-muted">
            <FileText className="h-8 w-8 text-muted-foreground stroke-[1.5]" aria-hidden />
          </div>
          <h1 className="text-2xl font-serif font-bold text-foreground mb-4">No Orders Yet</h1>
          <p className="text-muted-foreground font-sans mb-6">
            {tableNumber 
              ? `No active orders found for Table ${tableNumber}.`
              : 'No active orders found.'}
          </p>
          {restaurantId && tableNumber && (
            <Button
              className="bg-foreground text-background hover:bg-foreground/90 font-sans"
              onClick={() => handleSessionExpired(restaurantId)}
            >
              Start over
            </Button>
          )}
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-background">
      <OrderStatusBanner restaurantId={restaurantId} tableNumber={tableNum ?? 0} />
      <div className="max-w-2xl mx-auto p-6">
        {/* Receipt Header */}
        <div className="bg-card border border-border p-8 mb-6">
          {/* Back Button */}
          <button
            onClick={() => router.back()}
            className="flex items-center gap-2 text-foreground font-sans font-semibold mb-6 hover:opacity-70 transition"
          >
            <ArrowLeft className="w-4 h-4 stroke-[1.5]" />
            Back
          </button>

          {/* Restaurant Name */}
          <div className="text-center border-b border-border pb-6 mb-6">
            <h1 className="text-3xl font-serif font-bold text-foreground mb-2">
              {restaurant?.name || 'Receipt'}
            </h1>
            <p className="text-muted-foreground font-sans text-sm">
              Shared tab • Table {tableNumber} • {orders.length} Order{orders.length !== 1 ? 's' : ''}
            </p>
          </div>

          {/* Summary */}
          <div className="space-y-3">
            <div className="flex justify-between items-center font-sans">
              <span className="text-muted-foreground">Total Orders</span>
              <span className="font-bold text-foreground">{orders.length}</span>
            </div>
            <div className="flex justify-between items-center font-sans border-t border-border pt-3">
              <span className="text-lg font-semibold text-foreground">Tab Total</span>
              <span className="text-2xl font-bold text-foreground">
                {currency}{tabGrandTotal.toFixed(2)}
              </span>
            </div>
          </div>
        </div>

        {/* Orders List */}
        <div className="space-y-4">
          {orders.map((order) => {
            if (!order) return null
            
            const displayDate = formatOrderTimestamp(order.placed_at ?? order.created_at)

            const orderTotal = typeof order.total === 'number' ? order.total : 0
            const customerLabel = getOrderCustomerLabel(order, memberNameMap)

            return (
              <div key={order.id || Math.random()} className="bg-card border border-border p-6">
                {/* Order Header */}
                <div className="flex justify-between items-start mb-4 pb-4 border-b border-border">
                  <div>
                    <h3 className="font-sans font-bold text-foreground text-lg">
                      Order #{order.order_number || order.id?.slice(-6)?.toUpperCase() || 'N/A'} —{' '}
                      {customerLabel}
                    </h3>
                    <p className="text-sm text-muted-foreground font-sans">
                      {displayDate}
                    </p>
                  </div>
                  <div className="text-right">
                    <p className="text-xl font-bold text-foreground font-sans">
                      {currency}{orderTotal.toFixed(2)}
                    </p>
                    {(() => {
                      const badge = getReceiptStatusBadge(order)
                      return (
                        <span className={`inline-block px-3 py-1 text-xs font-semibold uppercase tracking-wide mt-2 ${badge.className}`}>
                          {badge.label}
                        </span>
                      )
                    })()}
                  </div>
                </div>

                {/* Order Items */}
                {order.items && Array.isArray(order.items) && order.items.length > 0 ? (
                  <div className="space-y-2">
                    {order.items.map((item: any, idx: number) => (
                      <div key={idx} className="flex justify-between text-sm font-sans">
                        <span className="text-muted-foreground">
                          {(item?.quantity || 1)}× {item?.name || 'Unknown Item'}
                        </span>
                        <span className="font-semibold text-foreground">
                          {currency}{((item?.subtotal || 0)).toFixed(2)}
                        </span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-muted-foreground font-sans text-sm">No items found</p>
                )}

                {String(order.payment_channel || '').toLowerCase() === 'terminal' &&
                  String(order.payment_status || '').toLowerCase() === 'pending' &&
                  String(order.status || '').toLowerCase() !== 'completed' && (
                    <div className="mt-4 border-t border-border pt-4">
                      {String(order.status || '').toLowerCase() === 'ready_for_terminal' ||
                      order.customer_ready_to_pay === true ? (
                        <ReadyToPayTerminalNotified />
                      ) : (
                        <ReadyToPayTerminalButton
                          restaurantId={restaurantId}
                          orderId={String(order.id)}
                          tableNumber={Number(order.table_number) || Number(tableNumber) || 0}
                          sessionId={getCurrentSession()}
                          alreadyNotified={
                            String(order.status || '').toLowerCase() === 'ready_for_terminal'
                          }
                        />
                      )}
                    </div>
                  )}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
