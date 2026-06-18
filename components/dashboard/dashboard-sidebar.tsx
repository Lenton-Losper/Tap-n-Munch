'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import {
  BarChart3,
  ClipboardList,
  History,
  Settings,
  Table2,
  UtensilsCrossed,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { ReportBugButton } from '@/components/dashboard/report-bug-dialog'

const NAV_ITEMS = [
  { href: '/dashboard', label: 'Live Orders', icon: ClipboardList, match: (path: string) => path === '/dashboard' },
  {
    href: '/dashboard/order-history',
    label: 'Order History',
    icon: History,
    match: (path: string) => path.startsWith('/dashboard/order-history'),
  },
  { href: '/qr-codes', label: 'Tables', icon: Table2, match: (path: string) => path.startsWith('/qr-codes') },
  {
    href: '/menu-management',
    label: 'Menu Management',
    icon: UtensilsCrossed,
    match: (path: string) => path.startsWith('/menu-management'),
  },
  { href: '/analytics', label: 'Analytics', icon: BarChart3, match: (path: string) => path.startsWith('/analytics') },
  { href: '/settings', label: 'Settings', icon: Settings, match: (path: string) => path.startsWith('/settings') },
]

export function DashboardSidebar() {
  const pathname = usePathname()

  return (
    <aside className="flex h-full w-56 shrink-0 flex-col border-r border-[#E9E9E7] bg-white">
      <div className="border-b border-[#E9E9E7] px-4 py-5">
        <Link href="/dashboard" className="font-serif text-lg font-semibold text-[#37352F]">
          FlashTap
        </Link>
        <p className="mt-0.5 text-xs text-[#6B675F]">Venue dashboard</p>
      </div>

      <nav className="flex flex-1 flex-col gap-1 overflow-y-auto p-3">
        {NAV_ITEMS.map((item) => {
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
        })}
      </nav>

      <div className="mt-auto border-t border-[#E9E9E7] p-3">
        <ReportBugButton />
      </div>
    </aside>
  )
}
