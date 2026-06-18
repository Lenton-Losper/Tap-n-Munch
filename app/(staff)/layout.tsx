import { ProtectedRoute } from '@/components/auth/protected-route'
import { DashboardShell } from '@/components/dashboard/dashboard-shell'

export default function StaffLayout({ children }: { children: React.ReactNode }) {
  return (
    <ProtectedRoute>
      <DashboardShell>{children}</DashboardShell>
    </ProtectedRoute>
  )
}
