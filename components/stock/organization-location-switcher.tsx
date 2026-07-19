'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { cn } from '@/lib/utils'

/**
 * Only ever rendered when the caller already passed authorizeOrganization(..., 'view_all_locations')
 * === true for the current user -- see each /stock/transfers* page. Everyone else never receives
 * this component at all, so there's no UI to hide; it simply isn't in the tree.
 */
export function OrganizationLocationSwitcher({ restaurantName }: { restaurantName: string }) {
  const pathname = usePathname()
  const onAllLocations = pathname.startsWith('/stock/transfers/all')

  return (
    <div
      className="flex flex-wrap items-center gap-2 rounded-lg border border-[#E9E9E7] bg-[#FAFAF8] px-3 py-2 text-sm"
      aria-label="Location switcher"
    >
      <span className="text-xs font-medium uppercase tracking-wide text-[#6B675F]">Viewing</span>
      <Link
        href="/stock/transfers"
        className={cn(
          'rounded-md px-2 py-1 font-medium transition-colors',
          !onAllLocations ? 'bg-white text-[#37352F] shadow-sm' : 'text-[#6B675F] hover:text-[#37352F]',
        )}
      >
        {restaurantName} (this location)
      </Link>
      <Link
        href="/stock/transfers/all"
        className={cn(
          'rounded-md px-2 py-1 font-medium transition-colors',
          onAllLocations ? 'bg-white text-[#37352F] shadow-sm' : 'text-[#6B675F] hover:text-[#37352F]',
        )}
      >
        All locations
      </Link>
    </div>
  )
}
