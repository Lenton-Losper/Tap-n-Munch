import { StaffPageContent } from '@/components/staff/staff-page-content'
import { requireStaffPermission } from '@/lib/staff/auth'
import { PERMISSIONS } from '@/lib/permissions'

export const dynamic = 'force-dynamic'

export default async function StaffPage() {
  await requireStaffPermission(PERMISSIONS.STAFF_MANAGE)
  return <StaffPageContent />
}
