'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { CheckCircle2, Copy, Plus } from 'lucide-react'
import { useAuth } from '@/components/auth/auth-provider'
import { supabase } from '@/lib/supabase/client'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Switch } from '@/components/ui/switch'
import { useToast } from '@/hooks/use-toast'
import {
  SETTINGS_BRAND_PRIMARY,
  SETTINGS_BRAND_PRIMARY_HOVER,
} from './constants'
import { getSettingsAccessToken } from './settings-utils'
import { onboardingFetch } from '@/lib/onboarding/api-client'
import { usePermissions } from '@/hooks/use-permissions'
import { PERMISSIONS } from '@/lib/permissions'
import { DevicesConsole } from '@/components/devices/devices-console'

export function SettingsPaymentTab() {
  const { restaurantId } = useAuth()
  const { toast } = useToast()
  const { hasPermission, permissionsLoaded } = usePermissions()
  const canConfigure =
    !permissionsLoaded || hasPermission(PERMISSIONS.PAYMENTS_CONFIGURE)
  const [merchantNo, setMerchantNo] = useState('')
  const [storeNo, setStoreNo] = useState('')
  const [paymentMethods, setPaymentMethods] = useState<string[]>(['cash', 'card'])
  const [hasKiosk, setHasKiosk] = useState(false)
  const [kioskMethods, setKioskMethods] = useState<string[]>(['cash', 'card', 'other'])
  const [savingAccount, setSavingAccount] = useState(false)
  const [savingPaymentMethods, setSavingPaymentMethods] = useState(false)
  const [savingKioskMethods, setSavingKioskMethods] = useState(false)
  const [loadingAccount, setLoadingAccount] = useState(true)

  const loadAccount = useCallback(async () => {
    if (!restaurantId) {
      setLoadingAccount(false)
      return
    }
    try {
      setLoadingAccount(true)
      // Finatic columns are not granted to anon; staff JWT reads them via RLS.
      const { data: finaticRow } = await supabase
        .from('restaurants')
        .select('finatic_merchant_no, finatic_store_no')
        .eq('id', restaurantId)
        .maybeSingle()
      setMerchantNo(String(finaticRow?.finatic_merchant_no || ''))
      setStoreNo(String(finaticRow?.finatic_store_no || ''))
      const token = await getSettingsAccessToken()
      const res = await fetch(`/api/admin/restaurants/${restaurantId}/settings`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      const payload = await res.json()
      const methods = payload?.settings?.payment_methods
      setPaymentMethods(
        Array.isArray(methods) && methods.length > 0
          ? methods.map((m: unknown) => String(m))
          : ['cash', 'card']
      )
      setHasKiosk(Boolean(payload?.settings?.hasKiosk))
      const kioskPaymentMethods = payload?.settings?.kiosk_payment_methods
      setKioskMethods(
        Array.isArray(kioskPaymentMethods) && kioskPaymentMethods.length > 0
          ? kioskPaymentMethods.map((m: unknown) => String(m))
          : ['cash', 'card', 'other']
      )
    } catch (error: unknown) {
      toast({
        title: 'Error',
        description: error instanceof Error ? error.message : 'Failed to load account details',
        variant: 'destructive',
      })
    } finally {
      setLoadingAccount(false)
    }
  }, [restaurantId, toast])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional deps-triggered data fetch; React Query refactor out of scope
    void loadAccount()
  }, [loadAccount])

  /**
   * The union is the reason PayToday shipped everywhere EXCEPT here. The database CHECK, the API
   * allowlist and the terminal all learned about it; this screen's two hardcoded switches and this
   * two-value type did not, so there was no way to turn it on for a venue.
   */
  const handlePaymentMethodToggle = async (
    method: 'cash' | 'card' | 'paytoday',
    enabled: boolean,
  ) => {
    if (!restaurantId) return

    const nextMethods = enabled
      ? [...new Set([...paymentMethods, method])]
      : paymentMethods.filter((item) => item !== method)

    if (nextMethods.length === 0) {
      toast({
        title: 'Error',
        description: 'At least one payment method must remain enabled.',
        variant: 'destructive',
      })
      return
    }

    try {
      setSavingPaymentMethods(true)
      const token = await getSettingsAccessToken()
      const res = await fetch(`/api/admin/restaurants/${restaurantId}/settings`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ payment_methods: nextMethods }),
      })
      const payload = await res.json()
      if (!res.ok) throw new Error(payload?.error || 'Failed to update payment methods')

      setPaymentMethods(nextMethods)
      toast({ title: 'Saved', description: 'Payment methods updated.' })
    } catch (error: unknown) {
      toast({
        title: 'Save failed',
        description: error instanceof Error ? error.message : 'Failed to update payment methods',
        variant: 'destructive',
      })
    } finally {
      setSavingPaymentMethods(false)
    }
  }

  const handleKioskMethodToggle = async (method: 'cash' | 'card' | 'other', enabled: boolean) => {
    if (!restaurantId) return

    const nextMethods = enabled
      ? [...new Set([...kioskMethods, method])]
      : kioskMethods.filter((m) => m !== method)

    if (nextMethods.length === 0) {
      toast({
        title: 'Error',
        description: 'At least one kiosk payment method must remain enabled.',
        variant: 'destructive',
      })
      return
    }

    try {
      setSavingKioskMethods(true)
      const token = await getSettingsAccessToken()
      const res = await fetch(`/api/admin/restaurants/${restaurantId}/settings`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ kiosk_payment_methods: nextMethods }),
      })
      const payload = await res.json()
      if (!res.ok) throw new Error(payload?.error || 'Failed to update kiosk payment methods')

      setKioskMethods(nextMethods)
      toast({ title: 'Saved', description: 'Kiosk payment methods updated.' })
    } catch (error: unknown) {
      toast({
        title: 'Save failed',
        description: error instanceof Error ? error.message : 'Failed to update kiosk payment methods',
        variant: 'destructive',
      })
    } finally {
      setSavingKioskMethods(false)
    }
  }

  const handleSaveAccount = async () => {
    try {
      setSavingAccount(true)
      const token = await getSettingsAccessToken()
      const response = await fetch('/api/admin/restaurant/finatic', {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ merchantNo, storeNo }),
      })
      const payload = await response.json()
      if (!response.ok) {
        throw new Error(payload?.error || 'Failed to save account details')
      }
      toast({ title: 'Saved', description: 'Finatic merchant account updated.' })
    } catch (error: unknown) {
      toast({
        title: 'Save failed',
        description: error instanceof Error ? error.message : 'Failed to save account details',
        variant: 'destructive',
      })
    } finally {
      setSavingAccount(false)
    }
  }

  const primaryButtonStyle = {
    backgroundColor: SETTINGS_BRAND_PRIMARY,
    color: '#fff',
  }

  return (
    <div className="space-y-6">
      <div className="bg-card border rounded-lg p-6 space-y-6">
        <div>
          <h2 className="text-xl font-semibold">Finatic merchant account</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Contact DigiPay to get these details.
          </p>
        </div>

        {loadingAccount ? (
          <p className="text-sm text-muted-foreground">Loading account details...</p>
        ) : (
          <>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="finatic-merchant-no">Merchant number</Label>
                <Input
                  id="finatic-merchant-no"
                  value={merchantNo}
                  onChange={(e) => setMerchantNo(e.target.value)}
                  disabled={savingAccount || !canConfigure}
                  placeholder="e.g. 342600032359"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="finatic-store-no">Store number</Label>
                <Input
                  id="finatic-store-no"
                  value={storeNo}
                  onChange={(e) => setStoreNo(e.target.value)}
                  disabled={savingAccount || !canConfigure}
                  placeholder="e.g. 4426012791"
                />
              </div>
            </div>
            <Button
              onClick={handleSaveAccount}
              disabled={savingAccount || !canConfigure}
              className="text-white"
              style={primaryButtonStyle}
              onMouseEnter={(e) => {
                e.currentTarget.style.backgroundColor = SETTINGS_BRAND_PRIMARY_HOVER
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.backgroundColor = SETTINGS_BRAND_PRIMARY
              }}
            >
              {savingAccount ? 'Saving...' : 'Save account details'}
            </Button>
          </>
        )}
      </div>

      <div className="bg-card border rounded-lg p-6 space-y-6">
        <div>
          <h2 className="text-xl font-semibold">Payment Methods</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Choose which payment options customers can select at checkout.
          </p>
        </div>

        {loadingAccount ? (
          <p className="text-sm text-muted-foreground">Loading payment methods...</p>
        ) : (
          <div className="space-y-4">
            <div className="flex items-center justify-between gap-4 rounded-lg border p-4">
              <div className="space-y-1">
                <Label htmlFor="payment-method-cash">Cash payments</Label>
                <p className="text-sm text-muted-foreground">
                  Allow customers to pay with cash at the table.
                </p>
              </div>
              <Switch
                id="payment-method-cash"
                checked={paymentMethods.includes('cash')}
                onCheckedChange={(checked) => void handlePaymentMethodToggle('cash', checked)}
                disabled={savingPaymentMethods || !canConfigure}
              />
            </div>
            <div className="flex items-center justify-between gap-4 rounded-lg border p-4">
              <div className="space-y-1">
                <Label htmlFor="payment-method-card">Card payments</Label>
                <p className="text-sm text-muted-foreground">
                  Allow customers to pay with card at the table.
                </p>
              </div>
              <Switch
                id="payment-method-card"
                checked={paymentMethods.includes('card')}
                onCheckedChange={(checked) => void handlePaymentMethodToggle('card', checked)}
                disabled={savingPaymentMethods || !canConfigure}
              />
            </div>
            {/*
              PAYTODAY. OFF unless a venue turns it on -- `includes('paytoday')` is false for the
              hardcoded ['cash','card'] default and for every venue with no restaurant_settings row,
              so nothing is enabled by adding this switch.

              A Nedbank product the waiter transacts OUTSIDE FlashTap: no reader, no gateway, no
              webhook. FlashTap records an assertion and cannot verify it, which is why the
              description says who reconciles rather than implying we check.

              TERMINAL ONLY IN v1 -- deliberately not added to Kiosk Payment Methods below.
            */}
            <div className="flex items-center justify-between gap-4 rounded-lg border p-4">
              <div className="space-y-1">
                <Label htmlFor="payment-method-paytoday">PayToday</Label>
                <p className="text-sm text-muted-foreground">
                  Staff take the payment in the PayToday app and mark the order paid on the
                  terminal. FlashTap cannot verify it — reconcile against your Nedbank statement.
                </p>
              </div>
              <Switch
                id="payment-method-paytoday"
                checked={paymentMethods.includes('paytoday')}
                onCheckedChange={(checked) => void handlePaymentMethodToggle('paytoday', checked)}
                disabled={savingPaymentMethods || !canConfigure}
              />
            </div>
          </div>
        )}
      </div>

      {hasKiosk ? (
        <div className="bg-card border rounded-lg p-6 space-y-6">
          <div>
            <h2 className="text-xl font-semibold">Kiosk Payment Methods</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Choose which payment options customers can select at the kiosk.
            </p>
          </div>

          {loadingAccount ? (
            <p className="text-sm text-muted-foreground">Loading kiosk payment methods...</p>
          ) : (
            <div className="space-y-4">
              <div className="flex items-center justify-between gap-4 rounded-lg border p-4">
                <div className="space-y-1">
                  <Label htmlFor="kiosk-payment-method-cash">Pay at counter</Label>
                  <p className="text-sm text-muted-foreground">
                    Allow customers to pay with cash at the kiosk.
                  </p>
                </div>
                <Switch
                  id="kiosk-payment-method-cash"
                  checked={kioskMethods.includes('cash')}
                  onCheckedChange={(checked) => void handleKioskMethodToggle('cash', checked)}
                  disabled={savingKioskMethods || !canConfigure}
                />
              </div>
              <div className="flex items-center justify-between gap-4 rounded-lg border p-4">
                <div className="space-y-1">
                  <Label htmlFor="kiosk-payment-method-card">Tap card at counter</Label>
                  <p className="text-sm text-muted-foreground">
                    Allow customers to tap their card when collecting their order.
                  </p>
                </div>
                <Switch
                  id="kiosk-payment-method-card"
                  checked={kioskMethods.includes('card')}
                  onCheckedChange={(checked) => void handleKioskMethodToggle('card', checked)}
                  disabled={savingKioskMethods || !canConfigure}
                />
              </div>
              <div className="flex items-center justify-between gap-4 rounded-lg border p-4">
                <div className="space-y-1">
                  <Label htmlFor="kiosk-payment-method-other">Other</Label>
                  <p className="text-sm text-muted-foreground">
                    Staff will assist the customer with payment.
                  </p>
                </div>
                <Switch
                  id="kiosk-payment-method-other"
                  checked={kioskMethods.includes('other')}
                  onCheckedChange={(checked) => void handleKioskMethodToggle('other', checked)}
                  disabled={savingKioskMethods || !canConfigure}
                />
              </div>
            </div>
          )}
        </div>
      ) : null}

      {/*
        DEVICES. Payment terminals and kitchen/bar screens, managed in one place: identity,
        connection, lifecycle and device transfer. Replaces the Terminals list (whose Deactivate wrote
        restaurant_terminals from the browser, unaudited) and the separate paired-screens section.
      */}
      <DevicesConsole />
    </div>
  )
}
