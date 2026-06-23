export const dynamic = "force-dynamic";

import { OrdersDashboard } from "@/components/orders-dashboard"
import { RoleGuard } from "@/components/auth/role-guard"

export default function DashboardPage() {
  return (
    <RoleGuard allowedRoles={['owner', 'manager', 'waiter']}>
      <OrdersDashboard />
    </RoleGuard>
  )
}
