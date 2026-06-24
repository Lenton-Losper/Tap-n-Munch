'use client'

import { TabProvider } from '@/contexts/tab-context'
import { useParams } from 'next/navigation'

export default function MenuLayout({ children }: { children: React.ReactNode }) {
  const params = useParams()
  const restaurantId = params.restaurantId as string

  return <TabProvider restaurantId={restaurantId}>{children}</TabProvider>
}
