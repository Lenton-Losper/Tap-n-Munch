'use client'

import dynamic from 'next/dynamic'
import { usePathname } from 'next/navigation'
import { CartProvider } from '@/contexts/cart-context'

const DynamicAuthProvider = dynamic(
  () => import('@/components/auth/auth-provider').then((mod) => mod.AuthProvider),
  { ssr: false }
)

function isPublicMarketingRoute(pathname: string) {
  return pathname === '/' || pathname === '/contact'
}

export function AppProviders({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()

  // Keep auth initialization off public marketing routes.
  if (isPublicMarketingRoute(pathname)) {
    return <CartProvider>{children}</CartProvider>
  }

  return (
    <DynamicAuthProvider>
      <CartProvider>{children}</CartProvider>
    </DynamicAuthProvider>
  )
}

