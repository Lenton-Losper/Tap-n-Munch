'use client'
import { createContext, useContext, useEffect, useState, useCallback } from 'react'
import { supabase } from '@/lib/supabase/client'

interface Restaurant {
  id: string
  name: string
  phone: string | null
  logo_url: string | null
  owner_id: string
}

interface RestaurantSettings {
  payment_methods: string[]
  kiosk_payment_methods?: string[]
  hasKiosk?: boolean
  tab_pin_required: boolean
  max_tab_hours: number
  allow_split_bill: boolean
  currency: string
  timezone: string
  tax_rate: number
  service_charge: number
  settings_version?: number
}

interface RestaurantPermissions {
  canCreateTab: boolean
  canSplitBill: boolean
  canPayCash: boolean
  canPayCard: boolean
}

interface RestaurantContextType {
  restaurantId: string | null
  restaurant: Restaurant | null
  settings: RestaurantSettings | null
  permissions: RestaurantPermissions
  currency: string
  paymentMethods: string[]
  hasKiosk: boolean
  kioskPaymentMethods: string[]
  tabPinRequired: boolean
  maxTabHours: number
  settingsVersion: number
  loading: boolean
  refresh: () => Promise<void>
}

const defaultPermissions: RestaurantPermissions = {
  canCreateTab: true,
  canSplitBill: false,
  canPayCash: true,
  canPayCard: true,
}

const RestaurantContext = createContext<RestaurantContextType>({
  restaurantId: null,
  restaurant: null,
  settings: null,
  permissions: defaultPermissions,
  currency: 'NAD',
  paymentMethods: ['cash', 'card'],
  hasKiosk: false,
  kioskPaymentMethods: ['cash', 'card', 'other'],
  tabPinRequired: true,
  maxTabHours: 8,
  settingsVersion: 1,
  loading: true,
  refresh: async () => {},
})

export function RestaurantProvider({
  children,
  restaurantId,
}: {
  children: React.ReactNode
  restaurantId: string
}) {
  const [restaurant, setRestaurant] = useState<Restaurant | null>(null)
  const [settings, setSettings] = useState<RestaurantSettings | null>(null)
  const [settingsVersion, setSettingsVersion] = useState(1)
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    if (!restaurantId) return
    try {
      const [restaurantResult, settingsRes] = await Promise.all([
        supabase
          .from('restaurants')
          .select('id, name, phone, logo_url, owner_id')
          .eq('id', restaurantId)
          .maybeSingle(),
        fetch(`/api/admin/restaurants/${restaurantId}/settings`),
      ])
      const settingsPayload = await settingsRes.json().catch(() => ({}))
      const settingsData = settingsPayload?.settings ?? null
      if (restaurantResult.data) setRestaurant(restaurantResult.data)
      if (settingsData) setSettings(settingsData)
      const version = settingsData?.settings_version ?? 1
      setSettingsVersion(version)
    } catch (err) {
      console.error('[RestaurantContext] failed to load:', err)
    } finally {
      setLoading(false)
    }
  }, [restaurantId])

  useEffect(() => {
    load()
  }, [load])

  const paymentMethods = settings?.payment_methods ?? ['cash', 'card']
  const kioskPaymentMethods = settings?.kiosk_payment_methods ?? ['cash', 'card', 'other']
  const hasKiosk = settings?.hasKiosk ?? false
  const tabPinRequired = settings?.tab_pin_required ?? true
  const maxTabHours = settings?.max_tab_hours ?? 8
  const currency = settings?.currency ?? 'NAD'

  const permissions: RestaurantPermissions = {
    canCreateTab: true,
    canSplitBill: settings?.allow_split_bill ?? false,
    canPayCash: paymentMethods.includes('cash'),
    canPayCard: paymentMethods.includes('card'),
  }

  return (
    <RestaurantContext.Provider
      value={{
        restaurantId,
        restaurant,
        settings,
        permissions,
        currency,
        paymentMethods,
        hasKiosk,
        kioskPaymentMethods,
        tabPinRequired,
        maxTabHours,
        settingsVersion,
        loading,
        refresh: load,
      }}
    >
      {children}
    </RestaurantContext.Provider>
  )
}

export function useRestaurant() {
  return useContext(RestaurantContext)
}
