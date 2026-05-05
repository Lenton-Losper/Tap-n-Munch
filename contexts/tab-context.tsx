'use client'

import React, { createContext, useContext, useEffect, useLayoutEffect, useMemo, useState } from 'react'
import { usePathname, useSearchParams } from 'next/navigation'
import {
  addDoc,
  arrayUnion,
  collection,
  doc,
  getDoc,
  onSnapshot,
  serverTimestamp,
  updateDoc,
} from 'firebase/firestore'
import { db } from '@/lib/firebase/config'
import { tabPath, tabsPath } from '@/lib/firebase/paths'

const TAB_ID_KEY = 'flashtap_tab_id'
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
  tabTotal: number
  tabMembers: TabMember[]
  settlementType: string | null
  tableNumber: string | null
  setTabFromJoin: (nextTabId: string) => void
  clearTab: () => void
  createNewTab: (params: {
    restaurantId: string
    tableNumber: string
    tableId: string
  }) => Promise<string>
  joinExistingTab: (params: { restaurantId: string; tabId: string; displayName?: string }) => Promise<void>
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

export function TabProvider({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const [tabId, setTabId] = useState<string | null>(null)
  const [sessionId, setSessionId] = useState<string>('')
  const [tabTotal, setTabTotal] = useState(0)
  const [tabMembers, setTabMembers] = useState<TabMember[]>([])
  const [tabStatus, setTabStatus] = useState<string | null>(null)
  const [settlementType, setSettlementType] = useState<string | null>(null)

  const restaurantId = useMemo(() => getRestaurantIdFromPath(pathname || ''), [pathname])
  const tableNumber = searchParams?.get('table') || null
  const tabIdFromUrl = searchParams?.get('tabId')?.trim() || null

  useLayoutEffect(() => {
    setSessionId(ensureTabSessionId())
  }, [])

  // URL tabId wins when present; otherwise restore from sessionStorage.
  useLayoutEffect(() => {
    if (typeof window === 'undefined') return
    if (tabIdFromUrl) {
      sessionStorage.setItem(TAB_ID_KEY, tabIdFromUrl)
      setTabId(tabIdFromUrl)
      return
    }
    const storedTabId = sessionStorage.getItem(TAB_ID_KEY)?.trim() || null
    if (storedTabId) setTabId(storedTabId)
  }, [tabIdFromUrl])

  useEffect(() => {
    if (!pathname?.startsWith('/menu/')) {
      setTabTotal(0)
      setTabMembers([])
      setTabStatus(null)
      setSettlementType(null)
      return
    }
    if (!restaurantId || !tabId || !db) return

    const ref = doc(db, tabPath(restaurantId, tabId))
    const unsubscribe = onSnapshot(
      ref,
      (snap) => {
        if (!snap.exists()) {
          setTabId(null)
          setTabTotal(0)
          setTabMembers([])
          setTabStatus(null)
          setSettlementType(null)
          if (typeof window !== 'undefined') {
            sessionStorage.removeItem(TAB_ID_KEY)
          }
          return
        }
        const data = snap.data() as Record<string, any>
        const status = data.status ? String(data.status) : null
        setTabStatus(status)
        if (status === 'closed') {
          setTabTotal(0)
          setTabMembers([])
          setSettlementType(data.settlement_type ? String(data.settlement_type) : null)
          return
        }
        setTabTotal(Number(data.total) || 0)
        setSettlementType(data.settlement_type ? String(data.settlement_type) : null)
        setTabMembers(Array.isArray(data.members) ? (data.members as TabMember[]) : [])
      },
      () => {}
    )

    return () => unsubscribe()
  }, [restaurantId, tabId, pathname])

  const persistTabId = (nextTabId: string | null) => {
    setTabId(nextTabId)
    if (!nextTabId) {
      setTabTotal(0)
      setTabMembers([])
      setTabStatus(null)
      setSettlementType(null)
    }
    if (typeof window === 'undefined') return
    if (nextTabId) sessionStorage.setItem(TAB_ID_KEY, nextTabId)
    else sessionStorage.removeItem(TAB_ID_KEY)
  }

  const joinExistingTab = async ({
    restaurantId: rid,
    tabId: targetTabId,
    displayName,
  }: {
    restaurantId: string
    tabId: string
    displayName?: string
  }) => {
    if (!db) throw new Error('Firestore is not initialized')
    const tabRef = doc(db, tabPath(rid, targetTabId))
    const tabSnap = await getDoc(tabRef)
    if (!tabSnap.exists()) throw new Error('Tab not found')

    const sid = sessionId || ensureTabSessionId()
    const data = tabSnap.data() as Record<string, any>
    const members = Array.isArray(data.members) ? (data.members as TabMember[]) : []
    if (members.some((m) => String(m.session_id) === sid)) {
      persistTabId(targetTabId)
      return
    }

    const nextN = members.length + 1
    const member = {
      session_id: sid,
      joined_at: new Date(),
      display_name: displayName || `Person ${nextN}`,
    }
    await updateDoc(tabRef, {
      members: arrayUnion(member),
      updated_at: serverTimestamp(),
    })
    persistTabId(targetTabId)
  }

  const createNewTab = async ({
    restaurantId: rid,
    tableNumber: tableNum,
    tableId,
  }: {
    restaurantId: string
    tableNumber: string
    tableId: string
  }) => {
    if (!db) throw new Error('Firestore is not initialized')
    const tabsRef = collection(db, tabsPath(rid))
    const sid = sessionId || ensureTabSessionId()
    const member = {
      session_id: sid,
      joined_at: new Date(),
      display_name: 'Person 1',
    }
    const newTab = await addDoc(tabsRef, {
      table_number: String(tableNum),
      table_id: tableId,
      status: 'open',
      created_by: sid,
      members: [member],
      created_at: serverTimestamp(),
      settled_at: null,
      settlement_type: null,
      total: 0,
      updated_at: serverTimestamp(),
    })
    persistTabId(newTab.id)
    return newTab.id
  }

  const clearTab = () => persistTabId(null)
  const setTabFromJoin = (nextTabId: string) => persistTabId(nextTabId)

  const value: TabContextType = {
    tabId,
    tabStatus,
    sessionId,
    isInTab: Boolean(tabId),
    tabTotal,
    tabMembers,
    settlementType,
    tableNumber,
    setTabFromJoin,
    clearTab,
    createNewTab,
    joinExistingTab,
  }

  return <TabContext.Provider value={value}>{children}</TabContext.Provider>
}

export function useTab() {
  const context = useContext(TabContext)
  if (!context) throw new Error('useTab must be used within a TabProvider')
  return context
}
