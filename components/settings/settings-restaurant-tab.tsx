'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import Image from 'next/image'
import { useAuth } from '@/components/auth/auth-provider'
import { getRestaurant, updateRestaurantSettings } from '@/lib/supabase/restaurants'
import { getSettingsAccessToken } from './settings-utils'
import { getAccessToken } from '@/lib/onboarding/api-client'
import {
  isLogoStoragePath,
  logoPathFromUrl,
  restaurantLogoDisplayUrl,
} from '@/lib/restaurant-logo'
import { uploadRestaurantLogo } from '@/lib/supabase/storage'
import { supabase } from '@/lib/supabase/client'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Switch } from '@/components/ui/switch'
import { Upload } from 'lucide-react'
import { useToast } from '@/hooks/use-toast'
import { SETTINGS_BRAND_PRIMARY, SETTINGS_BRAND_PRIMARY_HOVER } from './constants'

type ReportSchedule = {
  id: string
  restaurant_id: string
  enabled: boolean
  email: string
  format: 'pdf' | 'csv'
  send_time: string
  timezone: string
  created_at: string
  updated_at: string
}

function displaySendTime(time: string): string {
  const match = /^(\d{1,2}):(\d{2})/.exec(time)
  if (!match) return time
  const hour = parseInt(match[1], 10)
  const minute = match[2]
  const ampm = hour >= 12 ? 'PM' : 'AM'
  const h12 = hour % 12 || 12
  return `${h12}:${minute} ${ampm}`
}

