import { RolesPageContent } from '@/components/staff/roles-page-content'
import { requireStaffPermission } from '@/lib/staff/auth'
import { PERMISSIONS } from '@/lib/permissions'

export const dynamic = 'force-dynamic'

export default async function StaffRolesPage() {
  await requireStaffPermission(PERMISSIONS.STAFF_MANAGE)
  return <RolesPageContent />
}
