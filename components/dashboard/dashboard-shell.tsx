'use client'

import { DashboardSidebar } from '@/components/dashboard/dashboard-sidebar'

export function DashboardShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen bg-[#F7F6F3]">
      <DashboardSidebar />
      <main className="min-w-0 flex-1">{children}</main>
    </div>
  )
}