export function SettingsRestaurantTab() {
  const { restaurantId, user } = useAuth()
  const { toast } = useToast()
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [uploadingLogo, setUploadingLogo] = useState(false)
  const [name, setName] = useState('')
  const [phone, setPhone] = useState('')
  const [logoUrl, setLogoUrl] = useState<string | null>(null)
  const [logoPreview, setLogoPreview] = useState<string | null>(null)
  const [logoLoadFailed, setLogoLoadFailed] = useState(false)
  const [storedLogoPath, setStoredLogoPath] = useState<string | null>(null)
  const [tabPinRequired, setTabPinRequired] = useState(true)
  const [savingTabPinRequired, setSavingTabPinRequired] = useState(false)

  const [schedules, setSchedules] = useState<ReportSchedule[]>([])
  const [loadingSchedules, setLoadingSchedules] = useState(true)
  const [togglingScheduleId, setTogglingScheduleId] = useState<string | null>(null)
  const [deletingScheduleId, setDeletingScheduleId] = useState<string | null>(null)
  const [addingSchedule, setAddingSchedule] = useState(false)
  const [newScheduleEmail, setNewScheduleEmail] = useState('')
  const [newScheduleFormat, setNewScheduleFormat] = useState<'pdf' | 'csv'>('csv')
  const [newScheduleSendTime, setNewScheduleSendTime] = useState('20:00')

  const loadSchedules = useCallback(async () => {
    if (!restaurantId) {
      setLoadingSchedules(false)
      return
    }
    try {
      setLoadingSchedules(true)
      const token = await getAccessToken()
      const response = await fetch(`/api/admin/restaurants/${restaurantId}/report-schedules`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      const payload = await response.json().catch(() => ({}))
      if (!response.ok) {
        throw new Error(payload?.error || 'Failed to load scheduled reports')
      }
      setSchedules(Array.isArray(payload?.schedules) ? payload.schedules : [])
    } catch (error: unknown) {
      toast({
        title: 'Error',
        description: error instanceof Error ? error.message : 'Failed to load scheduled reports',
        variant: 'destructive',
      })
    } finally {
      setLoadingSchedules(false)
    }
  }, [restaurantId, toast])

  const loadRestaurant = useCallback(async () => {
    if (!restaurantId) {
      setLoading(false)
      return
    }
    try {
      setLoading(true)
      const data = await getRestaurant(restaurantId)
      const { data: settingsData } = await supabase
        .from('restaurant_settings')
        .select('tab_pin_required')
        .eq('restaurant_id', restaurantId)
        .maybeSingle()

      if (data) {
        setName(data.name || '')
        setPhone(data.phone || '')
        setStoredLogoPath(data.logo_url || null)
        setLogoUrl(
          restaurantLogoDisplayUrl(restaurantId, data.logo_url || null) || data.logo_url || null
        )
        setLogoLoadFailed(false)
      }
      setTabPinRequired(settingsData?.tab_pin_required !== false)
    } catch (error: unknown) {
      toast({
        title: 'Error',
        description: error instanceof Error ? error.message : 'Failed to load restaurant',
        variant: 'destructive',
      })
    } finally {
      setLoading(false)
    }
  }, [restaurantId, toast])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional deps-triggered data fetch; React Query refactor out of scope
    void loadRestaurant()
  }, [loadRestaurant])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional deps-triggered data fetch; React Query refactor out of scope
    void loadSchedules()
  }, [loadSchedules])

  const scheduleEmailValue = newScheduleEmail || user?.email || ''

  const handleScheduleToggle = async (schedule: ReportSchedule, enabled: boolean) => {
    if (!restaurantId) return

    try {
      setTogglingScheduleId(schedule.id)
      const token = await getAccessToken()
      const response = await fetch(
        `/api/admin/restaurants/${restaurantId}/report-schedules/${schedule.id}`,
        {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ enabled }),
        }
      )
      const payload = await response.json().catch(() => ({}))
      if (!response.ok) {
        throw new Error(payload?.error || 'Failed to update schedule')
      }
      setSchedules((current) =>
        current.map((item) =>
          item.id === schedule.id ? { ...item, enabled, ...(payload.schedule ?? {}) } : item
        )
      )
    } catch (error: unknown) {
      toast({
        title: 'Update failed',
        description: error instanceof Error ? error.message : 'Failed to update schedule',
        variant: 'destructive',
      })
    } finally {
      setTogglingScheduleId(null)
    }
  }

  const handleDeleteSchedule = async (scheduleId: string) => {
    if (!restaurantId) return

    try {
      setDeletingScheduleId(scheduleId)
      const token = await getAccessToken()
      const response = await fetch(
        `/api/admin/restaurants/${restaurantId}/report-schedules/${scheduleId}`,
        {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${token}` },
        }
      )
      const payload = await response.json().catch(() => ({}))
      if (!response.ok) {
        throw new Error(payload?.error || 'Failed to delete schedule')
      }
      setSchedules((current) => current.filter((item) => item.id !== scheduleId))
      toast({ title: 'Deleted', description: 'Scheduled report removed.' })
    } catch (error: unknown) {
      toast({
        title: 'Delete failed',
        description: error instanceof Error ? error.message : 'Failed to delete schedule',
        variant: 'destructive',
      })
    } finally {
      setDeletingScheduleId(null)
    }
  }

  const handleAddSchedule = async () => {
    if (!restaurantId) return
    if (!scheduleEmailValue.trim()) {
      toast({
        title: 'Validation error',
        description: 'Email address is required',
        variant: 'destructive',
      })
      return
    }

    try {
      setAddingSchedule(true)
      const token = await getAccessToken()
      const response = await fetch(`/api/admin/restaurants/${restaurantId}/report-schedules`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          email: scheduleEmailValue.trim(),
          format: newScheduleFormat,
          send_time: newScheduleSendTime,
        }),
      })
      const payload = await response.json().catch(() => ({}))
      if (!response.ok) {
        throw new Error(payload?.error || 'Failed to create schedule')
      }
      if (payload.schedule) {
        setSchedules((current) => [...current, payload.schedule as ReportSchedule])
      } else {
        await loadSchedules()
      }
      toast({ title: 'Added', description: 'Scheduled report created.' })
    } catch (error: unknown) {
      toast({
        title: 'Add failed',
        description: error instanceof Error ? error.message : 'Failed to create schedule',
        variant: 'destructive',
      })
    } finally {
      setAddingSchedule(false)
    }
  }

  const handleTabPinRequiredToggle = async (enabled: boolean) => {
    if (!restaurantId) return

    try {
      setSavingTabPinRequired(true)
      const token = await getSettingsAccessToken()
      const response = await fetch(`/api/admin/restaurants/${restaurantId}/settings`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ tab_pin_required: enabled }),
      })
      const payload = await response.json().catch(() => ({}))
      if (!response.ok) {
        throw new Error(payload?.error || 'Failed to update tab PIN setting')
      }
      setTabPinRequired(enabled)
      toast({ title: 'Saved', description: 'Tab PIN setting updated.' })
    } catch (error: unknown) {
      toast({
        title: 'Save failed',
        description: error instanceof Error ? error.message : 'Failed to update tab PIN setting',
        variant: 'destructive',
      })
    } finally {
      setSavingTabPinRequired(false)
    }
  }

  const handleLogoUpload = async (file: File) => {
    if (!restaurantId) return

    const allowedTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp']
    if (!allowedTypes.includes(file.type)) {
      toast({
        title: 'Invalid file type',
        description: 'Logo must be a JPG, PNG, or WebP image',
        variant: 'destructive',
      })
      return
    }

    const maxSize = 2 * 1024 * 1024
    if (file.size > maxSize) {
      toast({
        title: 'File too large',
        description: 'Logo size must be less than 2MB',
        variant: 'destructive',
      })
      return
    }

    const reader = new FileReader()
    reader.onloadend = () => setLogoPreview(reader.result as string)
    reader.readAsDataURL(file)

    try {
      setUploadingLogo(true)
      const { data: sessionData } = await supabase.auth.getSession()
      const accessToken = sessionData.session?.access_token
      if (!accessToken) throw new Error('Session expired. Please sign in again.')

      await uploadRestaurantLogo(file, restaurantId, accessToken)
      const refreshed = await getRestaurant(restaurantId)
      const path = refreshed?.logo_url || null
      setStoredLogoPath(path)
      setLogoUrl(restaurantLogoDisplayUrl(restaurantId, path))
      setLogoPreview(null)
      setLogoLoadFailed(false)

      toast({ title: 'Logo updated', description: 'Your restaurant logo was uploaded.' })
    } catch (error: unknown) {
      setLogoPreview(null)
      toast({
        title: 'Upload failed',
        description: error instanceof Error ? error.message : 'Failed to upload logo',
        variant: 'destructive',
      })
    } finally {
      setUploadingLogo(false)
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }

  const handleSave = async () => {
    if (!restaurantId) return
    if (!name.trim()) {
      toast({
        title: 'Validation error',
        description: 'Restaurant name is required',
        variant: 'destructive',
      })
      return
    }

    try {
      setSaving(true)
      const logoForDb =
        storedLogoPath && (isLogoStoragePath(storedLogoPath) || logoPathFromUrl(storedLogoPath))
          ? isLogoStoragePath(storedLogoPath)
            ? storedLogoPath
            : logoPathFromUrl(storedLogoPath)
          : logoUrl?.startsWith('/api/media/')
            ? storedLogoPath
            : logoUrl

      await updateRestaurantSettings(restaurantId, {
        name: name.trim(),
        phone: phone.trim() || null,
        logo_url: logoForDb,
      })

      try {
        await fetch('/api/cache/restaurant/invalidate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ restaurantId }),
        })
      } catch {
        /* non-fatal */
      }

      toast({ title: 'Saved', description: 'Restaurant details updated.' })
    } catch (error: unknown) {
      toast({
        title: 'Save failed',
        description: error instanceof Error ? error.message : 'Failed to save restaurant details',
        variant: 'destructive',
      })
    } finally {
      setSaving(false)
    }
  }

  const displayLogo = logoPreview || (logoUrl && !logoLoadFailed ? logoUrl : null)

  return (
    <div className="space-y-6">
    <div className="bg-card border rounded-lg p-6 space-y-6">
      <div>
        <h2 className="text-xl font-semibold">Restaurant</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Logo and contact details shown on your customer menu.
        </p>
      </div>

      {loading ? (
        <p className="text-sm text-muted-foreground">Loading restaurant details...</p>
      ) : (
        <>
      <div className="space-y-3">
        <Label>Logo</Label>
        <div className="flex items-center gap-4">
          <div className="flex h-24 w-24 items-center justify-center overflow-hidden rounded-lg border bg-muted">
            {displayLogo ? (
              <Image
                src={displayLogo}
                alt="Restaurant logo"
                width={96}
                height={96}
                className="h-full w-full object-cover"
                unoptimized
                onError={() => setLogoLoadFailed(true)}
              />
            ) : (
              <span className="text-xs text-muted-foreground">No logo</span>
            )}
          </div>
          <div>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/jpeg,image/jpg,image/png,image/webp"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0]
                if (file) void handleLogoUpload(file)
              }}
              disabled={uploadingLogo || saving}
            />
            <Button
              type="button"
              variant="outline"
              onClick={() => fileInputRef.current?.click()}
              disabled={uploadingLogo || saving}
            >
              <Upload className="mr-2 h-4 w-4" />
              {uploadingLogo ? 'Uploading...' : 'Replace logo'}
            </Button>
          </div>
        </div>
      </div>

      <div className="space-y-2">
        <Label htmlFor="restaurant-name">Restaurant name</Label>
        <Input
          id="restaurant-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          disabled={saving}
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="restaurant-phone">Phone number</Label>
        <Input
          id="restaurant-phone"
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          disabled={saving}
        />
      </div>

      <div className="flex items-center justify-between gap-4 rounded-lg border p-4">
        <div className="space-y-1">
          <Label htmlFor="tab-pin-required">Require Tab PIN</Label>
          <p className="text-sm text-muted-foreground">
            When enabled, customers must share a 4-digit PIN for others to join their tab.
          </p>
        </div>
        <Switch
          id="tab-pin-required"
          checked={tabPinRequired}
          onCheckedChange={(checked) => void handleTabPinRequiredToggle(checked)}
          disabled={savingTabPinRequired || saving || uploadingLogo}
        />
      </div>

      <Button
        onClick={handleSave}
        disabled={saving || uploadingLogo}
        className="text-white"
        style={{ backgroundColor: SETTINGS_BRAND_PRIMARY }}
        onMouseEnter={(e) => {
          e.currentTarget.style.backgroundColor = SETTINGS_BRAND_PRIMARY_HOVER
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.backgroundColor = SETTINGS_BRAND_PRIMARY
        }}
      >
        {saving ? 'Saving...' : 'Save restaurant details'}
      </Button>
        </>
      )}
    </div>

    <div className="bg-card border rounded-lg p-6 space-y-6">
      <div>
        <h2 className="text-xl font-semibold">Scheduled Reports</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Automatically email daily order reports to selected recipients.
        </p>
      </div>

      {loadingSchedules ? (
        <p className="text-sm text-muted-foreground">Loading scheduled reports...</p>
      ) : (
        <>
          {schedules.length === 0 ? (
            <div className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
              No scheduled reports yet. Add one below.
            </div>
          ) : (
            <div className="space-y-3">
              {schedules.map((schedule) => (
                <div
                  key={schedule.id}
                  className="flex flex-col gap-4 rounded-lg border p-4 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div className="min-w-0 space-y-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="font-medium truncate">{schedule.email}</p>
                      <Badge variant="secondary">{schedule.format.toUpperCase()}</Badge>
                    </div>
                    <p className="text-sm text-muted-foreground">
                      Sends daily at {displaySendTime(schedule.send_time)}
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center gap-3 shrink-0">
                    <div className="flex items-center gap-2">
                      <Label htmlFor={`schedule-enabled-${schedule.id}`} className="text-sm">
                        {schedule.enabled ? 'Enabled' : 'Disabled'}
                      </Label>
                      <Switch
                        id={`schedule-enabled-${schedule.id}`}
                        checked={schedule.enabled}
                        onCheckedChange={(checked) => void handleScheduleToggle(schedule, checked)}
                        disabled={
                          togglingScheduleId === schedule.id ||
                          deletingScheduleId === schedule.id ||
                          addingSchedule
                        }
                      />
                    </div>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="text-red-600 hover:text-red-700"
                      onClick={() => void handleDeleteSchedule(schedule.id)}
                      disabled={
                        deletingScheduleId === schedule.id ||
                        togglingScheduleId === schedule.id ||
                        addingSchedule
                      }
                    >
                      {deletingScheduleId === schedule.id ? 'Deleting...' : 'Delete'}
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}

          <div className="space-y-4 border-t pt-6">
            <div>
              <h3 className="text-base font-semibold">Add Schedule</h3>
              <p className="mt-1 text-sm text-muted-foreground">
                Create a new daily report delivery.
              </p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="schedule-email">Email address</Label>
              <Input
                id="schedule-email"
                type="email"
                value={scheduleEmailValue}
                onChange={(e) => setNewScheduleEmail(e.target.value)}
                placeholder="recipient@example.com"
                disabled={addingSchedule}
              />
            </div>

            <div className="space-y-2">
              <Label>Format</Label>
              <div className="flex gap-3">
                {(['csv', 'pdf'] as const).map((fmt) => (
                  <button
                    key={fmt}
                    type="button"
                    disabled={addingSchedule}
                    onClick={() => setNewScheduleFormat(fmt)}
                    className={`rounded-md border px-4 py-2 text-sm font-medium transition-colors disabled:opacity-50 ${
                      newScheduleFormat === fmt
                        ? 'border-[#2E75B6] bg-[#EBF3FB] text-[#2E75B6]'
                        : 'border-[#E9E9E7] text-[#6B675F] hover:bg-gray-50'
                    }`}
                  >
                    {fmt.toUpperCase()}
                  </button>
                ))}
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="schedule-send-time">Send time</Label>
              <Input
                id="schedule-send-time"
                type="time"
                value={newScheduleSendTime}
                onChange={(e) => setNewScheduleSendTime(e.target.value || '20:00')}
                disabled={addingSchedule}
                className="max-w-[12rem]"
              />
            </div>

            <Button
              type="button"
              onClick={() => void handleAddSchedule()}
              disabled={addingSchedule || !scheduleEmailValue.trim()}
              className="text-white"
              style={{ backgroundColor: SETTINGS_BRAND_PRIMARY }}
              onMouseEnter={(e) => {
                e.currentTarget.style.backgroundColor = SETTINGS_BRAND_PRIMARY_HOVER
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.backgroundColor = SETTINGS_BRAND_PRIMARY
              }}
            >
              {addingSchedule ? 'Adding...' : 'Add Schedule'}
            </Button>
          </div>
        </>
      )}
    </div>
    </div>
  )
}
