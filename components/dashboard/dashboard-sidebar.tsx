'use client'

import { useState } from 'react'
import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import {
  BarChart3,
  ClipboardList,
  FileText,
  History,
  LogOut,
  Package,
  Settings,
  Table2,
  Users,
  UtensilsCrossed,
  type LucideIcon,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { ReportBugButton } from '@/components/dashboard/report-bug-dialog'
import { useAuth, type StaffRole } from '@/components/auth/auth-provider'
import { usePermissions } from '@/hooks/use-permissions'
import { PERMISSIONS, type Permission } from '@/lib/permissions'

type NavItem = {
  href: string
  label: string
  icon: LucideIcon
  permission: Permission
  match: (path: string) => boolean
}

const NAV_ITEMS: NavItem[] = [
  {
    href: '/dashboard',
    label: 'Live Orders',
    icon: ClipboardList,
    permission: PERMISSIONS.ORDERS_READ,
    match: (path: string) => path === '/dashboard',
  },
  {
    href: '/dashboard/order-history',
    label: 'Order History',
    icon: History,
    permission: PERMISSIONS.ORDERS_READ,
    match: (path: string) => path.startsWith('/dashboard/order-history'),
  },
  {
    href: '/qr-codes',
    label: 'Ordering Channels',
    icon: Table2,
    permission: PERMISSIONS.TABLES_READ,
    match: (path: string) => path.startsWith('/qr-codes'),
  },
  {
    href: '/menu-management',
    label: 'Menu Management',
    icon: UtensilsCrossed,
    permission: PERMISSIONS.MENU_READ,
    match: (path: string) => path.startsWith('/menu-management'),
  },
  {
    href: '/staff',
    label: 'Staff',
    icon: Users,
    permission: PERMISSIONS.STAFF_MANAGE,
    match: (path: string) => path.startsWith('/staff'),
  },
  {
    href: '/analytics',
    label: 'Analytics',
    icon: BarChart3,
    permission: PERMISSIONS.ANALYTICS_VIEW,
    match: (path: string) => path.startsWith('/analytics'),
  },
  {
    href: '/documents',
    label: 'Documents',
    icon: FileText,
    permission: PERMISSIONS.DOCUMENTS_READ,
    match: (path: string) => path.startsWith('/documents'),
  },
  {
    href: '/stock',
    label: 'Stock',
    icon: Package,
    permission: PERMISSIONS.STOCK_VIEW,
    match: (path: string) => path.startsWith('/stock'),
  },
  {
    href: '/settings',
    label: 'Settings',
    icon: Settings,
    permission: PERMISSIONS.SETTINGS_READ,
    match: (path: string) => path.startsWith('/settings'),
  },
]

const ROLE_LABELS: Record<StaffRole, string> = {
  owner: 'Owner',
  manager: 'Manager',
  cashier: 'Cashier',
  waiter: 'Waiter',
  kitchen: 'Kitchen',
  bar: 'Bar',
}

export function DashboardSidebar() {
  const pathname = usePathname()
  const router = useRouter()
  const { userData, restaurant, role, signOut } = useAuth()
  const { hasPermission, permissionsLoaded } = usePermissions()
  const [signingOut, setSigningOut] = useState(false)

  const restaurantName = String(restaurant?.name || '').trim()
  const displayName = String(userData?.full_name || userData?.name || '').trim()

  const handleSignOut = async () => {
    setSigningOut(true)
    try {
      await signOut()
      router.replace('/signin')
    } catch {
      setSigningOut(false)
    }
  }

  const visibleItems = permissionsLoaded
    ? NAV_ITEMS.filter((item) => hasPermission(item.permission))
    : []

  return (
    <aside className="flex h-full w-56 shrink-0 flex-col border-r border-[#E9E9E7] bg-white">
      <div className="border-b border-[#E9E9E7] px-4 py-5">
        <Link href="/dashboard" className="font-serif text-lg font-semibold text-[#37352F]">
          FlashTap
        </Link>
        {restaurantName ? (
          <p className="mt-0.5 text-xs text-[#6B675F]">{restaurantName}</p>
        ) : null}
        {displayName || role ? (
          <div className="mt-3 flex flex-col gap-1.5">
            {displayName ? (
              <p className="truncate text-xs text-[#37352F]" title={displayName}>
                {displayName}
              </p>
            ) : null}
            {role ? (
              <span className="inline-flex w-fit items-center rounded-full border border-[#E9E9E7] bg-[#FAFAF8] px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-[#6B675F]">
                {ROLE_LABELS[role]}
              </span>
            ) : null}
          </div>
        ) : null}
      </div>

      <nav className="flex flex-1 flex-col gap-1 overflow-y-auto p-3">
        {!permissionsLoaded ? (
          <>
            {[1, 2, 3, 4].map((i) => (
              <div
                key={i}
                className="mx-0 h-10 animate-pulse rounded-lg bg-[#F1F0EC]"
                aria-hidden
              />
            ))}
          </>
        ) : (
          visibleItems.map((item) => {
            const active = item.match(pathname)
            const Icon = item.icon
            return (
              <Link
                key={item.href}
                href={item.href}
                className={cn(
                  'flex items-center gap-2.5 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors',
                  active
                    ? 'bg-[#F1F0EC] text-[#37352F]'
                    : 'text-[#6B675F] hover:bg-[#FAFAF8] hover:text-[#37352F]',
                )}
              >
                <Icon className="h-4 w-4 shrink-0" />
                {item.label}
              </Link>
            )
          })
        )}
      </nav>

      <div className="mt-auto space-y-1 border-t border-[#E9E9E7] p-3">
        <ReportBugButton />
        <Button
          type="button"
          variant="ghost"
          onClick={handleSignOut}
          disabled={signingOut}
          className="h-auto w-full justify-start gap-2 rounded-lg px-3 py-2.5 text-sm font-medium text-[#6B675F] hover:bg-[#F1F0EC] hover:text-[#37352F]"
        >
          <LogOut className="h-4 w-4 shrink-0" />
          {signingOut ? 'Signing out...' : 'Sign out'}
        </Button>
      </div>
    </aside>
  )
}
