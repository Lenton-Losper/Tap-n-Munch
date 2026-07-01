'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { CheckCircle2, Copy, Plus } from 'lucide-react'
import { useAuth } from '@/components/auth/auth-provider'
import { supabase } from '@/lib/supabase/client'
import { getRestaurant } from '@/lib/supabase/restaurants'
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

const ACTIVATION_STORAGE_PREFIX = 'settings_terminal_activation_result'
const SUCCESS_BG = '#FFF8F4'
const SUCCESS_BORDER = '#A7E3B5'
const DONE_ORANGE = '#FF6B35'

type ActivationResult = {
  code: string
  expiresAt: string
}

type TerminalRow = {
  id: string
  label: string
  device_serial: string | null
  model: string | null
  status: string
  has_pending_code: boolean
}

function activationStorageKey(restaurantId: string) {
  return `${ACTIVATION_STORAGE_PREFIX}:${restaurantId}`
}

function readStoredActivation(restaurantId: string | null): ActivationResult | null {
  if (!restaurantId || typeof window === 'undefined') return null
  try {
    const raw = sessionStorage.getItem(activationStorageKey(restaurantId))
    if (!raw) return null
    const parsed = JSON.parse(raw) as ActivationResult
    if (!parsed?.code) return null
    return {
      code: String(parsed.code),
      expiresAt: String(parsed.expiresAt || ''),
    }
  } catch {
    return null
  }
}

function persistActivation(restaurantId: string, result: ActivationResult) {
  if (typeof window === 'undefined') return
  sessionStorage.setItem(activationStorageKey(restaurantId), JSON.stringify(result))
}

function clearStoredActivation(restaurantId: string | null) {
  if (!restaurantId || typeof window === 'undefined') return
  sessionStorage.removeItem(activationStorageKey(restaurantId))
}

function terminalStatusBadge(terminal: TerminalRow) {
  if (terminal.status === 'active') {
    return <Badge className="bg-emerald-600 hover:bg-emerald-600">Active</Badge>
  }
  return <Badge variant="secondary">Pending</Badge>
}

function TerminalActivationSuccessCard({
  result,
  onCopy,
  onDone,
}: {
  result: ActivationResult
  onCopy: () => void
  onDone: () => void
}) {
  return (
    <div
      className="rounded-xl border-2 p-6 sm:p-8 shadow-sm"
      style={{ backgroundColor: SUCCESS_BG, borderColor: SUCCESS_BORDER }}
    >
      <div className="mx-auto max-w-lg text-center space-y-5">
        <div className="space-y-1">
          <div className="flex items-center justify-center gap-2 text-emerald-700">
            <CheckCircle2 className="h-5 w-5 shrink-0" aria-hidden />
            <p className="text-base font-semibold text-emerald-800">
              Terminal added successfully!
            </p>
          </div>
          <p className="text-sm text-[#5c4a42]">Your activation code is ready to use.</p>
        </div>

        <div className="space-y-3 rounded-lg bg-white/60 px-4 py-6 sm:px-6">
          <p className="text-xs font-medium uppercase tracking-wide text-[#7a5c4a]">
            Terminal Activation Code
          </p>
          <p className="font-mono text-4xl sm:text-5xl font-bold tracking-widest text-[#1a1208] break-all">
            {result.code}
          </p>
          <p className="text-sm text-[#6b5a50]">Expires in 1 hour</p>
        </div>

        <p className="text-sm leading-relaxed text-[#5c4a42]">
          Enter this code in the FlashTap Terminal app
          <br className="hidden sm:inline" />
          {' '}to activate the terminal.
        </p>

        <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-center gap-3 pt-1">
          <Button
            type="button"
            variant="outline"
            onClick={onCopy}
            className="h-11 bg-white hover:bg-white/90"
            style={{ borderColor: SUCCESS_BORDER, borderWidth: 2 }}
          >
            <Copy className="mr-2 h-4 w-4" />
            Copy code
          </Button>
          <Button
            type="button"
            onClick={onDone}
            className="h-11 text-white hover:opacity-90"
            style={{ backgroundColor: DONE_ORANGE }}
          >
            Done
          </Button>
        </div>
      </div>
    </div>
  )
}

