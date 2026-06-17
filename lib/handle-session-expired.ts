export function handleSessionExpired(restaurantId: string) {
  if (typeof window === 'undefined') return

  localStorage.removeItem('flashtap_session_token')
  sessionStorage.removeItem('flashtap_session_token')

  localStorage.removeItem('flashtap_tab_id')
  localStorage.removeItem('flashtap_table')

  localStorage.removeItem(`flashtap_cart_${restaurantId}`)
  localStorage.removeItem('cart')
  localStorage.removeItem('cart_session_id')

  const isSubdomain = window.location.hostname !== 'flashtap.app' &&
                    !window.location.hostname.includes('localhost') &&
                    !window.location.hostname.includes('vercel.app')

  const sessionEndedPath = isSubdomain
    ? '/session-ended'
    : `/menu/${restaurantId}/session-ended`

  sessionStorage.setItem('flashtap_session_expired', 'true')
  window.location.replace(sessionEndedPath)
}
