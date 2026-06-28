'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { supabase } from '@/lib/supabase/client'
import { fetchActiveTabForTable } from '@/lib/tab-session'
import {
  clearCustomerSessionState,
  isTabSessionTokenEndedStatus,
  readSessionTokenFromSearchParams,
  setSessionTokenExpiredNotice,
  tableLandingPath,
} from '@/lib/session-token-client'

type Options = {
  restaurantId: string
  tableNumber: number
  tableId?: string | null
  enabled?: boolean
  onInvalid?: () => void
}

export function useSessionTokenGuard({
  restaurantId,
  tableNumber,
  tableId,
  enabled = true,
  onInvalid,
}: Options) {
  const router = useRouter()
  const searchParams = useSearchParams()
  const [validating, setValidating] = useState(true)
  const urlToken = readSessionTokenFromSearchParams(searchParams)
  const trackedTokenRef = useRef(urlToken)
  const invalidatedRef = useRef(false)

  const invalidate = useCallback(() => {
    if (invalidatedRef.current || !restaurantId) return
    invalidatedRef.current = true
    clearCustomerSessionState()
    setSessionTokenExpiredNotice()
    onInvalid?.()
    if (tableNumber > 0) {
      router.replace(tableLandingPath(restaurantId, tableNumber))
    } else {
      router.replace(`/menu/${restaurantId}/v2`)
    }
  }, [restaurantId, tableNumber, onInvalid, router])

  const evaluateTabRow = useCallback(
    (row: Record<string, unknown> | null | undefined, token: string) => {
      if (!row) return true

      const status = String(row.status || '')
      if (isTabSessionTokenEndedStatus(status)) {
        invalidate()
        return false
      }

      const dbToken = String(row.session_token || '').trim()
      if (!dbToken || dbToken !== token) {
        invalidate()
        return false
      }

      return true
    },
    [invalidate]
  )

  useEffect(() => {
    invalidatedRef.current = false
    trackedTokenRef.current = urlToken

    if (!enabled || !restaurantId || tableNumber <= 0) {
      setValidating(false)
      return
    }

    if (!urlToken) {
      invalidate()
      return
    }

    let cancelled = false

    const validate = async () => {
      try {
        const activeTab = await fetchActiveTabForTable(restaurantId, tableId ?? null, tableNumber)
        if (cancelled || invalidatedRef.current) return

        if (activeTab) {
          if (!evaluateTabRow(activeTab as Record<string, unknown>, urlToken)) {
            return
          }
        }

        trackedTokenRef.current = urlToken
        setValidating(false)
      } catch (error) {
        console.error('[SESSION TOKEN] validation failed', error)
        if (!cancelled && !invalidatedRef.current) {
          invalidate()
        }
      }
    }

    void validate()

    const channel = supabase
      .channel(`session-token-guard-${restaurantId}-${tableNumber}-${tableId || 'no-table'}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'tabs', filter: `restaurant_id=eq.${restaurantId}` },
        (payload: any) => {
          if (cancelled || invalidatedRef.current) return
          const row = (payload.new || payload.old) as Record<string, unknown> | null
          if (!row) return
          if (Number(row.table_number || 0) !== tableNumber) return
          if (tableId && String(row.table_id || '') !== String(tableId)) {
            // Still allow table_number match when table_id differs
          }
          evaluateTabRow(row, trackedTokenRef.current)
        }
      )
      .subscribe()

    return () => {
      cancelled = true
      supabase.removeChannel(channel)
    }
  }, [
    enabled,
    restaurantId,
    tableNumber,
    tableId,
    urlToken,
    invalidate,
    evaluateTabRow,
  ])

  return { validating, sessionToken: urlToken }
}
