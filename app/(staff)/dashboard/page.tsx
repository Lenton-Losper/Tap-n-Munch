export const dynamic = 'force-dynamic'

import { OrdersDashboard } from '@/components/orders-dashboard'
import { requireOrdersPermission } from '@/lib/orders/auth'
import { PERMISSIONS } from '@/lib/permissions'

export default async function DashboardPage() {
  await requireOrdersPermission(PERMISSIONS.ORDERS_READ)
  return <OrdersDashboard />
}
