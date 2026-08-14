// @ts-nocheck
'use client'

import React, { createContext, useContext, useEffect, useLayoutEffect, useMemo, useState } from 'react'
import { usePathname, useSearchParams } from 'next/navigation'
import { supabase } from '@/lib/supabase/client'
import {
  clearTabSession,
  persistTabSession,
  readStoredTabId,
  readStoredTableNumber,
  SESSION_TOKEN_STORAGE_KEY,
  ensureTabSessionId,
} from '@/lib/tab-storage'
import { isActiveTabStatus, shouldClearTabAfterSettlement } from '@/lib/tab-session'
import { fetchWithSession } from '@/lib/fetch-with-session'
import { handleSessionExpired } from '@/lib/handle-session-expired'
// The OTHER session id. lib/session.ts owns `flashtap_session_v1` in localStorage; this context
// owns `tab_session_id` in sessionStorage. Nothing syncs them and an order carries whichever the
// placing screen held, so both have to be offered when asking which member row is the caller's.
import { getCurrentSession } from '@/lib/session'

// The keys and the mint now live in lib/tab-storage.ts, which is also where non-context callers
// read them from. Two copies of "which id is this customer" is how the two halves come to disagree
// about who placed an order — see TAB_SESSION_ID_MIRROR_KEY there for the bug that was.

/**
 * #262: `session_id` is GONE and must not come back.
 *
 * The stored `tabs.members` array holds each diner's real session id, which is a credential --
 * lib/guest-orders/queries.ts fetchGuestOrdersBySession reads a diner's orders by it. The
 * server (GET /api/tabs/[tabId]/view) substitutes an opaque per-tab `member_key` derived from
 * the service-role secret, and stamps the same key onto `orders.member_session_id` on its way
 * out, so the pairing these screens do still resolves against a value that is useless anywhere
 * else and meaningless on any other tab.
 */
export type TabMember = {
  member_key: string
  joined_at: string | { toMillis?: () => number }
  display_name?: string
}

type TabContextType = {
  tabId: string | null
  tabStatus: string | null
  sessionId: string
  isInTab: boolean
  canAddToTab: boolean
  tabTotal: number
  tabMembers: TabMember[]
  /** The caller's own member_key(s); the client cannot derive them. See TabMember. */
  selfMemberKeys: string[]
  settlementType: string | null
  tableNumber: string | null
  setTabFromJoin: (nextTabId: string, tableNumber?: string | number) => void
  clearTab: () => void
  createNewTab: (params: {
    restaurantId: string
    tableNumber: string
    tableId?: string
    displayName?: string
    customerName?: string
  }) => Promise<{ tabId: string; tabPin?: string }>
  joinExistingTab: (params: {
    restaurantId: string
    tabId: string
    tableNumber?: string | number
    displayName?: string
    /** #265. A staff-issued PIN-recovery token. When present and valid, the server mints a
     * NEW tab_pin and returns it — the return value's `tabPin` field. */
    resetToken?: string
  }) => Promise<{ tabPin?: string }>
  joinTabWithPin: (params: {
    restaurantId: string
    tableNumber: string | number
    pin: string
    displayName?: string
  }) => Promise<string>
  markTabReadyToPay: () => Promise<void>
  refreshTab: () => Promise<void>
}

const TabContext = createContext<TabContextType | undefined>(undefined)

function getRestaurantIdFromPath(pathname: string) {
  const match = pathname.match(/^\/menu\/([^/]+)/)
  return match?.[1] || null
}

