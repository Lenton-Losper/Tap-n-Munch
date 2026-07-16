import { PinsPageContent } from '@/components/staff/pins-page-content'
import { requireStaffPermission } from '@/lib/staff/auth'
import { PERMISSIONS } from '@/lib/permissions'

export const dynamic = 'force-dynamic'

export default async function StaffPinsPage() {
  await requireStaffPermission(PERMISSIONS.TERMINAL_AUTH_MANAGE)
  return <PinsPageContent />
}
