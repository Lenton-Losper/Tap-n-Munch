export const dynamic = 'force-dynamic'

import { OrderHistoryContent } from '@/components/order-history/order-history-content'
import { requireOrdersPermission } from '@/lib/orders/auth'
import { PERMISSIONS } from '@/lib/permissions'

export default async function OrderHistoryPage() {
  await requireOrdersPermission(PERMISSIONS.ORDERS_READ)
  return <OrderHistoryContent />
}
