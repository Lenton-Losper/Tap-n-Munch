'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useAuth } from '@/components/auth/auth-provider'
import { getRestaurant, updateRestaurantSettings } from '@/lib/supabase/restaurants'
import { getSettingsAccessToken } from './settings-utils'
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
import { Switch } from '@/components/ui/switch'
import { Upload } from 'lucide-react'
import { useToast } from '@/hooks/use-toast'
import { SETTINGS_BRAND_PRIMARY, SETTINGS_BRAND_PRIMARY_HOVER } from './constants'

export function SettingsRestaurantTab() {
  const { restaurantId } = useAuth()
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
    void loadRestaurant()
  }, [loadRestaurant])

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

  if (loading) {
    return <p className="text-sm text-muted-foreground">Loading restaurant details...</p>
  }

  const displayLogo = logoPreview || (logoUrl && !logoLoadFailed ? logoUrl : null)

  return (
    <div className="bg-card border rounded-lg p-6 space-y-6">
      <div>
        <h2 className="text-xl font-semibold">Restaurant</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Logo and contact details shown on your customer menu.
        </p>
      </div>

      <div className="space-y-3">
        <Label>Logo</Label>
        <div className="flex items-center gap-4">
          <div className="flex h-24 w-24 items-center justify-center overflow-hidden rounded-lg border bg-muted">
            {displayLogo ? (
              <img
                src={displayLogo}
                alt="Restaurant logo"
                className="h-full w-full object-cover"
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
    </div>
  )
}
