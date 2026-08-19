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
import { persistTabSession, readTabSessionId } from '@/lib/tab-storage'
import { getCurrentSession } from '@/lib/session'
import { fetchSharedTab, type SharedTabResponse } from '@/lib/tabs/shared-tab-client'
import { customerStatusLabel } from '@/lib/orders/customer-status'
import { QR_REDESIGN_PENDING_COPY } from '@/lib/customer-copy/qr-redesign-copy'
import { orderIdentityLabel } from '@/lib/orders/order-identity'
import { Button } from '@/components/ui/button'
import { ArrowLeft } from 'lucide-react'
import { useToast } from '@/hooks/use-toast'
import { fetchWithSession } from '@/lib/fetch-with-session'
import { GUEST_ORDER_POLL_MS } from '@/lib/guest-orders/client'
import { TAB_FIGURES_COPY } from '@/lib/tabs/tab-outstanding'
import { handleSessionExpired } from '@/lib/handle-session-expired'
import { cn } from '@/lib/utils'
import { customerSafeError } from '@/lib/customer-copy/customer-safe-error'
import {
  PAYMENT_METHOD_WITHDRAWN_TITLE,
  paymentMethodWithdrawnCopy,
} from '@/lib/customer-copy/payment-method-withdrawn'

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
  const { sessionId, tabMembers, selfMemberKeys, tabStatus, refreshTab } = useTab()
  const { currency, permissions, refresh } = useRestaurant()
  const [tabRecord, setTabRecord] = useState<TabRow | null>(null)
  const [orders, setOrders] = useState<TabOrder[]>([])
  /**
   * THE SHARED TAB — every diner's orders, from the server (spec sections 24-26).
   *
   * `undefined` = not read yet · `null` = the read FAILED · a value = the table's orders.
   *
   * Those three are deliberately distinct and there is deliberately NO FALLBACK to `orders`
   * below, which is session-scoped. Falling back would put one diner's food under a heading that
   * says "the whole table", which is the defect this piece exists to fix, and it would do it
   * exactly when the shared read was broken -- silently.
   */
  const [sharedTab, setSharedTab] = useState<SharedTabResponse | null | undefined>(undefined)
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

  const tableNumVal = Number(tableNumber) || 0
  const canLoadTab = Boolean(restaurantId) && tableNumVal > 0
  const missingTabSession = canLoadTab && !storedTabId
  const showTabLoading = canLoadTab && loading && !redirecting && !missingTabSession

  useEffect(() => {
    if (!canLoadTab || storedTabId) return
    handleSessionExpired(restaurantId)
  }, [canLoadTab, storedTabId, restaurantId])

  useEffect(() => {
    if (!canLoadTab) return
    if (!storedTabId) return

    let cancelled = false
    /**
     * `isRefresh` is the whole fix for #292.
     *
     * A FIRST load has nothing on screen and the spinner is right. A REFRESH already has the tab,
     * the figures and the pay button rendered, and must replace them in place. One boolean served
     * both, so every poll tick set `loading` -- and `showTabLoading` returns a full-screen spinner
     * early at the bottom of this component. The result was the entire Tab screen blanking every
     * 5 seconds, losing scroll position and any in-progress tap. On a phone that reads as the page
     * reloading itself, and it makes the screen unusable.
     *
     * The sibling polling screen never had this: `my-orders/page.tsx` has no setLoading in its
     * poll. This brings /tab into line rather than inventing a new pattern.
     */
    const load = async (isRefresh = false) => {
      try {
        if (!isRefresh) setLoading(true)
        const tab = await fetchTabById(storedTabId, restaurantId)
        if (cancelled) return

        if (!tab || String(tab.status || '').toLowerCase() === 'settled') {
          setRedirecting(true)
          handleSessionExpired(restaurantId)
          return
        }

        setTabRecord(tab)
        persistTabSession(storedTabId, tableNumVal)

        /**
         * Two reads, in parallel, answering two different questions.
         *
         * `fetchSharedTab` is the TABLE'S orders, token-guarded, grouped by the server. It is
         * what the list renders.
         *
         * `fetchOrdersForTab` is THIS SESSION'S orders and is kept only because the edit
         * affordance and anything else that acts on an order must work from rows this browser
         * owns. It no longer feeds the list.
         */
        const [shared, rows] = await Promise.all([
          fetchSharedTab({
            tabId: storedTabId,
            restaurantId,
            sessionIds: [getCurrentSession() || '', readTabSessionId() || ''].filter(Boolean),
          }),
          fetchOrdersForTab(storedTabId, restaurantId, getCurrentSession()),
        ])
        if (cancelled) return
        setSharedTab(shared)
        setOrders(
          (rows || []).map((d: any) => ({ id: String(d.id), ...(d as Omit<TabOrder, 'id'>) }))
        )
        setLoading(false)
      } catch {
        if (cancelled) return
        /**
         * A BACKGROUND POLL MUST NOT EVICT THE CUSTOMER (#292, found while fixing the blanking).
         *
         * `handleSessionExpired` clears the session token, the tab id, the table and the cart and
         * then `window.location.replace`s to /session-ended. On a FIRST load that is defensible:
         * nothing is on screen and the tab could not be read at all.
         *
         * On a REFRESH it is not. The customer is looking at a working tab; a single transient
         * failure -- a tunnel, a lift, one dropped request out of a tick every 5 seconds -- would
         * have thrown away their session and their route back to their own bill. A joiner who
         * never knew the PIN could not return at all, which is exactly the cost #220 was about.
         *
         * A genuinely ended session is still caught, and above this: the `!tab || status ===
         * 'settled'` branch inside the try evicts on real state rather than on a failed fetch.
         */
        if (isRefresh) {
          console.warn('[TAB] refresh failed; keeping the tab on screen and retrying next tick')
          setLoading(false)
          return
        }
        setRedirecting(true)
        handleSessionExpired(restaurantId)
      }
    }
    /**
     * THE POLL THIS SCREEN NEVER HAD. RULED 2026-08-15.
     *
     * /tab was the only customer screen with neither a working subscription nor an interval: it
     * loaded once and never updated, and it is the screen with the money and the pay button on
     * it. Its `tabs` subscription lived in tab-context and never fired, because `public.tabs` has
     * never been in the supabase_realtime publication (QRA-17).
     *
     * Same cadence as the four screens that already poll. This refreshes both the tab record --
     * which now carries the authoritative outstanding total -- and the order list beneath it, so
     * the headline figure and the lines under it cannot drift apart.
     */
    void load()
    const interval = window.setInterval(() => void load(true), GUEST_ORDER_POLL_MS)
    return () => {
      cancelled = true
      window.clearInterval(interval)
    }
  }, [restaurantId, tableNumber, storedTabId, router, canLoadTab, tableNumVal])

  const ordersForDisplay = useMemo(
    () => orders.filter((o) => !String(o.tab_settlement_for_tab_id || '').trim()),
    [orders]
  )

  /**
   * THE SHARED TAB, AS THE SERVER GROUPED IT.
   *
   * This used to be ~70 lines of client-side grouping over `ordersForDisplay` -- a list scoped
   * to the ids THIS BROWSER holds. It grouped by member and printed member subtotals, which made
   * it look like the whole table; it was one diner's food under a heading carrying the whole
   * table's money. See lib/tabs/tab-order-groups.ts for why the grouping cannot be done on the
   * client at all: a browser cannot derive another diner's `member_key`, and a customer-facing
   * money figure may not be a client sum.
   *
   * `undefined` while loading, `null` when the read failed. Neither falls back to the
   * session-scoped list.
   */
  const memberGroups = sharedTab?.members ?? null
  const unattributed = sharedTab?.unattributed ?? null
  const sharedTabFailed = sharedTab === null && !loading

  /**
   * THE TABLE'S OUTSTANDING TOTAL, from the server. Never a client sum.
   *
   * This was `ordersForDisplay.reduce(...)` -- a sum over the orders THIS DEVICE can see, which
   * fetchOrdersForTab scopes to this session by construction. On a shared tab it was roughly half
   * the truth, rendered under the words "Full tab running total" (#119 / QRA-12), and it is why
   * the human ruled that a customer must never be shown a total derived from their own device.
   *
   * `null` means the server could not compute it. Every site below then renders an em dash and
   * the pay action is disabled -- a payment must never be confirmed against an unknown amount,
   * and a fallback zero is a number a customer would act on.
   */
  const payableTotal = useMemo(() => {
    const n = Number(tabRecord?.payable_total)
    return Number.isFinite(n) ? n : null
  }, [tabRecord?.payable_total])

  const pendingTotal = useMemo(() => {
    const n = Number(tabRecord?.pending_total)
    return Number.isFinite(n) ? n : null
  }, [tabRecord?.pending_total])

  /** DISPLAY shows both, so the headline is their sum. */
  const displayTotal =
    payableTotal == null && pendingTotal == null ? null : (payableTotal ?? 0) + (pendingTotal ?? 0)
  const money = (n: number | null) => (n == null ? '—' : `${currency}${n.toFixed(2)}`)
  const outstandingLabel = money(displayTotal)
  const hasPending = (pendingTotal ?? 0) > 0

  /**
   * DECIDES, so it uses PAYABLE only and fails closed on an unknown amount. A customer must never
   * tap a button charging one number while the screen shows another, and pending money is not
   * chargeable — the restaurant has not agreed to make it.
   */
  const canSettle = payableTotal != null && payableTotal > 0

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
          title: PAYMENT_METHOD_WITHDRAWN_TITLE,
          // #209: names the method the CLIENT sent. The old string said "Cash ... select Card"
          // in a branch that fires for card too.
          description: paymentMethodWithdrawnCopy(paymentPreference),
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
        description: customerSafeError(err, 'Please try again.'),
        variant: 'destructive',
      })
    } finally {
      setReadyToPayLoading(false)
    }
  }

  if (missingTabSession || redirecting || showTabLoading) {
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
        {/*
          THE ONLY WAY OUT OF THIS SCREEN. It had none. /menu/[id]/tab is reachable from the
          browse strip and from the header, and every sibling customer screen carries an exit
          while this one left the browser back button as the only route out -- which on a phone,
          mid-meal, is not a discoverable action.

          A FORWARD NAVIGATION, NOT router.back(). This screen is reached from more than one
          place, so "back" is ambiguous about where it lands, and history can hold a stale
          confirmation screen or an ended session. Going to the menu is always a true statement
          about where this control leads -- which is why the label names the destination rather
          than a direction.

          The "No active tab" empty state above already has its own exit and is untouched.
        */}
        <button
          type="button"
          onClick={() => router.push(`/menu/${restaurantId}/browse?table=${tableNumber}`)}
          data-testid="tab-back-to-menu"
          className="mb-4 flex items-center gap-2 text-foreground font-sans font-semibold hover:opacity-70 transition"
        >
          <ArrowLeft className="w-4 h-4 stroke-[1.5]" aria-hidden />
          {QR_REDESIGN_PENDING_COPY.tabBackToMenu}
        </button>

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
          <p className="mt-2 font-serif text-4xl font-bold text-foreground">{outstandingLabel}</p>
          {hasPending && (
            <p className="mt-2 text-xs font-sans text-amber-600">
              {TAB_FIGURES_COPY.tabPendingSuffix.replace('{pending}', money(pendingTotal))}
            </p>
          )}
        </div>

        {/* THE READ FAILED. Said out loud rather than papered over with this device's own
            orders -- see lib/tabs/shared-tab-client.ts. The money above still renders, because it
            comes from a different read that is still working. */}
        {sharedTabFailed && (
          <div
            role="status"
            className="mb-6 rounded-lg border border-amber-400/50 bg-amber-50 px-4 py-3 text-sm font-sans text-amber-900"
          >
            {QR_REDESIGN_PENDING_COPY.tabOrdersUnavailable}
          </div>
        )}

        {memberGroups && memberGroups.length === 0 && (
          <div className="mb-6 rounded-lg border border-dashed border-border px-4 py-6 text-center text-sm font-sans text-muted-foreground">
            {QR_REDESIGN_PENDING_COPY.tabEmpty}
          </div>
        )}

        <div className="space-y-4">
          {(memberGroups ?? []).map((group) => (
            <div key={group.member_key} className="rounded-lg border border-border bg-card p-4">
              <h2 className="font-sans text-base font-semibold text-foreground">
                {group.is_self ? `You — ${group.display_name}` : group.display_name}
                {group.is_self && (
                  <button
                    type="button"
                    onClick={() => {
                      const newName = prompt('Enter your name:', group.display_name)
                      if (newName?.trim()) {
                        void updateMemberName(newName.trim()).catch((err) => {
                          toast({
                            title: 'Could not update name',
                            description: customerSafeError(err, 'Please try again.'),
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
              {/* ORDER BY ORDER, not one flat list of lines.
                  Spec section 26 and Event H: a submitted order and an accepted one appear
                  together and must not read as financially the same thing. Grouping the lines
                  under their order is what makes room to say which is which. */}
              <div className="mt-2 space-y-3">
                {group.orders.map((order) => (
                  <div key={order.id}>
                    <div className="flex items-baseline justify-between gap-2 text-xs font-sans">
                      <span className="text-muted-foreground">
                        {/* Routed through the shared function 2026-08-18. This site inlined the
                            decision, so it kept saying "Not numbered yet" on a DECLINED order --
                            the third time a number-rendering branch has been wrong (#296, #308). */}
                        {orderIdentityLabel(order)}
                      </span>
                      <span
                        className={
                          order.is_pending ? 'font-semibold text-amber-600' : 'text-muted-foreground'
                        }
                      >
                        {order.is_pending
                          ? QR_REDESIGN_PENDING_COPY.tabOrderAwaitingConfirmation
                          : customerStatusLabel(order.status)}
                      </span>
                    </div>
                    <div className="mt-1 space-y-0.5 text-sm text-muted-foreground">
                      {order.lines.map((line, lineIndex) => (
                        <p key={`${order.id}-${lineIndex}`}>
                          {line.name} ×{line.quantity} — {currency}
                          {line.total.toFixed(2)}
                          {line.configuration ? (
                            <span className="block text-xs">{line.configuration}</span>
                          ) : null}
                        </p>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
              {/* BOTH FIGURES PER PERSON, both from the server. Never one number: a member
                  subtotal that silently folded unconfirmed money into "what they owe" is the
                  same lie as the table total that started this. */}
              <div className="mt-3 space-y-0.5 text-sm">
                <p className="font-semibold text-foreground">
                  {QR_REDESIGN_PENDING_COPY.tabMemberPayable} {currency}
                  {group.payable.toFixed(2)}
                </p>
                {group.pending > 0 && (
                  <p className="text-xs font-sans text-amber-600">
                    {TAB_FIGURES_COPY.tabPendingSuffix.replace(
                      '{pending}',
                      `${currency}${group.pending.toFixed(2)}`
                    )}
                  </p>
                )}
              </div>
            </div>
          ))}

          {/* NEVER INFERRED. An order on this tab whose member could not be resolved is shown as
              its own block and named as unattributed -- not folded into somebody's subtotal, and
              not dropped, which would understate what the table has ordered. A non-empty block
              here is a FINDING about the data, and the copy says so rather than inventing an
              owner. */}
          {unattributed && (
            <div className="rounded-lg border border-dashed border-amber-400/60 bg-amber-50/40 p-4">
              <h2 className="font-sans text-base font-semibold text-foreground">
                {QR_REDESIGN_PENDING_COPY.tabUnattributedHeading}
              </h2>
              <div className="mt-2 space-y-3">
                {unattributed.orders.map((order) => (
                  <div key={order.id} className="space-y-0.5 text-sm text-muted-foreground">
                    {order.lines.map((line, lineIndex) => (
                      <p key={`${order.id}-${lineIndex}`}>
                        {line.name} ×{line.quantity} — {currency}
                        {line.total.toFixed(2)}
                      </p>
                    ))}
                  </div>
                ))}
              </div>
              <p className="mt-3 text-sm font-semibold text-foreground">
                {QR_REDESIGN_PENDING_COPY.tabMemberPayable} {currency}
                {unattributed.payable.toFixed(2)}
              </p>
            </div>
          )}
        </div>

        <div className="mt-8 rounded-md border border-dashed border-border bg-muted/30 p-4 text-center text-sm text-muted-foreground">
          Tab total {outstandingLabel}
          {hasPending && (
            <span className="block mt-1 text-xs">
              {TAB_FIGURES_COPY.tabPendingSuffix.replace('{pending}', money(pendingTotal))}
            </span>
          )}
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
              disabled={!canSettle}
            >
              Settle Tab • {money(payableTotal)}
            </Button>
          )}

          {!tabReadyToPay && showPaymentSelector && (
            <div className="space-y-3">
              <p className="text-center text-sm font-semibold text-foreground font-sans">
                How would you like to pay?
              </p>
              {/* The sheet charges PAYABLE. If pending money exists the two figures differ, and
                  the customer is told why here rather than being left to notice it. */}
              {hasPending && (
                <p className="text-center text-xs font-sans text-amber-600">
                  {TAB_FIGURES_COPY.settleSheetPendingNotice.replace('{pending}', money(pendingTotal))}
                </p>
              )}
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
                disabled={!paymentPreference || readyToPayLoading || !canSettle}
              >
                {readyToPayLoading
                  ? 'Sending…'
                  : `Confirm — ${money(payableTotal)}`}
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
