'use client'

export const dynamic = "force-dynamic";

import { useEffect, useState, useRef } from 'react'
import { useAuth } from '@/components/auth/auth-provider'
import { getRestaurant, updateRestaurantSettings } from '@/lib/supabase/restaurants'
import {
  isLogoStoragePath,
  logoPathFromUrl,
  restaurantLogoDisplayUrl,
} from '@/lib/restaurant-logo'
import { uploadRestaurantLogo } from '@/lib/supabase/storage'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Input } from '@/components/ui/input'
import { ArrowLeft, Banknote, CreditCard, Save, Upload, X, Building2 } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { useToast } from '@/hooks/use-toast'
import { Switch } from '@/components/ui/switch'
import { supabase } from '@/lib/supabase/client'

function SettingsContent() {
  const { user, restaurantId, restaurant: initialRestaurant } = useAuth()
  const router = useRouter()
  const { toast } = useToast()
  const [restaurant, setRestaurant] = useState(initialRestaurant)
  const [loading, setLoading] = useState(true)
  
  // Restaurant Details state
  const [name, setName] = useState('')
  const [phone, setPhone] = useState('')
  const [logoUrl, setLogoUrl] = useState<string | null>(null)
  const [logoPreview, setLogoPreview] = useState<string | null>(null)
  const [logoLoadFailed, setLogoLoadFailed] = useState(false)
  const [uploadingLogo, setUploadingLogo] = useState(false)
  const [savingDetails, setSavingDetails] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  
  // Payment Settings state
  const [savingPayment, setSavingPayment] = useState(false)
  const [cashEnabled, setCashEnabled] = useState(true)
  const [cardEnabled, setCardEnabled] = useState(false)
  const [finaticMerchantNo, setFinaticMerchantNo] = useState('')
  const [finaticStoreNo, setFinaticStoreNo] = useState('')
  const [finaticTerminalSn, setFinaticTerminalSn] = useState('')
  
  // Track if details have changed
  const [detailsChanged, setDetailsChanged] = useState(false)

  useEffect(() => {
    const loadRestaurant = async () => {
      // Don't run if user is null (prevents fetching when signed out)
      if (!user) {
        setLoading(false)
        return
      }

      if (!restaurantId) {
        setLoading(false)
        return
      }
      
      try {
        setLoading(true)
        const data = await getRestaurant(restaurantId)
        if (data) {
          setRestaurant(data)
          setName(data.name || '')
          setPhone(data.phone || '')
          setLogoUrl(
            restaurantLogoDisplayUrl(restaurantId, data.logo_url || null) ||
              data.logo_url ||
              null
          )
          setLogoLoadFailed(false)
          setCashEnabled(data.payment_methods?.includes('cash') ?? true)
          setCardEnabled(data.payment_methods?.includes('card') ?? false)
          setFinaticMerchantNo(String((data as any).finatic_merchant_no || ''))
          setFinaticStoreNo(String((data as any).finatic_store_no || ''))
          setFinaticTerminalSn(String((data as any).finatic_terminal_sn || ''))
          setDetailsChanged(false)
        }
      } catch (err) {
        console.error('Failed to load restaurant:', err)
        toast({
          title: 'Error',
          description: 'Failed to load restaurant settings',
          variant: 'destructive',
        })
      } finally {
        setLoading(false)
      }
    }

    if (restaurantId) {
      loadRestaurant()
    }
  }, [user, restaurantId, toast])

  // Track changes to restaurant details
  useEffect(() => {
    if (!restaurant) return
    
    const hasChanged = 
      name !== (restaurant.name || '') ||
      phone !== (restaurant.phone || '') ||
      logoUrl !==
        (restaurantLogoDisplayUrl(restaurantId, restaurant.logo_url || null) ||
          restaurant.logo_url ||
          null) ||
      finaticMerchantNo !== String((restaurant as any).finatic_merchant_no || '') ||
      finaticStoreNo !== String((restaurant as any).finatic_store_no || '') ||
      finaticTerminalSn !== String((restaurant as any).finatic_terminal_sn || '') ||
      logoPreview !== null
    
    setDetailsChanged(hasChanged)
  }, [
    name,
    phone,
    logoUrl,
    finaticMerchantNo,
    finaticStoreNo,
    finaticTerminalSn,
    logoPreview,
    restaurant,
  ])

  const handleLogoUpload = async (file: File) => {
    if (!restaurantId) {
      toast({
        title: 'Not ready',
        description: 'Restaurant profile is still loading. Please wait and try again.',
        variant: 'destructive',
      })
      return
    }

    try {
      setUploadingLogo(true)
      
      // Validate file type
      const allowedTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp']
      if (!allowedTypes.includes(file.type)) {
        toast({
          title: 'Invalid file type',
          description: 'Logo must be a JPG, PNG, or WebP image',
          variant: 'destructive',
        })
        return
      }

      // Validate file size (max 2MB)
      const maxSize = 2 * 1024 * 1024 // 2MB
      if (file.size > maxSize) {
        toast({
          title: 'File too large',
          description: 'Logo size must be less than 2MB',
          variant: 'destructive',
        })
        return
      }

      // Create preview
      const reader = new FileReader()
      reader.onloadend = () => {
        setLogoPreview(reader.result as string)
      }
      reader.readAsDataURL(file)

      const { data: sessionData } = await supabase.auth.getSession()
      const accessToken = sessionData.session?.access_token
      if (!accessToken) {
        toast({
          title: 'Authentication Required',
          description: 'Your session expired. Please sign in again.',
          variant: 'destructive',
        })
        return
      }

      console.log('[SETTINGS] uploading logo', { restaurantId, name: file.name, size: file.size })
      await uploadRestaurantLogo(file, restaurantId, accessToken)
      const refreshed = await getRestaurant(restaurantId)
      const storagePath = refreshed?.logo_url || null
      const displayUrl = restaurantLogoDisplayUrl(restaurantId, storagePath)
      setLogoUrl(displayUrl)
      setLogoPreview(null)
      setLogoLoadFailed(false)
      setRestaurant(refreshed)

      try {
        await fetch('/api/cache/restaurant/invalidate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ restaurantId }),
        })
      } catch {
        /* non-fatal */
      }

      toast({
        title: 'Logo saved',
        description: 'Your restaurant logo was uploaded and saved.',
      })
    } catch (error: any) {
      console.error('[SETTINGS] logo upload error:', error)
      setLogoPreview(null)
      toast({
        title: 'Upload failed',
        description: error.message || 'Failed to upload logo. Please try again.',
        variant: 'destructive',
      })
    } finally {
      setUploadingLogo(false)
      if (fileInputRef.current) {
        fileInputRef.current.value = ''
      }
    }
  }

  const handleRemoveLogo = () => {
    setLogoUrl(null)
    setLogoPreview(null)
    setLogoLoadFailed(false)
    if (fileInputRef.current) {
      fileInputRef.current.value = ''
    }
  }

  const handleSaveDetails = async () => {
    if (!restaurantId) return

    // Validation
    if (!name.trim()) {
      toast({
        title: 'Validation Error',
        description: 'Restaurant name is required',
        variant: 'destructive',
      })
      return
    }

    if (!phone.trim()) {
      toast({
        title: 'Validation Error',
        description: 'Phone number is required',
        variant: 'destructive',
      })
      return
    }

    try {
      setSavingDetails(true)

      const logoForDb =
        restaurant?.logo_url && (isLogoStoragePath(restaurant.logo_url) || logoPathFromUrl(restaurant.logo_url))
          ? isLogoStoragePath(restaurant.logo_url)
            ? restaurant.logo_url
            : logoPathFromUrl(restaurant.logo_url)
          : logoUrl?.startsWith('/api/media/')
            ? restaurant?.logo_url ?? null
            : logoUrl

      await updateRestaurantSettings(restaurantId, {
        name: name.trim(),
        phone: phone.trim(),
        logo_url: logoForDb,
        finatic_merchant_no: finaticMerchantNo.trim() || null,
        finatic_store_no: finaticStoreNo.trim() || null,
        finatic_terminal_sn: finaticTerminalSn.trim() || null,
      })
      await fetch('/api/cache/restaurant/invalidate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ restaurantId }),
      })

      // Update local state
      setRestaurant((prev) => 
        prev
          ? {
              ...prev,
              name: name.trim(),
              phone: phone.trim(),
              logo_url: logoForDb,
              finatic_merchant_no: finaticMerchantNo.trim() || '',
              finatic_store_no: finaticStoreNo.trim() || '',
              finatic_terminal_sn: finaticTerminalSn.trim() || '',
            }
          : null
      )
      setDetailsChanged(false)

      toast({
        title: 'Success',
        description: 'Restaurant details updated successfully',
      })
    } catch (error: any) {
      toast({
        title: 'Save failed',
        description: error.message || 'Failed to save restaurant details',
        variant: 'destructive',
      })
    } finally {
      setSavingDetails(false)
    }
  }

  const handleSavePayment = async () => {
    if (!restaurantId) return

    // Validate: at least one payment method must be enabled
    if (!cashEnabled && !cardEnabled) {
      toast({
        title: 'Validation Error',
        description: 'At least one payment method must be enabled',
        variant: 'destructive',
      })
      return
    }

    try {
      setSavingPayment(true)
      const paymentMethods: string[] = []
      if (cashEnabled) paymentMethods.push('cash')
      if (cardEnabled) paymentMethods.push('card')

      await updateRestaurantSettings(restaurantId, {
        payment_methods: paymentMethods,
      })

      // Update local state
      setRestaurant((prev) => (prev ? { ...prev, payment_methods: paymentMethods } : null))

      toast({
        title: 'Settings saved',
        description: 'Payment methods updated successfully',
      })
    } catch (error: any) {
      toast({
        title: 'Save failed',
        description: error.message || 'Failed to save settings',
        variant: 'destructive',
      })
    } finally {
      setSavingPayment(false)
    }
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-muted/30 flex items-center justify-center">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-[#FF6B35]"></div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-muted/30">
      {/* Header */}
      <header className="bg-card border-b border-border">
        <div className="container mx-auto px-6 py-6 flex items-center gap-4">
          <Button
            variant="ghost"
            size="icon"
            onClick={() => router.push('/dashboard')}
            className="h-11 w-11"
          >
            <ArrowLeft className="h-5 w-5" />
          </Button>
          <h1 className="text-3xl font-bold">Restaurant Settings</h1>
        </div>
      </header>

      {/* Content */}
      <div className="container mx-auto px-6 py-6 max-w-2xl space-y-6">
        {/* Restaurant Details Section */}
        <div className="bg-card border rounded-lg p-6 space-y-6">
          <div>
            <h2 className="text-xl font-semibold mb-2 flex items-center gap-2">
              <Building2 className="h-5 w-5" />
              Restaurant Details
            </h2>
            <p className="text-sm text-muted-foreground mb-6">
              Update your restaurant name, phone number, and logo. These will appear on your QR code landing page.
            </p>
          </div>

          {/* Restaurant Name */}
          <div className="space-y-2">
            <Label htmlFor="name">Restaurant Name *</Label>
            <Input
              id="name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Enter restaurant name"
              disabled={savingDetails}
            />
          </div>

          {/* Phone Number */}
          <div className="space-y-2">
            <Label htmlFor="phone">Phone Number *</Label>
            <Input
              id="phone"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder="Enter phone number"
              disabled={savingDetails}
            />
          </div>

          {/* Logo Upload */}
          <div className="space-y-2">
            <Label>Restaurant Logo</Label>
            <div className="space-y-4">
              {/* Logo Preview */}
              {(logoPreview || (logoUrl && !logoLoadFailed)) && (
                <div className="relative inline-block">
                  <div className="w-32 h-32 rounded-lg border-2 border-border overflow-hidden bg-muted flex items-center justify-center">
                    {logoPreview ? (
                      <img
                        src={logoPreview}
                        alt="Logo preview"
                        className="object-cover w-full h-full"
                      />
                    ) : logoUrl ? (
                      <img
                        src={`${logoUrl}${logoUrl.includes('?') ? '&' : '?'}t=${Date.now()}`}
                        alt="Restaurant logo"
                        className="object-cover w-full h-full"
                        onError={() => {
                          console.warn('[SETTINGS] logo image failed to load', logoUrl)
                          setLogoLoadFailed(true)
                        }}
                      />
                    ) : null}
                  </div>
                  <Button
                    variant="destructive"
                    size="icon"
                    className="absolute -top-2 -right-2 h-6 w-6 rounded-full"
                    onClick={handleRemoveLogo}
                    disabled={uploadingLogo || savingDetails}
                  >
                    <X className="h-4 w-4" />
                  </Button>
                </div>
              )}

              {logoUrl && logoLoadFailed && !logoPreview && (
                <p className="text-sm text-amber-700 dark:text-amber-400">
                  The saved logo could not be loaded. Upload a new image below to replace it.
                </p>
              )}

              {/* Upload Button */}
              <div className="flex items-center gap-4">
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/jpeg,image/jpg,image/png,image/webp"
                  onChange={(e) => {
                    const file = e.target.files?.[0]
                    if (file) {
                      handleLogoUpload(file)
                    }
                  }}
                  className="hidden"
                  disabled={uploadingLogo || savingDetails}
                />
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={uploadingLogo || savingDetails}
                >
                  <Upload className="h-4 w-4 mr-2" />
                  {uploadingLogo ? 'Uploading...' : logoUrl ? 'Replace Logo' : 'Upload Logo'}
                </Button>
                <p className="text-sm text-muted-foreground">
                  JPG, PNG, or WebP. Max 2MB.
                </p>
              </div>
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="finatic_merchant_no">Finatic Merchant Number</Label>
            <Input
              id="finatic_merchant_no"
              value={finaticMerchantNo}
              onChange={(e) => setFinaticMerchantNo(e.target.value)}
              placeholder="e.g. 342600032359"
              disabled={savingDetails}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="finatic_store_no">Finatic Store Number</Label>
            <Input
              id="finatic_store_no"
              value={finaticStoreNo}
              onChange={(e) => setFinaticStoreNo(e.target.value)}
              placeholder="e.g. 4426012791"
              disabled={savingDetails}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="finatic_terminal_sn">Finatic Terminal Serial Number</Label>
            <Input
              id="finatic_terminal_sn"
              value={finaticTerminalSn}
              onChange={(e) => setFinaticTerminalSn(e.target.value)}
              placeholder="e.g. WPYB002349003019"
              disabled={savingDetails}
            />
            <p className="text-xs text-muted-foreground">
              Terminal serial number is restaurant-specific and must be configured per restaurant.
            </p>
          </div>

          {/* Save Button */}
          <div className="pt-4 border-t">
            <Button
              onClick={handleSaveDetails}
              disabled={savingDetails || !detailsChanged || uploadingLogo}
              className="w-full bg-[#FF6B35] hover:bg-[#e55a28]"
              size="lg"
            >
              <Save className="h-4 w-4 mr-2" />
              {savingDetails ? 'Saving...' : 'Save Details'}
            </Button>
          </div>
        </div>

        {/* Payment Settings Section */}
        <div className="bg-card border rounded-lg p-6 space-y-6">
          <div>
            <h2 className="text-xl font-semibold mb-2">Payment Methods</h2>
            <p className="text-sm text-muted-foreground mb-6">
              Enable or disable payment methods for your restaurant. At least one method must be enabled.
            </p>
          </div>

          {/* Cash Payment */}
          <div className="flex items-center justify-between p-4 border rounded-lg">
            <div className="flex items-center gap-4">
              <div className="w-12 h-12 rounded-lg bg-orange-100 flex items-center justify-center">
                <Banknote className="h-6 w-6 text-orange-600" />
              </div>
              <div>
                <Label htmlFor="cash" className="text-base font-semibold cursor-pointer">
                  Cash Payment
                </Label>
                <p className="text-sm text-muted-foreground">
                  Customers pay with cash at their table
                </p>
              </div>
            </div>
            <Switch
              id="cash"
              checked={cashEnabled}
              onCheckedChange={setCashEnabled}
              disabled={!cardEnabled && cashEnabled} // Can't disable if it's the only one
            />
          </div>

          {/* Card Payment */}
          <div className="flex items-center justify-between p-4 border rounded-lg">
            <div className="flex items-center gap-4">
              <div className="w-12 h-12 rounded-lg bg-blue-100 flex items-center justify-center">
                <CreditCard className="h-6 w-6 text-blue-600" />
              </div>
              <div>
                <Label htmlFor="card" className="text-base font-semibold cursor-pointer">
                  Card Payment
                </Label>
                <p className="text-sm text-muted-foreground">
                  Waiter will bring card machine to customer's table
                </p>
              </div>
            </div>
            <Switch
              id="card"
              checked={cardEnabled}
              onCheckedChange={setCardEnabled}
              disabled={!cashEnabled && cardEnabled} // Can't disable if it's the only one
            />
          </div>

          {/* Info Message */}
          {(!cashEnabled || !cardEnabled) && (
            <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4">
              <p className="text-sm text-yellow-900">
                <strong>Note:</strong> Only the enabled payment method(s) will be shown to customers during checkout.
              </p>
            </div>
          )}

          {/* Save Button */}
          <div className="pt-4 border-t">
            <Button
              onClick={handleSavePayment}
              disabled={savingPayment}
              className="w-full bg-[#FF6B35] hover:bg-[#e55a28]"
              size="lg"
            >
              <Save className="h-4 w-4 mr-2" />
              {savingPayment ? 'Saving...' : 'Save Payment Settings'}
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}

export default function SettingsPage() {
  return <SettingsContent />
}

