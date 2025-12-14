export const dynamic = "force-dynamic";

import { OrdersDashboard } from "@/components/orders-dashboard"
import { ProtectedRoute } from "@/components/auth/protected-route"

export default function DashboardPage() {
  return (
    <ProtectedRoute>
      <OrdersDashboard />
    </ProtectedRoute>
  )
}
