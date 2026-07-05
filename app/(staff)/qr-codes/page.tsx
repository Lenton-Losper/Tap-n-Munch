export const dynamic = 'force-dynamic'

import { OrderingChannelsContentWithSuspense } from '@/components/ordering-channels/ordering-channels-content'
import { requireTablesPermission } from '@/lib/tables/auth'
import { PERMISSIONS } from '@/lib/permissions'

export default async function QRCodesPage() {
  await requireTablesPermission(PERMISSIONS.TABLES_READ)
  return <OrderingChannelsContentWithSuspense />
}