export function TabProvider({
  children,
  restaurantId: restaurantIdProp,
}: {
  children: React.ReactNode
  restaurantId?: string
}) {
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const [tabId, setTabId] = useState<string | null>(() => {
    if (typeof window === 'undefined') return null
    const params = new URLSearchParams(window.location.search)
    const fromUrl = params.get('tabId')?.trim()
    if (fromUrl) return fromUrl
    return readStoredTabId()
  })
  const [sessionId, setSessionId] = useState(() => ensureTabSessionId())
  const [tabTotal, setTabTotal] = useState(0)
  const [tabMembers, setTabMembers] = useState<TabMember[]>([])
  /**
   * The caller's own `member_key`s, as derived by the server for each session id this context
   * holds (#262). The client cannot derive them -- that is the whole point -- so "which of these
   * members is me?" has to be answered server-side. Plural because the app mints two unsynced
   * session ids; see loadTab.
   */
  const [selfMemberKeys, setSelfMemberKeys] = useState<string[]>([])
  const [tabStatus, setTabStatus] = useState<string | null>(null)
  const [settlementType, setSettlementType] = useState<string | null>(null)

  const restaurantIdFromPath = useMemo(() => getRestaurantIdFromPath(pathname || ''), [pathname])
  const restaurantId = restaurantIdProp || restaurantIdFromPath
  const tableNumber = searchParams?.get('table') || readStoredTableNumber() || null
  const tabIdFromUrl = searchParams?.get('tabId')?.trim() || null

  // URL tabId wins when present; persist to storage.
  /* eslint-disable react-hooks/set-state-in-effect -- hydrate tab id from URL on navigation */
  useLayoutEffect(() => {
    if (typeof window === 'undefined') return
    if (tabIdFromUrl) {
      const tableFromUrl = searchParams?.get('table')
      persistTabSession(tabIdFromUrl, tableFromUrl || readStoredTableNumber() || '')
      setTabId(tabIdFromUrl)
    }
  }, [tabIdFromUrl, searchParams])
  /* eslint-enable react-hooks/set-state-in-effect */

  /**
   * #262: this was an anon PostgREST select naming `members`, i.e. every diner's raw
   * `session_id`, under a policy with no restaurant scope. It now reads through
   * GET /api/tabs/[tabId]/view, which runs the identical lookup as service_role and returns an
   * opaque per-tab `member_key` per member instead. Same filters (id + restaurant_id, matched
   * raw), same "no row -> clear the session" behaviour.
   *
   * Both of this context's session ids go along so the route can say which member row is the
   * caller's: `sessionId` is the sessionStorage `tab_session_id` and getCurrentSession() is the
   * localStorage `flashtap_session_v1`. Nothing syncs the two and an order carries whichever
   * one the placing screen held (see lib/guest-orders/queries.ts), so sending only one leaves
   * `isCurrentUser` wrong on the tab screen.
   */
  const loadTab = async () => {
    if (!restaurantId || !tabId) return

    const qs = new URLSearchParams({ restaurantId })
    for (const sid of new Set(
      [sessionId, getCurrentSession()].map((s) => String(s || '').trim()).filter(Boolean),
    )) {
      qs.append('sessionId', sid)
    }

    let data: Record<string, unknown> | null = null
    try {
      const res = await fetch(`/api/tabs/${encodeURIComponent(tabId)}/view?${qs.toString()}`, {
        cache: 'no-store',
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) {
        console.error('[TAB CONTEXT] load tab error', body?.error || res.status)
        return
      }
      data = body?.tab || null
      setSelfMemberKeys(Array.isArray(body?.self_member_keys) ? body.self_member_keys : [])
    } catch (error) {
      console.error('[TAB CONTEXT] load tab error', error)
      return
    }

    if (!data) {
      setTabId(null)
      setTabTotal(0)
      setTabMembers([])
      setSelfMemberKeys([])
      setTabStatus(null)
      setSettlementType(null)
      clearTabSession()
      return
    }

      const status = data.status ? String(data.status) : null
      setTabStatus(status)

      if (
        shouldClearTabAfterSettlement(data as { status?: string; settled_type?: string | null })
      ) {
        console.log('[TAB CONTEXT] tab no longer active; clearing session', {
          tabId,
          status,
          settled_type: data.settled_type,
        })
        setTabId(null)
        setTabTotal(0)
        setTabMembers([])
        setSelfMemberKeys([])
        setTabStatus(null)
        setSettlementType(null)
        clearTabSession()
        return
      }

      if (status === 'closed') {
        setTabTotal(0)
        setTabMembers([])
        setSettlementType(data.settlement_type ? String(data.settlement_type) : null)
        return
      }
    setTabTotal(Number(data.total) || 0)
    setSettlementType(data.settlement_type ? String(data.settlement_type) : null)
    setTabMembers(Array.isArray(data.members) ? (data.members as TabMember[]) : [])
  }

  const isMenuRoute = Boolean(pathname?.startsWith('/menu/'))
  const [pathnameKey, setPathnameKey] = useState(pathname || '')
  if ((pathname || '') !== pathnameKey) {
    setPathnameKey(pathname || '')
    if (!isMenuRoute) {
      setTabTotal(0)
      setTabMembers([])
      setTabStatus(null)
      setSettlementType(null)
    }
  }

  const contextTabTotal = isMenuRoute ? tabTotal : 0
  const contextTabMembers = isMenuRoute ? tabMembers : []
  const contextSelfMemberKeys = isMenuRoute ? selfMemberKeys : []
  const contextTabStatus = isMenuRoute ? tabStatus : null
  const contextSettlementType = isMenuRoute ? settlementType : null

  const canAddToTab =
    Boolean(tabId) && isActiveTabStatus(contextTabStatus) && contextTabStatus === 'open'

  useEffect(() => {
    if (!restaurantId || !tabId) return
    if (tabId && tabStatus) return // already initialised, skip

    let active = true
    const run = async () => {
      await loadTab()
      if (!active) return
    }
    void run()

    const channel = supabase
      .channel(`tab-${restaurantId}-${tabId}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'tabs', filter: `id=eq.${tabId}` },
        () => {
          void loadTab()
        }
      )
      .subscribe()

    return () => {
      active = false
      supabase.removeChannel(channel)
    }
    // tabStatus guard prevents double-init; loadTab is recreated each render and would churn subscriptions.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- subscribe once per restaurantId/tabId pair
  }, [restaurantId, tabId])

  const persistTabId = (nextTabId: string | null, tableNum?: string | number | null) => {
    setTabId(nextTabId)
    if (!nextTabId) {
      setTabTotal(0)
      setTabMembers([])
      setSelfMemberKeys([])
      setTabStatus(null)
      setSettlementType(null)
      clearTabSession()
      return
    }
    const resolvedTable =
      tableNum != null && String(tableNum).trim() !== ''
        ? String(tableNum)
        : tableNumber || readStoredTableNumber() || ''
    if (resolvedTable) {
      persistTabSession(nextTabId, resolvedTable)
    } else {
      if (typeof window !== 'undefined') {
        localStorage.setItem('flashtap_tab_id', nextTabId)
      }
    }
  }

  const joinTabWithPin = async ({
    restaurantId: rid,
    tableNumber: tableNum,
    pin,
    displayName,
  }: {
    restaurantId: string
    tableNumber: string | number
    pin: string
    displayName?: string
  }) => {
    const sid = sessionId || ensureTabSessionId()
    const storedDisplayName =
      typeof window !== 'undefined' ? sessionStorage.getItem('flashtap_display_name') || '' : ''
    const resolvedDisplayName = displayName?.trim() || storedDisplayName.trim() || 'Guest'

    const response = await fetch('/api/tabs/join', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        restaurantId: rid,
        tableNumber: Number(tableNum) || tableNum,
        pin: pin.trim(),
        sessionId: sid,
        displayName: resolvedDisplayName,
      }),
    })

    const data = await response.json().catch(() => ({}))

    if (response.status === 403) {
      throw new Error('Incorrect PIN, please try again')
    }
    if (response.status === 404) {
      throw new Error('No open tab found for this table')
    }
    if (response.status === 410) {
      handleSessionExpired(rid)
      throw new Error('Your dining session has ended')
    }
    if (!response.ok) {
      throw new Error(data?.error || `Failed to join tab (${response.status})`)
    }

    if (data?.sessionToken) {
      sessionStorage.setItem(SESSION_TOKEN_STORAGE_KEY, data.sessionToken)
      localStorage.setItem(SESSION_TOKEN_STORAGE_KEY, data.sessionToken)
    }

    const joinedTabId = String(data?.tabId || '').trim()
    if (!joinedTabId) {
      throw new Error('Tab was joined but no tab ID was returned')
    }

    persistTabId(joinedTabId, tableNum)
    return joinedTabId
  }

  const joinExistingTab = async ({
    restaurantId: rid,
    tabId: targetTabId,
    tableNumber: tableNum,
    displayName,
    resetToken,
  }: {
    restaurantId: string
    tabId: string
    tableNumber?: string | number
    displayName?: string
    resetToken?: string
  }) => {
    console.log('[TAB CONTEXT] joinExistingTab', { rid, targetTabId, tableNum, hasResetToken: Boolean(resetToken) })
    const sid = sessionId || ensureTabSessionId()
    const storedDisplayName =
      typeof window !== 'undefined' ? sessionStorage.getItem('flashtap_display_name') || '' : ''
    const resolvedDisplayName = displayName?.trim() || storedDisplayName.trim() || 'Guest'

    const response = await fetch(`/api/tabs/${encodeURIComponent(targetTabId)}/join`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        restaurantId: rid,
        sessionId: sid,
        tableNumber: tableNum,
        displayName: resolvedDisplayName,
        ...(resetToken ? { resetToken } : {}),
      }),
    })

    const data = await response.json().catch(() => ({}))
    console.log('[TAB CONTEXT] joinExistingTab response', { ok: response.ok, status: response.status, data })
    console.log('[TAB CONTEXT] joinExistingTab sessionToken', data?.sessionToken)
    if (response.status === 410) {
      handleSessionExpired(rid)
      throw new Error('Your dining session has ended')
    }
    if (!response.ok) {
      throw new Error(data?.error || `Failed to join tab (${response.status})`)
    }

    if (data?.sessionToken) {
      sessionStorage.setItem(SESSION_TOKEN_STORAGE_KEY, data.sessionToken)
      localStorage.setItem(SESSION_TOKEN_STORAGE_KEY, data.sessionToken)
    }

    // #265. Present only when this request redeemed a PIN-reset token. Stored under the same
    // key tab creation uses, so every downstream reader (browse:195, tab:74) needs no changes.
    if (data?.tabPin && typeof window !== 'undefined') {
      sessionStorage.setItem('flashtap_creator_tab_pin', String(data.tabPin))
    }

    persistTabId(targetTabId, tableNum ?? data?.tableNumber)

    return { tabPin: data?.tabPin ? String(data.tabPin) : undefined }
  }

  const createNewTab = async ({
    restaurantId: rid,
    tableNumber: tableNum,
    displayName: displayNameParam,
    customerName,
  }: {
    restaurantId: string
    tableNumber: string
    tableId?: string
    displayName?: string
    customerName?: string
  }) => {
    const sid = sessionId || ensureTabSessionId()
    const storedDisplayName =
      typeof window !== 'undefined' ? sessionStorage.getItem('flashtap_display_name') || '' : ''
    const displayName = displayNameParam?.trim() || storedDisplayName.trim() || 'Guest'
    console.log('[TAB CONTEXT] createNewTab start', { rid, tableNum, sessionId: sid })

    const response = await fetch('/api/tabs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        restaurantId: rid,
        tableNumber: Number(tableNum) || tableNum,
        sessionId: sid,
        displayName,
        customer_name: customerName || null,
        /**
         * #211 follow-up: the tab this browser already held when it started a NEW one, which
         * after #211's landing fix is a legitimate thing to do — scan another table and start
         * fresh while an unpaid tab is still open elsewhere.
         *
         * Recorded AT CREATION because this is the only moment both ids are known in one place.
         * The server validates it (same restaurant, still unpaid, different table) and stores
         * null otherwise, so this is a hint, not an assertion. If the browser has no stored tab
         * — cleared storage, a fresh device — there is nothing to send and no link is made. That
         * is the accepted limit of the feature, not a bug in it.
         */
        linkedUnpaidTabId: readStoredTabId() || null,
      }),
    })

    const data = await response.json().catch(() => ({}))
    console.log('[TAB CONTEXT] createNewTab response', { ok: response.ok, status: response.status, data })

    if (response.status === 410) {
      handleSessionExpired(rid)
      throw new Error('Your dining session has ended')
    }

    if (!response.ok) {
      throw new Error(data?.error || `Failed to create tab (${response.status})`)
    }

    if (data?.sessionToken) {
      sessionStorage.setItem(SESSION_TOKEN_STORAGE_KEY, data.sessionToken)
      localStorage.setItem(SESSION_TOKEN_STORAGE_KEY, data.sessionToken)
    }

    const newTabId = String(data?.tabId || '').trim()
    if (!newTabId) {
      throw new Error('Tab was created but no tab ID was returned')
    }

    console.log('[TAB CONTEXT] createNewTab success', newTabId)
    persistTabId(newTabId, tableNum)
    return {
      tabId: newTabId,
      tabPin: data?.tabPin ? String(data.tabPin) : undefined,
    }
  }

  const markTabReadyToPay = async () => {
    if (!tabId || !restaurantId) throw new Error('No active tab')
    if (tabStatus === 'ready_to_pay') {
      return
    }
    const res = await fetchWithSession(
      `/api/tabs/${encodeURIComponent(tabId)}/ready-to-pay`,
      restaurantId,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ restaurantId }),
      }
    )
    const data = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(data?.error || 'Failed to notify waiter')
    setTabStatus('ready_to_pay')
    await loadTab()
  }

  const clearTab = () => persistTabId(null)
  const setTabFromJoin = (nextTabId: string, tableNum?: string | number) =>
    persistTabId(nextTabId, tableNum)

  const value: TabContextType = {
    tabId,
    tabStatus: contextTabStatus,
    sessionId,
    isInTab: Boolean(tabId),
    canAddToTab,
    tabTotal: contextTabTotal,
    tabMembers: contextTabMembers,
    selfMemberKeys: contextSelfMemberKeys,
    settlementType: contextSettlementType,
    tableNumber,
    setTabFromJoin,
    clearTab,
    createNewTab,
    joinExistingTab,
    joinTabWithPin,
    markTabReadyToPay,
    refreshTab: loadTab,
  }

  return <TabContext.Provider value={value}>{children}</TabContext.Provider>
}

export function useTab() {
  const context = useContext(TabContext)
  if (!context) throw new Error('useTab must be used within a TabProvider')
  return context
}
