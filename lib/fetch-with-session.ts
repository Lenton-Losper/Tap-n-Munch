import { handleSessionExpired } from './handle-session-expired'

export const SESSION_TOKEN_STORAGE_KEY = 'flashtap_session_token'

export function getSessionToken(): string {
  if (typeof window === 'undefined') return ''
  return (
    sessionStorage.getItem(SESSION_TOKEN_STORAGE_KEY) ||
    localStorage.getItem(SESSION_TOKEN_STORAGE_KEY) ||
    ''
  )
}

export function persistSessionToken(token: string) {
  if (typeof window === 'undefined') return
  sessionStorage.setItem(SESSION_TOKEN_STORAGE_KEY, token)
}

export function clearSessionToken() {
  if (typeof window === 'undefined') return
  sessionStorage.removeItem(SESSION_TOKEN_STORAGE_KEY)
}

export async function fetchWithSession(
  url: string,
  restaurantId: string,
  options: RequestInit = {}
): Promise<Response> {
  const headers = new Headers(options.headers)
  const token = getSessionToken()
  if (token) {
    headers.set('x-session-token', token)
  }

  const response = await fetch(url, { ...options, headers })

  if (response.status === 410) {
    handleSessionExpired(restaurantId)
  }

  return response
}
