'use client'

import { useCallback, useEffect, useState } from 'react'
import { useAuth } from '@/components/auth/auth-provider'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useToast } from '@/hooks/use-toast'
import { supabase } from '@/lib/supabase/client'
import { SETTINGS_BRAND_PRIMARY, SETTINGS_BRAND_PRIMARY_HOVER } from './constants'
import {
  getSettingsAccessToken,
  profileInitials,
  splitDisplayName,
} from './settings-utils'

export function SettingsProfileTab() {
  const { user, userData } = useAuth()
  const { toast } = useToast()
  const [firstName, setFirstName] = useState('')
  const [lastName, setLastName] = useState('')
  const [email, setEmail] = useState('')
  const [originalEmail, setOriginalEmail] = useState('')
  const [emailSaving, setEmailSaving] = useState(false)
  const [emailChangeSentTo, setEmailChangeSentTo] = useState('')
  const [phone, setPhone] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (typeof window === 'undefined') return
    const params = new URLSearchParams(window.location.search)
    const hadParam =
      params.has('email_changed') || params.has('email_change_pending') || params.get('error') === 'email_change_link'
    if (!hadParam) return

    if (params.get('email_changed') === '1') {
      toast({ title: 'Email updated', description: 'Your sign-in email has been changed successfully.' })
    } else if (params.get('email_change_pending') === '1') {
      toast({
        title: 'Almost done — check your other inbox',
        description:
          'That confirms one of the two required links. Check your other inbox (new or current, whichever you haven\'t clicked yet) for the second link to finish changing your email.',
      })
    } else if (params.get('error') === 'email_change_link') {
      toast({
        title: 'Email change link could not be confirmed',
        description: 'That link may have expired or already been used. Try changing your email again from below.',
        variant: 'destructive',
      })
    }

    params.delete('email_changed')
    params.delete('email_change_pending')
    if (params.get('error') === 'email_change_link') {
      params.delete('error')
    }
    const search = params.toString()
    window.history.replaceState(
      null,
      '',
      `${window.location.pathname}${search ? `?${search}` : ''}${window.location.hash}`,
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps -- run once on mount to consume the redirect params
  }, [])

  const loadProfile = useCallback(async () => {
    try {
      setLoading(true)
      const token = await getSettingsAccessToken()
      const response = await fetch('/api/admin/user-profile', {
        headers: { Authorization: `Bearer ${token}` },
      })
      const payload = await response.json()
      if (!response.ok) {
        throw new Error(payload?.error || 'Failed to load profile')
      }
      setFirstName(payload.profile?.firstName || '')
      setLastName(payload.profile?.lastName || '')
      setEmail(payload.profile?.email || user?.email || '')
      setOriginalEmail(payload.profile?.email || user?.email || '')
      setPhone(payload.profile?.phone || '')
    } catch (error: unknown) {
      const fallbackName = splitDisplayName(
        String(userData?.full_name || userData?.name || '')
      )
      setFirstName(fallbackName.firstName)
      setLastName(fallbackName.lastName)
      setEmail(String(user?.email || userData?.email || ''))
      setOriginalEmail(String(user?.email || userData?.email || ''))
      setPhone(String(userData?.phone || ''))
      toast({
        title: 'Could not load profile',
        description: error instanceof Error ? error.message : 'Using cached profile data.',
        variant: 'destructive',
      })
    } finally {
      setLoading(false)
    }
  }, [toast, user, userData])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional deps-triggered data fetch; React Query refactor out of scope
    void loadProfile()
  }, [loadProfile])

  const handleSave = async () => {
    try {
      setSaving(true)
      const token = await getSettingsAccessToken()
      const response = await fetch('/api/admin/user-profile', {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ firstName, lastName, phone }),
      })
      const payload = await response.json()
      if (!response.ok) {
        throw new Error(payload?.error || 'Failed to save profile')
      }
      setFirstName(payload.profile?.firstName || firstName)
      setLastName(payload.profile?.lastName || lastName)
      setPhone(payload.profile?.phone || phone)
      toast({ title: 'Profile saved', description: 'Your profile has been updated.' })
    } catch (error: unknown) {
      toast({
        title: 'Save failed',
        description: error instanceof Error ? error.message : 'Failed to save profile',
        variant: 'destructive',
      })
    } finally {
      setSaving(false)
    }
  }

  const handleEmailSave = async () => {
    const trimmed = email.trim()
    if (!trimmed || trimmed === originalEmail) return

    try {
      setEmailSaving(true)
      const redirectTo = `${window.location.origin}/auth/callback?type=email_change`
      const { error } = await supabase.auth.updateUser(
        { email: trimmed },
        { emailRedirectTo: redirectTo },
      )
      if (error) throw error

      setEmailChangeSentTo(trimmed)
      toast({
        title: 'Two confirmations required',
        description: `We've sent a link to your NEW inbox at ${trimmed} — click that first. It'll then ask you to also confirm via a second link sent to your CURRENT inbox (${originalEmail}). Both are required to finish the change.`,
      })
    } catch (error: unknown) {
      toast({
        title: 'Could not start email change',
        description: error instanceof Error ? error.message : 'Failed to start email change',
        variant: 'destructive',
      })
      setEmail(originalEmail)
    } finally {
      setEmailSaving(false)
    }
  }

  const handleEmailCancel = () => {
    setEmail(originalEmail)
  }

  if (loading) {
    return <p className="text-sm text-muted-foreground">Loading profile...</p>
  }

  const initials = profileInitials(firstName, lastName, email)

  return (
    <div className="bg-card border rounded-lg p-6 space-y-6">
      <div className="flex items-center gap-4">
        <div
          className="flex h-16 w-16 shrink-0 items-center justify-center rounded-full text-lg font-semibold text-white"
          style={{ backgroundColor: SETTINGS_BRAND_PRIMARY }}
          aria-hidden
        >
          {initials}
        </div>
        <div>
          <h2 className="text-xl font-semibold">My profile</h2>
          <p className="text-sm text-muted-foreground">Your personal account details</p>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="settings-first-name">First name</Label>
          <Input
            id="settings-first-name"
            value={firstName}
            onChange={(e) => setFirstName(e.target.value)}
            disabled={saving}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="settings-last-name">Last name</Label>
          <Input
            id="settings-last-name"
            value={lastName}
            onChange={(e) => setLastName(e.target.value)}
            disabled={saving}
          />
        </div>
      </div>

      <div className="space-y-2">
        <Label htmlFor="settings-email">Email address</Label>
        <Input
          id="settings-email"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          disabled={emailSaving}
        />
        {email.trim() && email.trim() !== originalEmail ? (
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={handleEmailSave}
              disabled={emailSaving}
            >
              {emailSaving ? 'Sending confirmation...' : 'Save email'}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={handleEmailCancel}
              disabled={emailSaving}
            >
              Cancel
            </Button>
          </div>
        ) : null}
        {emailChangeSentTo ? (
          <p className="text-xs text-muted-foreground">
            Confirmation sent to {emailChangeSentTo} — click that link first, then check your current
            inbox ({originalEmail}) for a second confirmation link. Both are required to finish the change.
          </p>
        ) : null}
      </div>

      <div className="space-y-2">
        <Label htmlFor="settings-phone">Phone number</Label>
        <Input
          id="settings-phone"
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          placeholder="Enter phone number"
          disabled={saving}
        />
      </div>

      <Button
        onClick={handleSave}
        disabled={saving || !firstName.trim()}
        className="text-white"
        style={{ backgroundColor: SETTINGS_BRAND_PRIMARY }}
        onMouseEnter={(e) => {
          e.currentTarget.style.backgroundColor = SETTINGS_BRAND_PRIMARY_HOVER
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.backgroundColor = SETTINGS_BRAND_PRIMARY
        }}
      >
        {saving ? 'Saving...' : 'Save profile'}
      </Button>
    </div>
  )
}
