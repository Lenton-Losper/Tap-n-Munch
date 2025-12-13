import { AnalyticsDashboard } from "@/components/analytics-dashboard"
import { ProtectedRoute } from "@/components/auth/protected-route"

export default function AnalyticsPage() {
  return (
    <ProtectedRoute>
      <AnalyticsDashboard />
    </ProtectedRoute>
  )
}
