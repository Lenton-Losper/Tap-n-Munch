'use client'

import { TabProvider } from '@/contexts/tab-context'
import { RestaurantProvider } from '@/contexts/restaurant-context'
import { FeatureProvider } from '@/contexts/feature-context'
import { useParams } from 'next/navigation'

export default function MenuLayout({ children }: { children: React.ReactNode }) {
  const params = useParams()
  const restaurantId = params.restaurantId as string

  return (
    <FeatureProvider>
      <RestaurantProvider restaurantId={restaurantId}>
        <TabProvider restaurantId={restaurantId}>{children}</TabProvider>
      </RestaurantProvider>
    </FeatureProvider>
  )
}
