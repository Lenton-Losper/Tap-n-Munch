export const dynamic = 'force-dynamic'

import { AnalyticsContent } from '@/components/analytics/analytics-content'
import { requireAnalyticsPermission } from '@/lib/analytics/auth'
import { PERMISSIONS } from '@/lib/permissions'

export default async function AnalyticsPage() {
  await requireAnalyticsPermission(PERMISSIONS.ANALYTICS_VIEW)
  return <AnalyticsContent />
}
