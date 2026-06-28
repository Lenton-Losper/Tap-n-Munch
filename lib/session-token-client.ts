import type { ReadonlyURLSearchParams } from 'next/navigation'
import { clearSession } from '@/lib/session'
import { isTabSessionEndedStatus, landingPath } from '@/lib/tab-session'
import {
  clearTabSession,
  SESSION_TOKEN_STORAGE_KEY,
  setSessionEndedNotice,
} from '@/lib/tab-storage'

type SearchParamsLike = Pick<URLSearchParams, 'get'> | ReadonlyURLSearchParams | null

export function readSessionTokenFromSearchParams(searchParams: SearchParamsLike): string {
  const fromUrl =
    searchParams?.get('st')?.trim() ||
    searchParams?.get('token')?.trim() ||
    searchParams?.get('session_token')?.trim() ||
    ''
  if (fromUrl) return fromUrl
  if (typeof window === 'undefined') return ''
  return (
    sessionStorage.getItem(SESSION_TOKEN_STORAGE_KEY)?.trim() ||
    localStorage.getItem(SESSION_TOKEN_STORAGE_KEY)?.trim() ||
    ''
  )
}

export function clearCustomerSessionState(): void {
  clearTabSession()
  clearSession()
  if (typeof window === 'undefined') return
  sessionStorage.removeItem(SESSION_TOKEN_STORAGE_KEY)
  localStorage.removeItem(SESSION_TOKEN_STORAGE_KEY)
}

export function setSessionTokenExpiredNotice(): void {
  setSessionEndedNotice()
  if (typeof window === 'undefined') return
  sessionStorage.setItem('flashtap_session_expired', 'true')
}

export function isTabSessionTokenEndedStatus(status: string | null | undefined): boolean {
  return isTabSessionEndedStatus(status)
}

export function tableLandingPath(restaurantId: string, tableNumber: number): string {
  return landingPath(restaurantId, tableNumber)
}
