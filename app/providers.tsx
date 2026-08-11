'use client'

import dynamic from 'next/dynamic'
import { usePathname } from 'next/navigation'
import { CartProvider } from '@/contexts/cart-context'
import { Toaster } from '@/components/ui/toaster'

const DynamicAuthProvider = dynamic(
  () => import('@/components/auth/auth-provider').then((mod) => mod.AuthProvider),
  { ssr: false }
)

function isPublicMarketingRoute(pathname: string, isRivieraSubdomain: boolean) {
  if (isRivieraSubdomain) return false
  return pathname === '/' || pathname === '/contact'
}

/*
 * #204 — the toast viewport lives here, once, for the whole app.
 *
 * It used to live only in components/dashboard/dashboard-shell.tsx, so no route under
 * app/menu/** was ever a descendant of it and every toast() a customer could trigger dispatched
 * into hooks/use-toast.ts's store and rendered nowhere. Both branches below mount it: the
 * marketing early-return is still a page that can raise one, and a viewport on only one side of
 * that branch is the same silent no-op in a smaller box.
 *
 * It is mounted exactly ONCE on purpose. hooks/use-toast.ts keeps one module-level store and one
 * listeners array, so a second <Toaster /> anywhere in the tree subscribes to the same state and
 * paints every message twice. That is why the dashboard shell no longer has its own — an admin
 * route is a descendant of this provider too.
 */
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
    return (
      <CartProvider>
        {children}
        <Toaster />
      </CartProvider>
    )
  }

  return (
    <DynamicAuthProvider>
      <CartProvider>
        {children}
        <Toaster />
      </CartProvider>
    </DynamicAuthProvider>
  )
}

