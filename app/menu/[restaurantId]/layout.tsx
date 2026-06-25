'use client'

import { TabProvider } from '@/contexts/tab-context'
import { RestaurantProvider } from '@/contexts/restaurant-context'
import { useParams } from 'next/navigation'

export default function MenuLayout({ children }: { children: React.ReactNode }) {
  const params = useParams()
  const restaurantId = params.restaurantId as string

  return (
    <RestaurantProvider restaurantId={restaurantId}>
      <TabProvider restaurantId={restaurantId}>{children}</TabProvider>
    </RestaurantProvider>
  )
}
