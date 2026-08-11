'use client'

import { DashboardSidebar } from '@/components/dashboard/dashboard-sidebar'
import { SetupChecklistBanner } from '@/components/dashboard/setup-checklist-banner'

// The <Toaster /> that used to sit here moved to app/providers.tsx in #204, so that customer
// routes get one too. It is NOT re-added here: hooks/use-toast.ts is a single module-level store,
// every staff route is already a descendant of AppProviders, and a second viewport would render
// every admin toast twice. ToastViewport is `fixed`, so nothing about the position changed.

export function DashboardShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen bg-[#F7F6F3]">
      <DashboardSidebar />
      <main className="min-w-0 flex-1">
        <SetupChecklistBanner />
        {children}
      </main>
    </div>
  )
}
