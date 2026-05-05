'use client'

export const dynamic = 'force-dynamic'

import { useEffect, useMemo, useState } from 'react'
import { useParams, useRouter, useSearchParams } from 'next/navigation'
import { collection, getDocs, query, where } from 'firebase/firestore'
import { db } from '@/lib/firebase/config'
import { ordersPath } from '@/lib/firebase/paths'
import { getRestaurant } from '@/lib/firebase/restaurants'
import { useTab } from '@/contexts/tab-context'
import { Button } from '@/components/ui/button'
import { ArrowLeft } from 'lucide-react'
import { useToast } from '@/hooks/use-toast'
import { clearOrderIdempotencyKey, getOrderIdempotencyKey } from '@/lib/order-idempotency'

type TabOrder = {
  id: string
  member_session_id?: string | null
  session_id?: string | null
  tab_settlement_for_tab_id?: string | null
  payment_status?: string | null
  items?: Array<{
    name?: string
    display_name?: string
    quantity?: number
    subtotal?: number
    menu_item_id?: string
  }>
  total?: number
}

type MemberGroup = {
  memberKey: string
  label: string
  items: string[]
  subtotal: number
}

export default function TabSummaryPage() {
  const params = useParams()
  const searchParams = useSearchParams()
  const router = useRouter()
  const { toast } = useToast()
  const restaurantId = params.restaurantId as string
  const tableNumber = searchParams.get('table') || ''

  const { tabId, sessionId, tabTotal, tabMembers } = useTab()
  const [orders, setOrders] = useState<TabOrder[]>([])
  const [restaurant, setRestaurant] = useState<{ currency?: string } | null>(null)
  const [loading, setLoading] = useState(true)
  const [submitting, setSubmitting] = useState<'full' | 'mine' | null>(null)

  const browseQuery = useMemo(() => {
    const q = new URLSearchParams()
    if (tableNumber) q.set('table', tableNumber)
    if (tabId) q.set('tabId', tabId)
    const s = q.toString()
    return s ? `?${s}` : ''
  }, [tableNumber, tabId])

  const currency = restaurant?.currency || 'N$'

  useEffect(() => {
    const loadRestaurant = async () => {
      if (!restaurantId) return
      try {
        const r = await getRestaurant(restaurantId)
        setRestaurant(r)
      } catch {
        setRestaurant(null)
      }
    }
    loadRestaurant()
  }, [restaurantId])

  useEffect(() => {
    const load = async () => {
      if (!restaurantId || !db || !tabId) {
        setLoading(false)
        return
      }
      try {
        const ordersRef = collection(db, ordersPath(restaurantId))
        const ordersQuery = query(ordersRef, where('tab_id', '==', tabId))
        const snapshot = await getDocs(ordersQuery)
        setOrders(
          snapshot.docs.map((d) => ({
            id: d.id,
            ...(d.data() as Omit<TabOrder, 'id'>),
          }))
        )
      } finally {
        setLoading(false)
      }
    }
    load()
  }, [restaurantId, tabId])

  const ordersForDisplay = useMemo(
    () => orders.filter((o) => !String(o.tab_settlement_for_tab_id || '').trim()),
    [orders]
  )

  const groupedOrders = useMemo((): MemberGroup[] => {
    const groups = new Map<string, MemberGroup>()
    for (const order of ordersForDisplay) {
      const memberKey = String(order.member_session_id || order.session_id || 'unknown')
      const fromTab = tabMembers.find((m) => String(m.session_id) === memberKey)
      const displayName = String(fromTab?.display_name || '').trim()
      let label = displayName
      if (memberKey === sessionId) label = displayName ? `You (${displayName})` : 'You'
      else if (!label) label = 'Guest'

      const existing = groups.get(memberKey)
      const group = existing || { memberKey, label, items: [], subtotal: 0 }
      if (group.label === 'Guest' && label !== 'Guest') group.label = label

      const orderItems = Array.isArray(order.items) ? order.items : []
      for (const item of orderItems) {
        const name = String(item.display_name || item.name || 'Item')
        const quantity = Number(item.quantity) || 1
        const subtotal = Number(item.subtotal) || 0
        group.items.push(`${name} ×${quantity} — ${currency}${subtotal.toFixed(2)}`)
        group.subtotal += subtotal
      }
      groups.set(memberKey, group)
    }
    return Array.from(groups.values())
  }, [ordersForDisplay, sessionId, tabMembers, currency])

  const combinedFromOrders = useMemo(
    () => groupedOrders.reduce((sum, g) => sum + g.subtotal, 0),
    [groupedOrders]
  )

  const fullTabRunningTotal = useMemo(() => {
    if (Number(tabTotal) > 0) return Number(tabTotal)
    return combinedFromOrders
  }, [tabTotal, combinedFromOrders])

  const myMemberSubtotal = useMemo(() => {
    const mine = groupedOrders.find((g) => g.memberKey === sessionId)
    return mine?.subtotal ?? 0
  }, [groupedOrders, sessionId])

  const buildSettlementItems = (sourceOrders: TabOrder[]) => {
    const flattened = sourceOrders.flatMap((order) =>
      (Array.isArray(order.items) ? order.items : []).map((item) => ({
        menuItemId: String(item.menu_item_id || 'tab_item'),
        name: String(item.name || item.display_name || 'Item'),
        displayName: String(item.display_name || item.name || 'Item'),
        quantity: Number(item.quantity) || 1,
        basePrice: Number(item.subtotal) || 0,
        subtotal: Number(item.subtotal) || 0,
      }))
    )
    return flattened.length > 0
      ? flattened
      : [
          {
            menuItemId: 'tab_settlement',
            name: 'Tab Settlement',
            displayName: `Tab Settlement • Table ${tableNumber || '-'}`,
            quantity: 1,
            basePrice: 0,
            subtotal: 0,
          },
        ]
  }

  const buildSettlementDescription = (sourceOrders: TabOrder[], mode: 'full' | 'mine') => {
    const itemNames = sourceOrders
      .flatMap((order) => (Array.isArray(order.items) ? order.items : []))
      .map((item) => `${Number(item.quantity) || 1}x ${String(item.display_name || item.name || 'Item')}`)
      .filter(Boolean)

    if (itemNames.length === 0) {
      return mode === 'full'
        ? `FlashTap Table ${tableNumber || '-'} Tab Settlement`
        : `FlashTap Table ${tableNumber || '-'} Member Tab Settlement`
    }

    const joined = itemNames.join(', ')
    const capped = joined.length > 240 ? `${joined.slice(0, 237)}...` : joined
    return `FlashTap Table ${tableNumber || '-'} ${mode === 'full' ? 'Tab' : 'Member'} Settlement: ${capped}`
  }

  const startSettlementCheckout = async (mode: 'full' | 'mine', amount: number) => {
    if (!tabId || !restaurantId || amount <= 0) return
    try {
      setSubmitting(mode)
      const payableOrders = ordersForDisplay.filter(
        (order) =>
          String(order.payment_status || '').toLowerCase() !== 'paid' &&
          (mode === 'full' || String(order.member_session_id || order.session_id || '').trim() === sessionId)
      )
      const settlementItems = buildSettlementItems(payableOrders)
      const settlementDescription = buildSettlementDescription(payableOrders, mode)
      const payload =
        mode === 'full'
          ? {
              restaurantId,
              tableNumber: Number(tableNumber) || 0,
              session_id: sessionId,
              tab_id: tabId,
              member_session_id: sessionId,
              tab_settlement_for_tab_id: tabId,
              items: settlementItems,
              subtotal: amount,
              total: amount,
              paymentMethod: 'card',
              description: settlementDescription,
            }
          : {
              restaurantId,
              tableNumber: Number(tableNumber) || 0,
              session_id: sessionId,
              tab_id: tabId,
              member_session_id: sessionId,
              tab_settlement_for_tab_id: tabId,
              tab_settlement_member_session_id: sessionId,
              items: settlementItems,
              subtotal: amount,
              total: amount,
              paymentMethod: 'card',
              description: settlementDescription,
            }

      const idem = getOrderIdempotencyKey(String(restaurantId), Number(tableNumber) || 0)
      const response = await fetch('/api/orders', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(idem ? { 'x-idempotency-key': idem } : {}),
        },
        body: JSON.stringify(payload),
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok || !data?.checkoutUrl) {
        throw new Error(data?.error || 'Could not start payment')
      }
      clearOrderIdempotencyKey()
      const settlementOrderId = String(data.orderId || '')
      if (typeof window !== 'undefined') {
        sessionStorage.setItem('flashtap_tab_settlement_order_id', settlementOrderId)
      }
      window.location.href = String(data.checkoutUrl)
    } catch (err: any) {
      toast({
        title: 'Payment start failed',
        description: err?.message || 'Could not start payment.',
        variant: 'destructive',
      })
      setSubmitting(null)
    }
  }

  const handlePayFullTab = () => startSettlementCheckout('full', fullTabRunningTotal)
  const handlePayMyOrders = () => startSettlementCheckout('mine', myMemberSubtotal)

  if (loading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="w-10 h-10 border-2 border-border border-t-foreground animate-spin" />
      </div>
    )
  }

  if (!tabId) {
    return (
      <div className="min-h-screen bg-background px-4 py-10">
        <div className="mx-auto max-w-md text-center">
          <h1 className="font-serif text-xl font-bold text-foreground">No tab open</h1>
          <p className="mt-2 text-sm text-muted-foreground">Open or join a tab from the table menu to see the bill here.</p>
          <Button className="mt-6" onClick={() => router.replace(`/menu/${restaurantId}/browse${browseQuery}`)}>
            Back to menu
          </Button>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-background">
      <div className="mx-auto max-w-3xl px-4 py-6">
        <div className="mb-6 flex items-center gap-3">
          <Button
            variant="ghost"
            size="icon"
            onClick={() => router.replace(`/menu/${restaurantId}/browse${browseQuery}`)}
          >
            <ArrowLeft className="w-5 h-5" />
          </Button>
          <div className="min-w-0 flex-1">
            <h1 className="font-serif text-2xl font-bold text-foreground">Table {tableNumber || '-'} Tab</h1>
          </div>
        </div>

        <div className="mb-8 rounded-lg border-2 border-border bg-card p-6 text-center">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Full tab running total</p>
          <p className="mt-2 font-serif text-4xl font-bold text-foreground">
            {currency}
            {fullTabRunningTotal.toFixed(2)}
          </p>
          <p className="mt-3 text-sm text-muted-foreground">
            Combined from orders (by person): {currency}
            {combinedFromOrders.toFixed(2)}
          </p>
        </div>

        <div className="space-y-4">
          {groupedOrders.map((group) => (
            <div key={group.memberKey} className="rounded-lg border border-border bg-card p-4">
              <h2 className="font-sans text-base font-semibold text-foreground">{group.label}</h2>
              <div className="mt-2 space-y-1 text-sm text-muted-foreground">
                {group.items.map((line, lineIndex) => (
                  <p key={`${group.memberKey}-${lineIndex}`}>{line}</p>
                ))}
              </div>
              <p className="mt-3 text-sm font-semibold text-foreground">
                Member subtotal: {currency}
                {group.subtotal.toFixed(2)}
              </p>
            </div>
          ))}
        </div>

        <div className="mt-8 rounded-md border border-dashed border-border bg-muted/30 p-4 text-center text-sm text-muted-foreground">
          Tab total {currency}
          {fullTabRunningTotal.toFixed(2)} · Sum of members above {currency}
          {combinedFromOrders.toFixed(2)}
        </div>

        <div className="mt-8 space-y-3">
          <Button
            className="w-full bg-foreground text-background hover:bg-foreground/90"
            size="lg"
            onClick={handlePayFullTab}
            disabled={submitting !== null || fullTabRunningTotal <= 0}
          >
            {submitting === 'full' ? 'Starting payment...' : 'Pay Full Tab'}
          </Button>
          <Button
            className="w-full"
            variant="outline"
            size="lg"
            onClick={handlePayMyOrders}
            disabled={submitting !== null || myMemberSubtotal <= 0}
          >
            {submitting === 'mine' ? 'Starting payment...' : `Pay My Orders (${currency}${myMemberSubtotal.toFixed(2)})`}
          </Button>
          <Button
            className="w-full"
            variant="ghost"
            onClick={() => router.replace(`/menu/${restaurantId}/browse${browseQuery}`)}
          >
            Back to Menu
          </Button>
        </div>
      </div>
    </div>
  )
}