export function SettingsPaymentTab() {
  const { restaurantId } = useAuth()
  const { toast } = useToast()
  const [merchantNo, setMerchantNo] = useState('')
  const [storeNo, setStoreNo] = useState('')
  const [paymentMethods, setPaymentMethods] = useState<string[]>(['cash', 'card'])
  const [hasKiosk, setHasKiosk] = useState(false)
  const [kioskMethods, setKioskMethods] = useState<string[]>(['cash', 'card', 'other'])
  const [savingAccount, setSavingAccount] = useState(false)
  const [savingPaymentMethods, setSavingPaymentMethods] = useState(false)
  const [savingKioskMethods, setSavingKioskMethods] = useState(false)
  const [loadingAccount, setLoadingAccount] = useState(true)

  const [terminals, setTerminals] = useState<TerminalRow[]>([])
  const [loadingTerminals, setLoadingTerminals] = useState(true)
  const [generatingCode, setGeneratingCode] = useState(false)
  const [deactivatingId, setDeactivatingId] = useState<string | null>(null)
  const [showInactive, setShowInactive] = useState(false)
  const storedActivation = useMemo(
    () => (restaurantId ? readStoredActivation(restaurantId) : null),
    [restaurantId]
  )
  const [activationResult, setActivationResult] = useState<ActivationResult | null>(null)
  const effectiveActivationResult = activationResult ?? storedActivation

  const loadAccount = useCallback(async () => {
    if (!restaurantId) {
      setLoadingAccount(false)
      return
    }
    try {
      setLoadingAccount(true)
      const data = await getRestaurant(restaurantId)
      setMerchantNo(String((data as any)?.finatic_merchant_no || ''))
      setStoreNo(String((data as any)?.finatic_store_no || ''))
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

  const loadTerminals = useCallback(async () => {
    if (!restaurantId) {
      setLoadingTerminals(false)
      return
    }
    try {
      setLoadingTerminals(true)
      const token = await getSettingsAccessToken()
      const response = await fetch('/api/admin/terminals/list', {
        headers: { Authorization: `Bearer ${token}` },
      })
      const payload = await response.json()
      if (!response.ok) {
        throw new Error(payload?.error || 'Failed to load terminals')
      }

      const rows: TerminalRow[] = (payload.terminals || []).map((row: Record<string, unknown>) => {
        const activationCode = row.activation_code ? String(row.activation_code) : null
        const expiresAt = row.activation_code_expires_at
          ? String(row.activation_code_expires_at)
          : null
        const hasPendingCode =
          Boolean(activationCode) &&
          (!expiresAt || new Date(expiresAt).getTime() > Date.now())

        return {
          id: String(row.id),
          label: String(row.terminal_name || 'Terminal'),
          device_serial: row.device_serial ? String(row.device_serial) : null,
          model: row.model ? String(row.model) : null,
          status: String(row.status || 'active'),
          has_pending_code: hasPendingCode,
        }
      })
      setTerminals(rows)
    } catch (error: unknown) {
      toast({
        title: 'Error',
        description: error instanceof Error ? error.message : 'Failed to load terminals',
        variant: 'destructive',
      })
    } finally {
      setLoadingTerminals(false)
    }
  }, [restaurantId, toast])

  useEffect(() => {
    void loadAccount()
    void loadTerminals()
  }, [loadAccount, loadTerminals])

  const handlePaymentMethodToggle = async (method: 'cash' | 'card', enabled: boolean) => {
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

  const dismissActivationCode = () => {
    setActivationResult(null)
    clearStoredActivation(restaurantId)
  }

  const handleAddTerminal = async () => {
    try {
      setGeneratingCode(true)
      const token = await getSettingsAccessToken()
      const response = await fetch('/api/admin/terminals/generate-code', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({}),
      })
      const payload = await response.json()
      if (!response.ok) {
        throw new Error(payload?.error || 'Failed to generate activation code')
      }

      const code = String(payload?.activationCode || '').trim()
      const expiresAt = String(payload?.expiresAt || '').trim()
      if (!code) {
        throw new Error('No activation code was returned. Please try again.')
      }

      const result: ActivationResult = { code, expiresAt }
      setActivationResult(result)
      if (restaurantId) persistActivation(restaurantId, result)
      await loadTerminals()

      try {
        await onboardingFetch('/api/admin/setup-status', {
          method: 'PATCH',
          body: JSON.stringify({ flag: 'terminal_connected' }),
        })
      } catch {
        // non-blocking
      }

      requestAnimationFrame(() => {
        document.getElementById('terminal-activation-success')?.scrollIntoView({
          behavior: 'smooth',
          block: 'nearest',
        })
      })
    } catch (error: unknown) {
      toast({
        title: 'Could not generate code',
        description: error instanceof Error ? error.message : 'Failed to generate activation code',
        variant: 'destructive',
      })
    } finally {
      setGeneratingCode(false)
    }
  }

  const handleDeactivateTerminal = async (terminal: TerminalRow) => {
    try {
      setDeactivatingId(terminal.id)
      const { error } = await supabase
        .from('restaurant_terminals')
        .update({ status: 'inactive' })
        .eq('id', terminal.id)

      if (error) throw error

      toast({ title: 'Deactivated', description: 'Terminal has been deactivated.' })
      await loadTerminals()
    } catch (error: unknown) {
      toast({
        title: 'Deactivation failed',
        description: error instanceof Error ? error.message : 'Failed to deactivate terminal',
        variant: 'destructive',
      })
    } finally {
      setDeactivatingId(null)
    }
  }

  const handleCopyCode = async () => {
    if (!effectiveActivationResult?.code) return
    try {
      await navigator.clipboard.writeText(effectiveActivationResult.code)
      toast({ title: 'Copied', description: 'Activation code copied to clipboard.' })
    } catch {
      toast({
        title: 'Copy failed',
        description: 'Could not copy to clipboard.',
        variant: 'destructive',
      })
    }
  }

  const primaryButtonStyle = {
    backgroundColor: SETTINGS_BRAND_PRIMARY,
    color: '#fff',
  }

  const visibleTerminals = terminals.filter(
    (terminal) => showInactive || terminal.status === 'active'
  )
  const hasInactiveTerminals = terminals.some((terminal) => terminal.status !== 'active')

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
                  disabled={savingAccount}
                  placeholder="e.g. 342600032359"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="finatic-store-no">Store number</Label>
                <Input
                  id="finatic-store-no"
                  value={storeNo}
                  onChange={(e) => setStoreNo(e.target.value)}
                  disabled={savingAccount}
                  placeholder="e.g. 4426012791"
                />
              </div>
            </div>
            <Button
              onClick={handleSaveAccount}
              disabled={savingAccount}
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
                disabled={savingPaymentMethods}
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
                disabled={savingPaymentMethods}
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
                  disabled={savingKioskMethods}
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
                  disabled={savingKioskMethods}
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
                  disabled={savingKioskMethods}
                />
              </div>
            </div>
          )}
        </div>
      ) : null}

      {effectiveActivationResult ? (
        <div id="terminal-activation-success">
          <TerminalActivationSuccessCard
            result={effectiveActivationResult}
            onCopy={handleCopyCode}
            onDone={dismissActivationCode}
          />
        </div>
      ) : null}

      <div className="bg-card border rounded-lg p-6 space-y-6">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-xl font-semibold">Terminals</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Generate an activation code and enter it in the FlashTap Terminal app to register a device.
            </p>
          </div>
          <Button
            onClick={handleAddTerminal}
            disabled={generatingCode}
            className="shrink-0 text-white"
            style={primaryButtonStyle}
            onMouseEnter={(e) => {
              e.currentTarget.style.backgroundColor = SETTINGS_BRAND_PRIMARY_HOVER
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.backgroundColor = SETTINGS_BRAND_PRIMARY
            }}
          >
            <Plus className="mr-2 h-4 w-4" />
            {generatingCode ? 'Generating...' : 'Add terminal'}
          </Button>
        </div>

        {loadingTerminals ? (
          <p className="text-sm text-muted-foreground">Loading terminals...</p>
        ) : visibleTerminals.length === 0 ? (
          <div className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
            {terminals.length === 0
              ? 'No terminals registered yet.'
              : 'No active terminals. Toggle "Show inactive" to see deactivated devices.'}
          </div>
        ) : (
          <div className="space-y-3">
            {visibleTerminals.map((terminal) => (
              <div
                key={terminal.id}
                className="flex flex-col gap-2 rounded-lg border p-4 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="min-w-0 space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="font-medium">{terminal.label}</p>
                    {terminalStatusBadge(terminal)}
                  </div>
                  <p className="text-sm text-muted-foreground">
                    Serial: {terminal.device_serial || '—'}
                  </p>
                  <p className="text-sm text-muted-foreground">
                    Model: {terminal.model || '—'}
                  </p>
                </div>
                {terminal.status === 'active' ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="shrink-0 text-red-600 hover:text-red-700"
                    onClick={() => handleDeactivateTerminal(terminal)}
                    disabled={deactivatingId === terminal.id}
                  >
                    {deactivatingId === terminal.id ? 'Deactivating...' : 'Deactivate'}
                  </Button>
                ) : null}
              </div>
            ))}
            {hasInactiveTerminals ? (
              <button
                type="button"
                onClick={() => setShowInactive((current) => !current)}
                className="text-sm text-muted-foreground hover:text-foreground underline-offset-4 hover:underline"
              >
                {showInactive ? 'Hide inactive' : 'Show inactive'}
              </button>
            ) : null}
          </div>
        )}
      </div>
    </div>
  )
}
