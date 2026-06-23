export const dynamic = "force-dynamic";

import { MenuManagementV2 as MenuManagement } from "@/components/menu-management-v2"
import { RoleGuard } from "@/components/auth/role-guard"

export default function MenuManagementPage() {
  return (
    <RoleGuard allowedRoles={['owner', 'manager']}>
      <MenuManagement />
    </RoleGuard>
  )
}
