'use client'
import { useEffect, useState } from 'react'
import { useParams } from 'next/navigation'
import { TabProvider } from '@/contexts/tab-context'
import { RestaurantProvider } from '@/contexts/restaurant-context'
import { FeatureProvider, RestaurantFeatures } from '@/contexts/feature-context'

export default function MenuLayout({ children }: { children: React.ReactNode }) {
  const params = useParams()
  const restaurantId = params.restaurantId as string

  const [features, setFeatures] = useState<RestaurantFeatures | undefined>(undefined)

  useEffect(() => {
    if (!restaurantId) return
    fetch(`/api/menu/${restaurantId}/features`)
      .then(r => r.json())
      .then(data => { if (data.features) setFeatures(data.features) })
      .catch(() => {})
  }, [restaurantId])

  return (
    <FeatureProvider features={features}>
      <RestaurantProvider restaurantId={restaurantId}>
        <TabProvider restaurantId={restaurantId}>{children}</TabProvider>
      </RestaurantProvider>
    </FeatureProvider>
  )
}
