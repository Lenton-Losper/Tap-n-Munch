export const dynamic = 'force-dynamic'

import Link from 'next/link'
import { RoleGuard } from '@/components/auth/role-guard'
import { ReceiveStockForm } from '@/components/stock/receive-stock-form'
import { StockSubNav } from '@/components/stock/stock-sub-nav'
import { requireStockOwner } from '@/lib/stock/auth'
import { getActiveStockItems } from '@/lib/stock/queries'

export default async function ReceiveStockPage() {
  const { supabase, restaurantId } = await requireStockOwner()
  const stockItems = await getActiveStockItems(supabase, restaurantId)

  return (
    <RoleGuard allowedRoles={['owner']}>
      <div className="min-h-screen bg-[#F7F6F3]">
        <div className="border-b border-[#E9E9E7] bg-white px-4 py-6 sm:px-6 lg:px-8">
          <div className="mx-auto max-w-7xl">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <h1 className="font-serif text-3xl font-semibold text-[#37352F]">Receive stock</h1>
                <p className="mt-1 text-sm text-[#6B675F]">
                  Record a new goods received voucher for one delivery.
                </p>
              </div>
              <Link href="/stock" className="text-sm font-medium text-[#6B675F] hover:text-[#37352F]">
                Back to overview
              </Link>
            </div>
            <div className="mt-5">
              <StockSubNav />
            </div>
          </div>
        </div>

        <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:px-8">
          <ReceiveStockForm stockItems={stockItems} />
        </div>
      </div>
    </RoleGuard>
  )
}
