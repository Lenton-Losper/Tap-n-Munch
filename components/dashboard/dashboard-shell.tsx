'use client'

import { DashboardSidebar } from '@/components/dashboard/dashboard-sidebar'
import { SetupChecklistBanner } from '@/components/dashboard/setup-checklist-banner'
import { Toaster } from '@/components/ui/toaster'

export function DashboardShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen bg-[#F7F6F3]">
      <DashboardSidebar />
      <main className="min-w-0 flex-1">
        <SetupChecklistBanner />
        {children}
      </main>
      <Toaster />
    </div>
  )
}
