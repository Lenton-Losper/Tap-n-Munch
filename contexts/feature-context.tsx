'use client'
import { createContext, useContext } from 'react'

export interface RestaurantFeatures {
  kiosk: boolean
  stockControl: boolean
  whatsappBot: boolean
  staffApp: boolean
}

export interface FeatureContextType {
  features: RestaurantFeatures
  subscriptionPlan: string | null
  subscriptionStatus: string | null
  hasFeature: (key: keyof RestaurantFeatures) => boolean
}

const defaultFeatures: RestaurantFeatures = {
  kiosk: false,
  stockControl: false,
  whatsappBot: false,
  staffApp: false,
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
