import { MenuManagementV2 as MenuManagement } from "@/components/menu-management-v2"
import { ProtectedRoute } from "@/components/auth/protected-route"

export default function MenuManagementPage() {
  return (
    <ProtectedRoute>
      <MenuManagement />
    </ProtectedRoute>
  )
}
