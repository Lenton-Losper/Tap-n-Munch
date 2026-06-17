export function handleSessionExpired(restaurantId: string) {
  if (typeof window === 'undefined') return

  sessionStorage.removeItem('flashtap_session_token')
  localStorage.removeItem('flashtap_session_token')
  localStorage.removeItem('flashtap_tab_id')
  localStorage.removeItem('flashtap_table')
  localStorage.removeItem(`flashtap_cart_${restaurantId}`)
  localStorage.removeItem('cart')
  localStorage.removeItem('cart_session_id')
  sessionStorage.setItem('flashtap_session_expired', 'true')

  const hostname = window.location.hostname
  const isRivieraSubdomain = hostname === 'riviera.flashtap.app'

  if (isRivieraSubdomain) {
    window.location.replace('/session-ended')
  } else {
    window.location.replace(`/menu/${restaurantId}/session-ended`)
  }
}
