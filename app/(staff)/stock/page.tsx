export const dynamic = 'force-dynamic'

import { RoleGuard } from '@/components/auth/role-guard'
import { StockSubNav } from '@/components/stock/stock-sub-nav'
import { StockOverviewPanel } from '@/components/stock/stock-overview-panel'
import { requireStockOwner } from '@/lib/stock/auth'
import { getStockOverview } from '@/lib/stock/queries'

type StockPageProps = {
  searchParams: Promise<{ received?: string }>
}

export default async function StockPage({ searchParams }: StockPageProps) {
  const { supabase, restaurantId } = await requireStockOwner()
  const data = await getStockOverview(supabase, restaurantId)
  const params = await searchParams
  const receivedCount = params.received ? Number(params.received) : 0
  const successMessage =
    receivedCount > 0
      ? `Delivery recorded. ${receivedCount} items received. Stock updated.`
      : null

  return (
    <RoleGuard allowedRoles={['owner']}>
      <div className="min-h-screen bg-[#F7F6F3]">
        <div className="border-b border-[#E9E9E7] bg-white px-4 py-6 sm:px-6 lg:px-8">
          <div className="mx-auto max-w-7xl">
            <h1 className="font-serif text-3xl font-semibold text-[#37352F]">Stock Management</h1>
            <p className="mt-1 text-sm text-[#6B675F]">
              Track inventory levels and record goods received.
            </p>
            <div className="mt-5">
              <StockSubNav showReceiveButton />
            </div>
          </div>
        </div>

        <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:px-8">
          <StockOverviewPanel data={data} successMessage={successMessage} />
        </div>
      </div>
    </RoleGuard>
  )
}
