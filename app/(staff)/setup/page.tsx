import { SetupStatusPageContent } from '@/components/setup/setup-status-page-content'
import { requireStaffPermission } from '@/lib/staff/auth'
import { PERMISSIONS } from '@/lib/permissions'

export const dynamic = 'force-dynamic'

export default async function SetupStatusPage() {
  await requireStaffPermission(PERMISSIONS.SETTINGS_READ)
  return <SetupStatusPageContent />
}
