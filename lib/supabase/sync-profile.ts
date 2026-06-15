import { supabase } from './client'

export async function syncAuthProfile(restaurantName?: string): Promise<boolean> {
  const { data: sessionData } = await supabase.auth.getSession()
  const token = sessionData.session?.access_token
  if (!token) return false

  const response = await fetch('/api/auth/sync-profile', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(restaurantName ? { restaurantName } : {}),
  })

  if (!response.ok) {
    const payload = await response.json().catch(() => ({}))
    console.warn('[AUTH] sync-profile failed', payload?.error || response.status)
    return false
  }

  return true
}
