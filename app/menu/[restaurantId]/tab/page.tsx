'use client'

export const dynamic = 'force-dynamic'

import { useEffect, useMemo, useState } from 'react'
import { useParams, useSearchParams, useRouter } from 'next/navigation'
import { getRestaurant } from '@/lib/supabase/restaurants'
import { useTab } from '@/contexts/tab-context'
import {
  clearTabAndGetLandingPath,
  fetchOrdersForTab,
  fetchTabById,
  resolveStoredTabId,
  type TabRow,
} from '@/lib/tab-session'
import { persistTabSession } from '@/lib/tab-storage'
import { Button } from '@/components/ui/button'
import { CheckCircle2 } from 'lucide-react'
import { useToast } from '@/hooks/use-toast'

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

const READY_TO_PAY_MESSAGE =
  'Waiter has been notified — the card machine is on its way'

export default function TabSummaryPage() {
  const params = useParams()
  const searchParams = useSearchParams()
  const router = useRouter()
  const { toast } = useToast()
  const restaurantId = params.restaurantId as string
  const tableNumber = searchParams.get('table') || ''
  const tabIdFromUrl = searchParams.get('tabId')?.trim() || ''

  const storedTabId = resolveStoredTabId(tabIdFromUrl)
  const { sessionId, tabMembers, tabStatus, refreshTab } = useTab()
  const [tabRecord, setTabRecord] = useState<TabRow | null>(null)
  const [orders, setOrders] = useState<TabOrder[]>([])
  const [restaurant, setRestaurant] = useState<{ currency?: string } | null>(null)
  const [loading, setLoading] = useState(true)
  const [redirecting, setRedirecting] = useState(false)
  const [readyToPayLoading, setReadyToPayLoading] = useState(false)
  const [readyToPayNotified, setReadyToPayNotified] = useState(false)

  const tabReadyToPay = tabStatus === 'ready_to_pay' || tabRecord?.status === 'ready_to_pay' || readyToPayNotified

  const currency = restaurant?.currency || 'N$'

  useEffect(() => {
    if (tabStatus === 'ready_to_pay') {
      setReadyToPayNotified(true)
    }
  }, [tabStatus])

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
    const tableNum = Number(tableNumber) || 0
    if (!restaurantId || tableNum <= 0) {
      setLoading(false)
      return
    }

    if (!storedTabId) {
      setRedirecting(true)
      router.replace(clearTabAndGetLandingPath(restaurantId, tableNum))
      return
    }

    let cancelled = false
    const load = async () => {
      try {
        setLoading(true)
        const tab = await fetchTabById(storedTabId, restaurantId)
        if (cancelled) return

        if (!tab || String(tab.status || '').toLowerCase() === 'settled') {
          setRedirecting(true)
          router.replace(clearTabAndGetLandingPath(restaurantId, tableNum))
          return
        }

        setTabRecord(tab)
        persistTabSession(storedTabId, tableNum)

        const rows = await fetchOrdersForTab(storedTabId, restaurantId)
        if (cancelled) return
        setOrders(
          (rows || []).map((d: any) => ({ id: String(d.id), ...(d as Omit<TabOrder, 'id'>) }))
        )
        setLoading(false)
      } catch {
        if (!cancelled) {
          setRedirecting(true)
          router.replace(clearTabAndGetLandingPath(restaurantId, tableNum))
        }
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [restaurantId, tableNumber, storedTabId, router])

  const ordersForDisplay = useMemo(
    () => orders.filter((o) => !String(o.tab_settlement_for_tab_id || '').trim()),
    [orders]
  )

  const groupedOrders = useMemo((): MemberGroup[] => {
    const tabOrders = ordersForDisplay
    const members = tabMembers.length > 0 ? tabMembers : []

    const buildGroup = (memberSid: string, label: string): MemberGroup => {
      const memberOrders = tabOrders.filter((o) => {
        const orderSid = String(o.member_session_id || o.session_id || '').trim()
        return orderSid === memberSid
      })
      const group: MemberGroup = { memberKey: memberSid, label, items: [], subtotal: 0 }
      for (const order of memberOrders) {
        group.subtotal += Number(order.total) || 0
        const orderItems = Array.isArray(order.items) ? order.items : []
        for (const item of orderItems) {
          const name = String(item.display_name || item.name || 'Item')
          const quantity = Number(item.quantity) || 1
          const subtotal = Number(item.subtotal) || 0
          group.items.push(`${name} ×${quantity} — ${currency}${subtotal.toFixed(2)}`)
        }
      }
      return group
    }

    if (members.length === 0) {
      const bySid = new Map<string, MemberGroup>()
      for (const order of tabOrders) {
        const memberSid =
          String(order.member_session_id || order.session_id || 'unknown').trim() || 'unknown'
        let group = bySid.get(memberSid)
        if (!group) {
          group = { memberKey: memberSid, label: 'Guest', items: [], subtotal: 0 }
          bySid.set(memberSid, group)
        }
        group.subtotal += Number(order.total) || 0
        const orderItems = Array.isArray(order.items) ? order.items : []
        for (const item of orderItems) {
          const name = String(item.display_name || item.name || 'Item')
          const quantity = Number(item.quantity) || 1
          const subtotal = Number(item.subtotal) || 0
          group.items.push(`${name} ×${quantity} — ${currency}${subtotal.toFixed(2)}`)
        }
      }
      return Array.from(bySid.values())
    }

    return members
      .map((member) => {
        const memberSid = String(member.session_id || '').trim()
        if (!memberSid) return null
        const displayName = String(member.display_name || '').trim()
        let label = displayName || 'Guest'
        if (memberSid === sessionId) label = displayName ? `You (${displayName})` : 'You'
        return buildGroup(memberSid, label)
      })
      .filter((g): g is MemberGroup => Boolean(g && g.items.length > 0))
  }, [ordersForDisplay, sessionId, tabMembers, currency])

  const fullTabRunningTotal = useMemo(
    () => ordersForDisplay.reduce((sum, order) => sum + (Number(order.total) || 0), 0),
    [ordersForDisplay]
  )

  const handleReadyToPay = async () => {
    if (!storedTabId || !restaurantId || tabReadyToPay || readyToPayLoading) return
    if (tabStatus === 'ready_to_pay' || tabRecord?.status === 'ready_to_pay') {
      setReadyToPayNotified(true)
      return
    }
    setReadyToPayLoading(true)
    console.log('[TAB PAGE] ready to pay', { tabId: tabRecord?.id ?? storedTabId, restaurantId })
    try {
      const res = await fetch(`/api/tabs/${encodeURIComponent(storedTabId)}/ready-to-pay`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ restaurantId }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        throw new Error(data?.error || `Request failed (${res.status})`)
      }
      console.log('[TAB PAGE] ready to pay success', data)
      setReadyToPayNotified(true)
      await refreshTab()
    } catch (err) {
      console.error('[TAB PAGE] ready to pay failed', err)
      toast({
        title: 'Could not notify waiter',
        description: err instanceof Error ? err.message : 'Please try again.',
        variant: 'destructive',
      })
    } finally {
      setReadyToPayLoading(false)
    }
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="w-10 h-10 border-2 border-border border-t-foreground animate-spin" />
      </div>
    )
  }

  if (redirecting) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="w-10 h-10 border-2 border-border border-t-foreground animate-spin" />
      </div>
    )
  }

  if (!storedTabId || !tabRecord) {
    return (
      <div className="min-h-screen bg-background px-4 py-10">
        <div className="mx-auto max-w-md text-center">
          <h1 className="font-serif text-xl font-bold text-foreground">No active tab</h1>
          <p className="mt-2 text-sm text-muted-foreground">Start or join a tab from the table landing page.</p>
          <Button
            className="mt-6"
            onClick={() => router.replace(clearTabAndGetLandingPath(restaurantId, tableNumber))}
          >
            Go to start
          </Button>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-background">
      <div className="mx-auto max-w-3xl px-4 py-6">
        <div className="mb-6 text-center">
          <h1 className="font-serif text-2xl font-bold text-foreground">Table {tableNumber || '-'} Tab</h1>
          <p className="mt-1 text-sm text-muted-foreground font-sans">Review your tab before paying</p>
        </div>

        <div className="mb-8 rounded-lg border-2 border-border bg-card p-6 text-center">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Full tab running total</p>
          <p className="mt-2 font-serif text-4xl font-bold text-foreground">
            {currency}
            {fullTabRunningTotal.toFixed(2)}
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
          {fullTabRunningTotal.toFixed(2)}
        </div>

        <div className="mt-8 space-y-4">
          {tabReadyToPay ? (
            <div
              className="rounded-lg border border-green-200 bg-green-50 dark:border-green-900 dark:bg-green-950/40 p-6 text-center"
              role="status"
            >
              <CheckCircle2 className="mx-auto h-10 w-10 text-green-600 dark:text-green-400 mb-3" aria-hidden />
              <p className="font-sans text-base font-medium text-green-900 dark:text-green-100">
                {READY_TO_PAY_MESSAGE}
              </p>
            </div>
          ) : (
            <Button
              className="w-full py-4 px-6 text-base font-semibold text-white text-center bg-[#16A34A] hover:bg-green-700 h-auto min-h-[3rem]"
              onClick={handleReadyToPay}
              disabled={readyToPayLoading || fullTabRunningTotal <= 0}
            >
              {readyToPayLoading ? 'Sending…' : 'Ready to Pay'}
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}
