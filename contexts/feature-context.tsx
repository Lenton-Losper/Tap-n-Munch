'use client'
import { createContext, useContext } from 'react'

export interface RestaurantFeatures {
  kitchen_enabled: boolean
  inventory_enabled: boolean
  analytics_enabled: boolean
  split_bill_enabled: boolean
  reservations_enabled: boolean
  loyalty_enabled: boolean
  online_payments_enabled: boolean
  multi_branch_enabled: boolean
  staff_app_enabled: boolean
  kiosk_enabled: boolean
  whatsapp_enabled: boolean
  station_screens_enabled: boolean
}

export interface FeatureContextType {
  features: RestaurantFeatures
  subscriptionPlan: string | null
  subscriptionStatus: string | null
  hasFeature: (key: keyof RestaurantFeatures) => boolean
}

const defaultFeatures: RestaurantFeatures = {
  kitchen_enabled: false,
  inventory_enabled: false,
  analytics_enabled: false,
  split_bill_enabled: false,
  reservations_enabled: false,
  loyalty_enabled: false,
  online_payments_enabled: false,
  multi_branch_enabled: false,
  staff_app_enabled: false,
  kiosk_enabled: false,
  whatsapp_enabled: false,
  station_screens_enabled: false,
}

const FeatureContext = createContext<FeatureContextType>({
  features: defaultFeatures,
  subscriptionPlan: null,
  subscriptionStatus: null,
  hasFeature: () => false,
})

export function FeatureProvider({
  children,
  features = defaultFeatures,
  subscriptionPlan = null,
  subscriptionStatus = null,
}: {
  children: React.ReactNode
  features?: RestaurantFeatures
  subscriptionPlan?: string | null
  subscriptionStatus?: string | null
}) {
  const hasFeature = (key: keyof RestaurantFeatures) => features[key] === true

  return (
    <FeatureContext.Provider
      value={{ features, subscriptionPlan, subscriptionStatus, hasFeature }}
    >
      {children}
    </FeatureContext.Provider>
  )
}

export function useFeatures() {
  return useContext(FeatureContext)
}
