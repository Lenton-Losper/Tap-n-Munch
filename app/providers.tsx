'use client'

import dynamic from 'next/dynamic'
import { usePathname } from 'next/navigation'
import { CartProvider } from '@/contexts/cart-context'
import { TabProvider } from '@/contexts/tab-context'

const DynamicAuthProvider = dynamic(
  () => import('@/components/auth/auth-provider').then((mod) => mod.AuthProvider),
  { ssr: false }
)

function isPublicMarketingRoute(pathname: string, isRivieraSubdomain: boolean) {
  if (isRivieraSubdomain) return false
  return pathname === '/' || pathname === '/contact'
}

export function AppProviders({
  children,
  isRivieraSubdomain = false,
}: {
  children: React.ReactNode
  isRivieraSubdomain?: boolean
}) {
  const pathname = usePathname()

  // Keep auth initialization off public marketing routes.
  if (isPublicMarketingRoute(pathname, isRivieraSubdomain)) {
    return <CartProvider>{children}</CartProvider>
  }

  return (
    <DynamicAuthProvider>
      <TabProvider>
        <CartProvider>{children}</CartProvider>
      </TabProvider>
    </DynamicAuthProvider>
  )
}

