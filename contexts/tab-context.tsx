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
} from '@/lib/tab-storage'
import { isActiveTabStatus, shouldClearTabAfterSettlement } from '@/lib/tab-session'
import { fetchWithSession } from '@/lib/fetch-with-session'
import { handleSessionExpired } from '@/lib/handle-session-expired'

const TAB_SESSION_KEY = 'tab_session_id'
const LEGACY_TAB_SESSION_KEY = 'flashtap_tab_session_id'

export type TabMember = {
  session_id: string
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
  settlementType: string | null
  tableNumber: string | null
  setTabFromJoin: (nextTabId: string, tableNumber?: string | number) => void
  clearTab: () => void
  createNewTab: (params: {
    restaurantId: string
    tableNumber: string
    tableId?: string
    displayName?: string
  }) => Promise<{ tabId: string; tabPin?: string }>
  joinExistingTab: (params: {
    restaurantId: string
    tabId: string
    tableNumber?: string | number
    displayName?: string
  }) => Promise<void>
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

function ensureTabSessionId() {
  if (typeof window === 'undefined') return ''
  const existing = sessionStorage.getItem(TAB_SESSION_KEY)?.trim()
  if (existing) return existing
  const legacy = sessionStorage.getItem(LEGACY_TAB_SESSION_KEY)?.trim()
  if (legacy) {
    sessionStorage.setItem(TAB_SESSION_KEY, legacy)
    sessionStorage.removeItem(LEGACY_TAB_SESSION_KEY)
    return legacy
  }
  const generated = `session_${Date.now()}_${Math.random().toString(36).slice(2)}`
  sessionStorage.setItem(TAB_SESSION_KEY, generated)
  return generated
}

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
  const [tabId, setTabId] = useState<string | null>(null)
  const [sessionId, setSessionId] = useState<string>('')
  const [tabTotal, setTabTotal] = useState(0)
  const [tabMembers, setTabMembers] = useState<TabMember[]>([])
  const [tabStatus, setTabStatus] = useState<string | null>(null)
  const [settlementType, setSettlementType] = useState<string | null>(null)

  const restaurantIdFromPath = useMemo(() => getRestaurantIdFromPath(pathname || ''), [pathname])
  const restaurantId = restaurantIdProp || restaurantIdFromPath
  const tableNumber = searchParams?.get('table') || readStoredTableNumber() || null
  const tabIdFromUrl = searchParams?.get('tabId')?.trim() || null

  const canAddToTab = Boolean(tabId) && isActiveTabStatus(tabStatus) && tabStatus === 'open'

  useLayoutEffect(() => {
    setSessionId(ensureTabSessionId())
  }, [])

  // URL tabId wins; otherwise restore from localStorage.
  useLayoutEffect(() => {
    if (typeof window === 'undefined') return
    if (tabIdFromUrl) {
      const tableFromUrl = searchParams?.get('table')
      persistTabSession(tabIdFromUrl, tableFromUrl || readStoredTableNumber() || '')
      setTabId(tabIdFromUrl)
      return
    }
    const storedTabId = readStoredTabId()
    if (storedTabId) setTabId(storedTabId)
  }, [tabIdFromUrl, searchParams])

  const loadTab = async () => {
    if (!restaurantId || !tabId) return
    const { data, error } = await supabase
      .from('tabs')
      .select('*')
      .eq('id', tabId)
      .eq('restaurant_id', restaurantId)
      .maybeSingle()

    if (error) {
      console.error('[TAB CONTEXT] load tab error', error)
      return
    }

    if (!data) {
      setTabId(null)
      setTabTotal(0)
      setTabMembers([])
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

  useEffect(() => {
    if (!pathname?.startsWith('/menu/')) {
      setTabTotal(0)
      setTabMembers([])
      setTabStatus(null)
      setSettlementType(null)
    }
  }, [pathname])

  useEffect(() => {
    if (!restaurantId || !tabId) return
    if (tabId && tabStatus) return // already initialised, skip

    let active = true
    const run = async () => {
      console.time('useTab:init')
      await loadTab()
      console.timeEnd('useTab:init')
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
  }, [restaurantId, tabId])

  const persistTabId = (nextTabId: string | null, tableNum?: string | number | null) => {
    setTabId(nextTabId)
    if (!nextTabId) {
      setTabTotal(0)
      setTabMembers([])
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
  }: {
    restaurantId: string
    tabId: string
    tableNumber?: string | number
    displayName?: string
  }) => {
    console.log('[TAB CONTEXT] joinExistingTab', { rid, targetTabId, tableNum })
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

    persistTabId(targetTabId, tableNum ?? data?.tableNumber)
  }

  const createNewTab = async ({
    restaurantId: rid,
    tableNumber: tableNum,
    displayName: displayNameParam,
  }: {
    restaurantId: string
    tableNumber: string
    tableId?: string
    displayName?: string
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
    tabStatus,
    sessionId,
    isInTab: Boolean(tabId),
    canAddToTab,
    tabTotal,
    tabMembers,
    settlementType,
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
