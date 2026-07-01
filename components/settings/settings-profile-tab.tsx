'use client'

import { useCallback, useEffect, useState } from 'react'
import { useAuth } from '@/components/auth/auth-provider'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useToast } from '@/hooks/use-toast'
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
  const [phone, setPhone] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)

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
      setPhone(payload.profile?.phone || '')
    } catch (error: unknown) {
      const fallbackName = splitDisplayName(
        String(userData?.full_name || userData?.name || '')
      )
      setFirstName(fallbackName.firstName)
      setLastName(fallbackName.lastName)
      setEmail(String(user?.email || userData?.email || ''))
      setPhone(String(userData?.phone || ''))
      toast({
        title: 'Could not load profile',
        description: error instanceof Error ? error.message : 'Using cached profile data.',
        variant: 'destructive',
      })
    } finally {
      setLoading(false)
    }
  }, [toast, user?.email, userData])

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
        <Input id="settings-email" value={email} readOnly disabled className="bg-muted/50" />
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
