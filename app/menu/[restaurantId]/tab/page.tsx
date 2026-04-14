'use client'

export const dynamic = 'force-dynamic'

import { useEffect, useMemo, useState } from 'react'
import { useParams, useRouter, useSearchParams } from 'next/navigation'
import { collection, doc, getDoc, getDocs, query, where } from 'firebase/firestore'
import { db } from '@/lib/firebase/config'
import { orderPath, ordersPath, tabPath } from '@/lib/firebase/paths'
import { useTab } from '@/contexts/tab-context'
import { Button } from '@/components/ui/button'
import { ArrowLeft } from 'lucide-react'
import { useToast } from '@/hooks/use-toast'

type TabOrder = {
  id: string
  member_session_id?: string | null
  items?: Array<{ name?: string; display_name?: string; quantity?: number; subtotal?: number }>
  total?: number
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
  const [loading, setLoading] = useState(true)
  const [submitting, setSubmitting] = useState(false)

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

  const groupedOrders = useMemo(() => {
    const groups = new Map<string, { label: string; items: string[]; subtotal: number }>()
    for (const order of orders) {
      const memberKey = String(order.member_session_id || 'unknown')
      const label = memberKey === sessionId ? 'You' : `Member ${groups.size + 1}`
      const group = groups.get(memberKey) || { label, items: [], subtotal: 0 }
      const orderItems = Array.isArray(order.items) ? order.items : []
      for (const item of orderItems) {
        const name = String(item.display_name || item.name || 'Item')
        const quantity = Number(item.quantity) || 1
        const subtotal = Number(item.subtotal) || 0
        group.items.push(`${name} x${quantity} — N$${subtotal.toFixed(2)}`)
        group.subtotal += subtotal
      }
      groups.set(memberKey, group)
    }
    return Array.from(groups.values())
  }, [orders, sessionId])

  const effectiveTotal = useMemo(() => {
    if (Number(tabTotal) > 0) return Number(tabTotal)
    return groupedOrders.reduce((sum, group) => sum + group.subtotal, 0)
  }, [groupedOrders, tabTotal])

  const handlePayFullTab = async () => {
    if (!tabId || !restaurantId) return
    try {
      setSubmitting(true)
      const payload = {
        restaurantId,
        tableNumber: Number(tableNumber) || 0,
        session_id: sessionId,
        tab_id: tabId,
        member_session_id: sessionId,
        tab_settlement_for_tab_id: tabId,
        items: [
          {
            menuItemId: 'tab_settlement',
            name: 'Tab Settlement',
            displayName: `Tab Settlement • Table ${tableNumber || '-'}`,
            quantity: 1,
            basePrice: effectiveTotal,
            subtotal: effectiveTotal,
          },
        ],
        subtotal: effectiveTotal,
        total: effectiveTotal,
        paymentMethod: 'card',
      }
      const response = await fetch('/api/orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok || !data?.checkoutUrl) {
        throw new Error(data?.error || 'Could not start tab payment')
      }
      const settlementOrderId = String(data.orderId || '')
      if (typeof window !== 'undefined') {
        sessionStorage.setItem('flashtap_tab_settlement_order_id', settlementOrderId)
      }
      window.location.href = String(data.checkoutUrl)
    } catch (err: any) {
      toast({
        title: 'Payment start failed',
        description: err?.message || 'Could not start tab payment.',
        variant: 'destructive',
      })
      setSubmitting(false)
    }
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="w-10 h-10 border-2 border-border border-t-foreground animate-spin" />
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
            onClick={() => router.replace(`/menu/${restaurantId}/browse${tableNumber ? `?table=${tableNumber}` : ''}`)}
          >
            <ArrowLeft className="w-5 h-5" />
          </Button>
          <div>
            <h1 className="font-serif text-2xl font-bold text-foreground">Table {tableNumber || '-'} Tab</h1>
            <p className="text-sm text-muted-foreground">Running total: N${effectiveTotal.toFixed(2)}</p>
          </div>
        </div>

        <div className="space-y-4">
          {groupedOrders.map((group, idx) => (
            <div key={`${group.label}-${idx}`} className="rounded-lg border border-border bg-card p-4">
              <h2 className="font-sans text-base font-semibold text-foreground">{group.label}</h2>
              <div className="mt-2 space-y-1 text-sm text-muted-foreground">
                {group.items.map((line, lineIndex) => (
                  <p key={`${idx}-${lineIndex}`}>{line}</p>
                ))}
              </div>
              <p className="mt-3 text-sm font-semibold text-foreground">Subtotal: N${group.subtotal.toFixed(2)}</p>
            </div>
          ))}
        </div>

        <div className="mt-8 space-y-3">
          <Button
            className="w-full bg-foreground text-background hover:bg-foreground/90"
            size="lg"
            onClick={handlePayFullTab}
            disabled={submitting || effectiveTotal <= 0}
          >
            {submitting ? 'Starting payment...' : 'Pay Full Tab'}
          </Button>
          <Button className="w-full" variant="outline" size="lg" disabled>
            Pay My Orders (Phase 2)
          </Button>
          <Button className="w-full" variant="outline" size="lg" disabled>
            Split Equally (Phase 2)
          </Button>
          <Button
            className="w-full"
            variant="ghost"
            onClick={() => router.replace(`/menu/${restaurantId}/browse${tableNumber ? `?table=${tableNumber}` : ''}`)}
          >
            Back to Menu
          </Button>
        </div>
      </div>
    </div>
  )
}

