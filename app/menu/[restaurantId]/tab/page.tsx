'use client'

export const dynamic = 'force-dynamic'

import { useEffect, useMemo, useState } from 'react'
import { useParams, useSearchParams, useRouter } from 'next/navigation'
import { useRestaurant } from '@/contexts/restaurant-context'
import { useTab } from '@/contexts/tab-context'
import {
  fetchOrdersForTab,
  fetchTabById,
  resolveStoredTabId,
  type TabRow,
} from '@/lib/tab-session'
import { persistTabSession } from '@/lib/tab-storage'
import { Button } from '@/components/ui/button'
import { useToast } from '@/hooks/use-toast'
import { fetchWithSession } from '@/lib/fetch-with-session'
import { handleSessionExpired } from '@/lib/handle-session-expired'
import { cn } from '@/lib/utils'

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
  isCurrentUser: boolean
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
  const tabIdFromUrl = searchParams.get('tabId')?.trim() || ''

  const storedTabId = resolveStoredTabId(tabIdFromUrl)
  const { sessionId, tabMembers, tabStatus, refreshTab } = useTab()
  const { currency, permissions, refresh } = useRestaurant()
  const [tabRecord, setTabRecord] = useState<TabRow | null>(null)
  const [orders, setOrders] = useState<TabOrder[]>([])
  const [loading, setLoading] = useState(true)
  const [redirecting, setRedirecting] = useState(false)
  const [readyToPayLoading, setReadyToPayLoading] = useState(false)
  const [readyToPayNotified, setReadyToPayNotified] = useState(false)
  const [paymentPreference, setPaymentPreference] = useState<'cash' | 'card' | 'other' | null>(null)
  const [showPaymentSelector, setShowPaymentSelector] = useState(false)

  const tabReadyToPay = tabStatus === 'ready_to_pay' || tabRecord?.status === 'ready_to_pay' || readyToPayNotified

  const creatorTabPin = useMemo(() => {
    if (typeof window === 'undefined' || !storedTabId) return null
    const storedCreatorTabId = sessionStorage.getItem('flashtap_creator_tab_id')
    const pin = sessionStorage.getItem('flashtap_creator_tab_pin')
    if (storedCreatorTabId === storedTabId && pin) return pin
    return null
  }, [storedTabId])

  useEffect(() => {
    if (tabStatus === 'ready_to_pay') {
      setReadyToPayNotified(true)
    }
  }, [tabStatus])

  useEffect(() => {
    const tableNum = Number(tableNumber) || 0
    if (!restaurantId || tableNum <= 0) {
      setLoading(false)
      return
    }

    if (!storedTabId) {
      setRedirecting(true)
      handleSessionExpired(restaurantId)
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
          handleSessionExpired(restaurantId)
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
          handleSessionExpired(restaurantId)
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

    const buildGroup = (memberSid: string, label: string, isCurrentUser: boolean): MemberGroup => {
      const memberOrders = tabOrders.filter((o) => {
        const orderSid = String(o.member_session_id || o.session_id || '').trim()
        return orderSid === memberSid
      })
      const group: MemberGroup = { memberKey: memberSid, label, isCurrentUser, items: [], subtotal: 0 }
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
          group = { memberKey: memberSid, label: 'Guest', isCurrentUser: memberSid === sessionId, items: [], subtotal: 0 }
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
        const displayName = String(member.display_name || '').trim() || 'Guest'
        const isCurrentUser = memberSid === sessionId
        const label = displayName
        return buildGroup(memberSid, label, isCurrentUser)
      })
      .filter((g): g is MemberGroup => Boolean(g && g.items.length > 0))
  }, [ordersForDisplay, sessionId, tabMembers, currency])

  const fullTabRunningTotal = useMemo(
    () => ordersForDisplay.reduce((sum, order) => sum + (Number(order.total) || 0), 0),
    [ordersForDisplay]
  )

  const updateMemberName = async (newName: string) => {
    if (!storedTabId || !sessionId || !restaurantId) return
    const res = await fetchWithSession(
      `/api/tabs/${encodeURIComponent(storedTabId)}/member`,
      restaurantId,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId, displayName: newName }),
      }
    )
    if (res.status === 410) {
      handleSessionExpired(restaurantId)
      return
    }
    const data = await res.json().catch(() => ({}))
    if (!res.ok) {
      throw new Error(data?.error || 'Failed to update name')
    }
    sessionStorage.setItem('flashtap_display_name', newName)
    await refreshTab()
    const tab = await fetchTabById(storedTabId, restaurantId)
    if (tab) setTabRecord(tab)
  }

  const handleReadyToPay = async () => {
    if (!storedTabId || !restaurantId || tabReadyToPay || readyToPayLoading) return
    if (!paymentPreference) {
      setShowPaymentSelector(true)
      return
    }
    if (tabStatus === 'ready_to_pay' || tabRecord?.status === 'ready_to_pay') {
      setReadyToPayNotified(true)
      return
    }
    setReadyToPayLoading(true)
    console.log('[TAB PAGE] ready to pay', {
      tabId: tabRecord?.id ?? storedTabId,
      restaurantId,
      paymentPreference,
    })
    try {
      const res = await fetchWithSession(
        `/api/tabs/${encodeURIComponent(storedTabId)}/ready-to-pay`,
        restaurantId,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ restaurantId, paymentPreference }),
        }
      )
      if (res.status === 410) {
        handleSessionExpired(restaurantId)
        return
      }
      const data = await res.json().catch(() => ({}))
      if (res.status === 403 && data?.settingsVersion != null) {
        await refresh()
        toast({
          title: 'Payment option unavailable',
          description: 'Cash payments are no longer available. Please select Card.',
          variant: 'destructive',
        })
        setPaymentPreference(null)
        return
      }
      if (res.status === 409 && data?.alreadyReady) {
        setReadyToPayNotified(true)
        await refreshTab()
        const tab = await fetchTabById(storedTabId, restaurantId)
        if (tab) setTabRecord(tab)
        return
      }
      if (!res.ok) {
        throw new Error(data?.error || data?.message || `Request failed (${res.status})`)
      }
      console.log('[TAB PAGE] ready to pay success', data)
      setReadyToPayNotified(true)
      setShowPaymentSelector(false)
      await refreshTab()
      const tab = await fetchTabById(storedTabId, restaurantId)
      if (tab) setTabRecord(tab)
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
            onClick={() => handleSessionExpired(restaurantId)}
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

        {creatorTabPin && tabRecord?.pin_required !== false && (
          <div className="mb-6 rounded-lg border border-emerald-400/40 bg-emerald-500/10 px-4 py-3 text-center text-sm font-sans text-foreground">
            Tab PIN:{' '}
            <span className="font-bold text-emerald-600">{creatorTabPin}</span> — Share with your group
          </div>
        )}

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
              <h2 className="font-sans text-base font-semibold text-foreground">
                {group.isCurrentUser ? `You — ${group.label}` : group.label}
                {group.isCurrentUser && (
                  <button
                    type="button"
                    onClick={() => {
                      const newName = prompt('Enter your name:', group.label)
                      if (newName?.trim()) {
                        void updateMemberName(newName.trim()).catch((err) => {
                          toast({
                            title: 'Could not update name',
                            description: err instanceof Error ? err.message : 'Please try again.',
                            variant: 'destructive',
                          })
                        })
                      }
                    }}
                    className="text-xs text-muted-foreground underline ml-2 font-normal"
                  >
                    Edit
                  </button>
                )}
              </h2>
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
          {!tabReadyToPay && (
            <Button
              variant="outline"
              size="lg"
              className="w-full border-2 border-border text-foreground font-sans text-base py-6 mb-3"
              onClick={() =>
                router.push(
                  `/menu/${restaurantId}/browse?table=${tableNumber}&tabId=${storedTabId}`
                )
              }
            >
              + Order More
            </Button>
          )}

          {!tabReadyToPay && !showPaymentSelector && (
            <Button
              type="button"
              className="w-full py-4 px-6 text-base font-semibold text-white bg-[#16A34A] hover:bg-green-700 h-auto min-h-[3rem]"
              onClick={() => setShowPaymentSelector(true)}
              disabled={fullTabRunningTotal <= 0}
            >
              Settle Tab • {currency}
              {fullTabRunningTotal.toFixed(2)}
            </Button>
          )}

          {!tabReadyToPay && showPaymentSelector && (
            <div className="space-y-3">
              <p className="text-center text-sm font-semibold text-foreground font-sans">
                How would you like to pay?
              </p>
              <div className="grid gap-2">
                {(['cash', 'card', 'other'] as const)
                  .filter((method) => {
                    if (method === 'other') return true
                    if (method === 'cash') return permissions.canPayCash
                    if (method === 'card') return permissions.canPayCard
                    return true
                  })
                  .map((method) => (
                  <button
                    key={method}
                    onClick={() => setPaymentPreference(method)}
                    className={cn(
                      'rounded-lg border-2 p-3 text-left transition-colors font-sans',
                      paymentPreference === method
                        ? 'border-foreground bg-muted/50'
                        : 'border-border bg-background'
                    )}
                  >
                    <span className="text-lg mr-2">
                      {method === 'cash' ? '💵' : method === 'card' ? '💳' : '🤝'}
                    </span>
                    <span className="font-semibold text-foreground">
                      {method === 'card' ? 'Card' : method === 'cash' ? 'Cash' : 'Other'}
                    </span>
                  </button>
                ))}
              </div>
              <Button
                className="w-full py-4 px-6 text-base font-semibold text-white bg-[#16A34A] hover:bg-green-700 h-auto min-h-[3rem]"
                onClick={() => void handleReadyToPay()}
                disabled={!paymentPreference || readyToPayLoading}
              >
                {readyToPayLoading
                  ? 'Sending…'
                  : `Confirm — ${currency}${fullTabRunningTotal.toFixed(2)}`}
              </Button>
              <button
                onClick={() => {
                  setShowPaymentSelector(false)
                  setPaymentPreference(null)
                }}
                className="w-full text-center text-sm text-muted-foreground py-2"
              >
                Cancel
              </button>
            </div>
          )}

          {tabReadyToPay && (
            <div className="rounded-lg border border-green-200 bg-green-50 p-4 text-center space-y-2">
              <p className="font-sans text-sm font-medium text-green-900">
                ✓ Payment Requested
              </p>
              {tabRecord?.payment_preference && (
                <p className="font-sans text-sm text-green-700">
                  Payment preference:{' '}
                  {tabRecord.payment_preference === 'cash'
                    ? '💵 Cash'
                    : tabRecord.payment_preference === 'card'
                      ? '💳 Card'
                      : '🤝 Other'}
                </p>
              )}
              <p className="font-sans text-xs text-green-600">
                A waiter has been notified and will assist you shortly.
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
