'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'
import type { InventorySetupData } from '@/lib/recipes/queries'

export function InventorySetupBanner({
  setup,
  filterActive = false,
}: {
  setup: InventorySetupData
  filterActive?: boolean
}) {
  const router = useRouter()

  if (setup.missing <= 0) {
    return null
  }

  return (
    <div className="mb-6 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-4 sm:px-5">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="space-y-1">
          <h2 className="font-serif text-lg font-semibold text-[#37352F]">Inventory Setup</h2>
          <p className="text-sm text-[#6B675F]">
            {setup.configured} of {setup.total} menu items automatically deduct stock.
          </p>
          <p className="text-sm text-amber-900">
            {setup.missing} {setup.missing === 1 ? 'item still needs' : 'items still need'} ingredients
            configured.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {filterActive ? (
            <Button
              type="button"
              variant="outline"
              className="border-[#E9E9E7] bg-white"
              onClick={() => router.push('/menu-management')}
            >
              Show all items
            </Button>
          ) : (
            <Button
              type="button"
              className="bg-[#FF6B35] text-white hover:bg-[#e85f2f]"
              onClick={() => router.push('/menu-management?missingInventory=true')}
            >
              Configure Missing Items
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}

export function InventorySetupStockCard({
  setup,
}: {
  setup: InventorySetupData
}) {
  return (
    <Link
      href="/menu-management?missingInventory=true"
      className="block rounded-2xl border border-[#E9E9E7] bg-white p-5 transition-colors hover:border-[#FF6B35]/40 hover:bg-[#FFFBF9]"
    >
      <p className="text-xs font-medium uppercase tracking-wide text-[#6B675F]">Inventory Setup</p>
      <p className="mt-2 font-serif text-3xl font-semibold text-[#37352F]">
        {setup.configured}/{setup.total}
      </p>
      <p className="mt-1 text-sm text-[#6B675F]">configured</p>
      <p className="mt-3 text-sm font-medium text-[#FF6B35]">View →</p>
    </Link>
  )
}
