'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'

export function StockSubNav({ showReceiveButton = false }: { showReceiveButton?: boolean }) {
  const pathname = usePathname()

  const tabs = [
    { href: '/stock', label: 'Overview', match: (path: string) => path === '/stock' },
    {
      href: '/stock/history',
      label: 'Movement history',
      match: (path: string) => path.startsWith('/stock/history'),
    },
  ]

  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <nav className="flex flex-wrap gap-2" aria-label="Stock sections">
        {tabs.map((tab) => {
          const active = tab.match(pathname)
          return (
            <Link
              key={tab.href}
              href={tab.href}
              className={cn(
                'rounded-lg px-3 py-2 text-sm font-medium transition-colors',
                active
                  ? 'bg-[#F1F0EC] text-[#37352F]'
                  : 'text-[#6B675F] hover:bg-[#FAFAF8] hover:text-[#37352F]',
              )}
            >
              {tab.label}
            </Link>
          )
        })}
      </nav>
      {showReceiveButton ? (
        <Button asChild className="bg-[#FF6B35] text-white hover:bg-[#e85f2f]">
          <Link href="/stock/receive">Receive stock</Link>
        </Button>
      ) : null}
    </div>
  )
}
