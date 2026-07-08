'use client'

import { useEffect, useState } from 'react'
import { cn } from '@/lib/utils'
import { usePermissions } from '@/hooks/use-permissions'
import { PERMISSIONS } from '@/lib/permissions'
import { SETTINGS_BRAND_PRIMARY, SETTINGS_TABS, type SettingsTabId } from '@/components/settings/constants'
import { SettingsProfileTab } from '@/components/settings/settings-profile-tab'
import { SettingsPaymentTab } from '@/components/settings/settings-payment-tab'
import { SettingsBillingTab } from '@/components/settings/settings-billing-tab'
import { SettingsRestaurantTab } from '@/components/settings/settings-restaurant-tab'
import { SettingsSignInMethodsSection } from '@/components/settings/settings-sign-in-methods-section'
import { hashToSettingsTab } from '@/components/settings/settings-utils'

export function SettingsContent() {
  const { hasPermission, permissionsLoaded } = usePermissions()
  const [activeTab, setActiveTab] = useState<SettingsTabId>(() =>
    typeof window !== 'undefined' ? hashToSettingsTab(window.location.hash) : 'profile',
  )

  const canViewPayments = !permissionsLoaded || hasPermission(PERMISSIONS.PAYMENTS_VIEW)
  const canViewBilling = !permissionsLoaded || hasPermission(PERMISSIONS.DOCUMENTS_READ)
  const visibleTabs = SETTINGS_TABS.filter(
    (tab) =>
      (tab.id !== 'bank' || canViewPayments) && (tab.id !== 'billing' || canViewBilling),
  )

  const effectiveActiveTab: SettingsTabId =
    activeTab === 'bank' && permissionsLoaded && !hasPermission(PERMISSIONS.PAYMENTS_VIEW)
      ? 'profile'
      : activeTab === 'billing' && permissionsLoaded && !hasPermission(PERMISSIONS.DOCUMENTS_READ)
        ? 'profile'
        : activeTab

  useEffect(() => {
    const onHashChange = () => {
      setActiveTab(hashToSettingsTab(window.location.hash))
    }
    window.addEventListener('hashchange', onHashChange)
    return () => window.removeEventListener('hashchange', onHashChange)
  }, [])

  useEffect(() => {
    if (!permissionsLoaded) return
    if (activeTab === 'bank' && !hasPermission(PERMISSIONS.PAYMENTS_VIEW)) {
      if (typeof window !== 'undefined' && window.location.hash === '#bank') {
        window.history.replaceState(null, '', '#profile')
      }
    }
    if (activeTab === 'billing' && !hasPermission(PERMISSIONS.DOCUMENTS_READ)) {
      if (typeof window !== 'undefined' && window.location.hash === '#billing') {
        window.history.replaceState(null, '', '#profile')
      }
    }
  }, [activeTab, hasPermission, permissionsLoaded])

  const navigateToTab = (tabId: SettingsTabId, hash: string) => {
    if (tabId === 'bank' && permissionsLoaded && !hasPermission(PERMISSIONS.PAYMENTS_VIEW)) {
      return
    }
    if (tabId === 'billing' && permissionsLoaded && !hasPermission(PERMISSIONS.DOCUMENTS_READ)) {
      return
    }
    setActiveTab(tabId)
    if (typeof window !== 'undefined' && window.location.hash !== hash) {
      window.history.replaceState(null, '', hash)
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
          {visibleTabs.map((tab) => {
            const isActive = effectiveActiveTab === tab.id
            return (
              <button
                key={tab.id}
                type="button"
                onClick={() => navigateToTab(tab.id, tab.hash)}
                className={cn(
                  'rounded-t-md px-4 py-2.5 text-sm font-medium transition-colors',
                  isActive
                    ? 'border-b-2 text-foreground'
                    : 'text-muted-foreground hover:text-foreground',
                )}
                style={isActive ? { borderBottomColor: SETTINGS_BRAND_PRIMARY } : undefined}
                aria-current={isActive ? 'page' : undefined}
              >
                {tab.label}
              </button>
            )
          })}
        </nav>

        {effectiveActiveTab === 'profile' ? (
          <div className="space-y-6">
            <SettingsProfileTab />
            <SettingsSignInMethodsSection />
          </div>
        ) : null}
        {effectiveActiveTab === 'bank' && canViewPayments ? <SettingsPaymentTab /> : null}
        {effectiveActiveTab === 'billing' && canViewBilling ? <SettingsBillingTab /> : null}
        {effectiveActiveTab === 'restaurant' ? <SettingsRestaurantTab /> : null}
      </div>
    </div>
  )
}
