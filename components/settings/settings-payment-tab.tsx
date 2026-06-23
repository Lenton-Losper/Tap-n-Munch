'use client'

import { useCallback, useEffect, useState } from 'react'
import { CheckCircle2, Copy, Plus } from 'lucide-react'
import { useAuth } from '@/components/auth/auth-provider'
import { getRestaurant } from '@/lib/supabase/restaurants'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { useToast } from '@/hooks/use-toast'
import {
  SETTINGS_BRAND_PRIMARY,
  SETTINGS_BRAND_PRIMARY_HOVER,
} from './constants'
import { getSettingsAccessToken } from './settings-utils'

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
  sn: string | null
  model: string | null
  is_active: boolean
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
  if (terminal.is_active) {
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
  const [savingAccount, setSavingAccount] = useState(false)
  const [loadingAccount, setLoadingAccount] = useState(true)

  const [terminals, setTerminals] = useState<TerminalRow[]>([])
  const [loadingTerminals, setLoadingTerminals] = useState(true)
  const [generatingCode, setGeneratingCode] = useState(false)
  const [activationResult, setActivationResult] = useState<ActivationResult | null>(null)

  useEffect(() => {
    if (!restaurantId) return
    const stored = readStoredActivation(restaurantId)
    if (stored) setActivationResult(stored)
  }, [restaurantId])

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
    try {
      setLoadingTerminals(true)
      const token = await getSettingsAccessToken()
      const response = await fetch('/api/admin/terminals', {
        headers: { Authorization: `Bearer ${token}` },
      })
      const payload = await response.json()
      if (!response.ok) {
        throw new Error(payload?.error || 'Failed to load terminals')
      }
      setTerminals(payload.terminals || [])
    } catch (error: unknown) {
      toast({
        title: 'Error',
        description: error instanceof Error ? error.message : 'Failed to load terminals',
        variant: 'destructive',
      })
    } finally {
      setLoadingTerminals(false)
    }
  }, [toast])

  useEffect(() => {
    void loadAccount()
    void loadTerminals()
  }, [loadAccount, loadTerminals])

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

      const code = String(payload?.code || '').trim()
      const expiresAt = String(payload?.expiresAt || '').trim()
      if (!code) {
        throw new Error('No activation code was returned. Please try again.')
      }

      const result: ActivationResult = { code, expiresAt }
      setActivationResult(result)
      if (restaurantId) persistActivation(restaurantId, result)
      await loadTerminals()

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

  const handleCopyCode = async () => {
    if (!activationResult?.code) return
    try {
      await navigator.clipboard.writeText(activationResult.code)
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

      {activationResult ? (
        <div id="terminal-activation-success">
          <TerminalActivationSuccessCard
            result={activationResult}
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
        ) : terminals.length === 0 ? (
          <div className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
            No terminals registered yet.
          </div>
        ) : (
          <div className="space-y-3">
            {terminals.map((terminal) => (
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
                    Serial: {terminal.sn || '—'}
                  </p>
                  <p className="text-sm text-muted-foreground">
                    Model: {terminal.model || '—'}
                  </p>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
