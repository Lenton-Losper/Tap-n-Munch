'use client'

import React, { createContext, useContext, useEffect, useMemo, useState } from 'react'
import { usePathname, useSearchParams } from 'next/navigation'
import {
  addDoc,
  arrayUnion,
  collection,
  doc,
  getDocs,
  onSnapshot,
  query,
  serverTimestamp,
  updateDoc,
  where,
} from 'firebase/firestore'
import { db } from '@/lib/firebase/config'
import { tabPath, tabsPath } from '@/lib/firebase/paths'

const TAB_ID_KEY = 'flashtap_tab_id'
const TAB_SESSION_KEY = 'flashtap_tab_session_id'

export type TabMember = {
  session_id: string
  joined_at: string
  display_name?: string
}

type TabContextType = {
  tabId: string | null
  sessionId: string
  isInTab: boolean
  tabTotal: number
  tabMembers: TabMember[]
  settlementType: string | null
  tableNumber: string | null
  setTabFromJoin: (nextTabId: string) => void
  clearTab: () => void
  createOrJoinOpenTab: (params: {
    restaurantId: string
    tableNumber: string
    tableId: string
    displayName?: string
  }) => Promise<string>
  joinExistingTab: (params: { restaurantId: string; tabId: string; displayName?: string }) => Promise<void>
}

const TabContext = createContext<TabContextType | undefined>(undefined)

function ensureTabSessionId() {
  if (typeof window === 'undefined') return ''
  const existing = sessionStorage.getItem(TAB_SESSION_KEY)
  if (existing) return existing
  const generated = `session_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`
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
  const [settlementType, setSettlementType] = useState<string | null>(null)

  const restaurantId = useMemo(() => getRestaurantIdFromPath(pathname || ''), [pathname])
  const tableNumber = searchParams?.get('table') || null

  useEffect(() => {
    setSessionId(ensureTabSessionId())
    if (typeof window === 'undefined') return
    const storedTabId = sessionStorage.getItem(TAB_ID_KEY)
    if (storedTabId) setTabId(storedTabId)
  }, [])

  useEffect(() => {
    if (!pathname?.startsWith('/menu/')) {
      setTabTotal(0)
      setTabMembers([])
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
          setSettlementType(null)
          if (typeof window !== 'undefined') {
            sessionStorage.removeItem(TAB_ID_KEY)
          }
          return
        }
        const data = snap.data() as Record<string, any>
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
    const sid = sessionId || ensureTabSessionId()
    const member = {
      session_id: sid,
      joined_at: new Date().toISOString(),
      ...(displayName ? { display_name: displayName } : {}),
    }
    await updateDoc(doc(db, tabPath(rid, targetTabId)), {
      members: arrayUnion(member),
      updated_at: serverTimestamp(),
    })
    persistTabId(targetTabId)
  }

  const createOrJoinOpenTab = async ({
    restaurantId: rid,
    tableNumber: tableNum,
    tableId,
    displayName,
  }: {
    restaurantId: string
    tableNumber: string
    tableId: string
    displayName?: string
  }) => {
    if (!db) throw new Error('Firestore is not initialized')
    const tabsRef = collection(db, tabsPath(rid))
    const openTabsQuery = query(
      tabsRef,
      where('status', '==', 'open'),
      where('table_number', '==', String(tableNum))
    )
    const openTabsSnap = await getDocs(openTabsQuery)
    if (!openTabsSnap.empty) {
      const existingTabId = openTabsSnap.docs[0].id
      await joinExistingTab({ restaurantId: rid, tabId: existingTabId, displayName })
      return existingTabId
    }

    const sid = sessionId || ensureTabSessionId()
    const member = {
      session_id: sid,
      joined_at: new Date().toISOString(),
      ...(displayName ? { display_name: displayName } : {}),
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
    sessionId,
    isInTab: Boolean(tabId),
    tabTotal,
    tabMembers,
    settlementType,
    tableNumber,
    setTabFromJoin,
    clearTab,
    createOrJoinOpenTab,
    joinExistingTab,
  }

  return <TabContext.Provider value={value}>{children}</TabContext.Provider>
}

export function useTab() {
  const context = useContext(TabContext)
  if (!context) throw new Error('useTab must be used within a TabProvider')
  return context
}

