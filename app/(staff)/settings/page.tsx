'use client'

export const dynamic = 'force-dynamic'

import { useCallback, useEffect, useState } from 'react'
import { RoleGuard } from '@/components/auth/role-guard'
import { cn } from '@/lib/utils'
import { SETTINGS_BRAND_PRIMARY, SETTINGS_TABS, type SettingsTabId } from '@/components/settings/constants'
import { SettingsProfileTab } from '@/components/settings/settings-profile-tab'
import { SettingsPaymentTab } from '@/components/settings/settings-payment-tab'
import { SettingsRestaurantTab } from '@/components/settings/settings-restaurant-tab'
import { hashToSettingsTab } from '@/components/settings/settings-utils'

function SettingsContent() {
  const [activeTab, setActiveTab] = useState<SettingsTabId>('profile')

  const syncTabFromHash = useCallback(() => {
    setActiveTab(hashToSettingsTab(window.location.hash))
  }, [])

  useEffect(() => {
    syncTabFromHash()
    window.addEventListener('hashchange', syncTabFromHash)
    return () => window.removeEventListener('hashchange', syncTabFromHash)
  }, [syncTabFromHash])

  const navigateToTab = (tabId: SettingsTabId, hash: string) => {
    setActiveTab(tabId)
    if (window.location.hash !== hash) {
      window.location.hash = hash
    }
  }

  return (
    <div className="px-6 py-8 lg:px-10">
      <div className="mx-auto max-w-3xl">
        <header className="mb-8">
          <h1 className="text-3xl font-bold tracking-tight">Settings</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Manage your profile, payments, and restaurant details.
          </p>
        </header>

        <nav
          className="mb-8 flex flex-wrap gap-2 border-b border-border pb-1"
          aria-label="Settings sections"
        >
          {SETTINGS_TABS.map((tab) => {
            const isActive = activeTab === tab.id
            return (
              <button
                key={tab.id}
                type="button"
                onClick={() => navigateToTab(tab.id, tab.hash)}
                className={cn(
                  'rounded-t-md px-4 py-2.5 text-sm font-medium transition-colors',
                  isActive
                    ? 'border-b-2 text-foreground'
                    : 'text-muted-foreground hover:text-foreground'
                )}
                style={isActive ? { borderBottomColor: SETTINGS_BRAND_PRIMARY } : undefined}
                aria-current={isActive ? 'page' : undefined}
              >
                {tab.label}
              </button>
            )
          })}
        </nav>

        {activeTab === 'profile' ? <SettingsProfileTab /> : null}
        {activeTab === 'bank' ? <SettingsPaymentTab /> : null}
        {activeTab === 'restaurant' ? <SettingsRestaurantTab /> : null}
      </div>
    </div>
  )
}

export default function SettingsPage() {
  return (
    <RoleGuard allowedRoles={['owner']}>
      <SettingsContent />
    </RoleGuard>
  )
}
