import { supabase } from '@/lib/supabase/client'
import type { SettingsTabId } from './constants'

export async function getSettingsAccessToken(): Promise<string> {
  const { data } = await supabase.auth.getSession()
  const token = data.session?.access_token
  if (!token) throw new Error('Session expired. Please sign in again.')
  return token
}

export function splitDisplayName(fullName: string): { firstName: string; lastName: string } {
  const trimmed = String(fullName || '').trim()
  if (!trimmed) return { firstName: '', lastName: '' }
  const parts = trimmed.split(/\s+/)
  if (parts.length === 1) return { firstName: parts[0], lastName: '' }
  return {
    firstName: parts[0],
    lastName: parts.slice(1).join(' '),
  }
}

export function joinDisplayName(firstName: string, lastName: string): string {
  return [firstName.trim(), lastName.trim()].filter(Boolean).join(' ')
}

export function profileInitials(firstName: string, lastName: string, email: string): string {
  const first = firstName.trim()[0] || ''
  const last = lastName.trim()[0] || ''
  if (first || last) return `${first}${last}`.toUpperCase()
  return (email.trim()[0] || '?').toUpperCase()
}

export function hashToSettingsTab(hash: string): SettingsTabId {
  const normalized = String(hash || '').toLowerCase()
  if (normalized === '#bank') return 'bank'
  if (normalized === '#billing') return 'billing'
  if (normalized === '#restaurant') return 'restaurant'
  if (normalized === '#business') return 'business'
  return 'profile'
}
