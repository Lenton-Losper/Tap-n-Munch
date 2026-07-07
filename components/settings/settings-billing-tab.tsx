'use client'

import { useCallback, useEffect, useState } from 'react'
import { useAuth } from '@/components/auth/auth-provider'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useToast } from '@/hooks/use-toast'
import { usePermissions } from '@/hooks/use-permissions'
import { PERMISSIONS } from '@/lib/permissions'
import { SETTINGS_BRAND_PRIMARY, SETTINGS_BRAND_PRIMARY_HOVER } from './constants'
import { getSettingsAccessToken } from './settings-utils'

type BillingProfile = {
  registration_number: string
  vat_number: string
  bank_name: string
  bank_account_name: string
  bank_account_number: string
  bank_branch_code: string
}

const EMPTY_BILLING_PROFILE: BillingProfile = {
  registration_number: '',
  vat_number: '',
  bank_name: '',
  bank_account_name: '',
  bank_account_number: '',
  bank_branch_code: '',
}

function billingProfileFromPayload(
  payload: Partial<Record<keyof BillingProfile, string | null>> | null | undefined,
): BillingProfile {
  return {
    registration_number: payload?.registration_number ?? '',
    vat_number: payload?.vat_number ?? '',
    bank_name: payload?.bank_name ?? '',
    bank_account_name: payload?.bank_account_name ?? '',
    bank_account_number: payload?.bank_account_number ?? '',
    bank_branch_code: payload?.bank_branch_code ?? '',
  }
}

export function SettingsBillingTab() {
  const { restaurantId } = useAuth()
  const { toast } = useToast()
  const { hasPermission, permissionsLoaded } = usePermissions()
  const canWrite = !permissionsLoaded || hasPermission(PERMISSIONS.DOCUMENTS_WRITE)
  const [profile, setProfile] = useState<BillingProfile>(EMPTY_BILLING_PROFILE)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)

  const loadBillingProfile = useCallback(async () => {
    if (!restaurantId) {
      setLoading(false)
      return
    }
    try {
      setLoading(true)
      const token = await getSettingsAccessToken()
      const response = await fetch(`/api/admin/restaurants/${restaurantId}/billing-profile`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      const payload = await response.json()
      if (!response.ok) {
        throw new Error(payload?.error || 'Failed to load billing profile')
      }
      setProfile(billingProfileFromPayload(payload.billingProfile))
    } catch (error: unknown) {
      toast({
        title: 'Could not load billing profile',
        description: error instanceof Error ? error.message : 'Failed to load billing profile',
        variant: 'destructive',
      })
    } finally {
      setLoading(false)
    }
  }, [restaurantId, toast])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional deps-triggered data fetch; React Query refactor out of scope
    void loadBillingProfile()
  }, [loadBillingProfile])

  const handleSave = async () => {
    if (!restaurantId || !canWrite) return

    try {
      setSaving(true)
      const token = await getSettingsAccessToken()
      const response = await fetch(`/api/admin/restaurants/${restaurantId}/billing-profile`, {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          registration_number: profile.registration_number.trim() || null,
          vat_number: profile.vat_number.trim() || null,
          bank_name: profile.bank_name.trim() || null,
          bank_account_name: profile.bank_account_name.trim() || null,
          bank_account_number: profile.bank_account_number.trim() || null,
          bank_branch_code: profile.bank_branch_code.trim() || null,
        }),
      })
      const payload = await response.json()
      if (!response.ok) {
        throw new Error(payload?.error || 'Failed to save billing profile')
      }
      setProfile(billingProfileFromPayload(payload.billingProfile))
      toast({ title: 'Billing saved', description: 'Your billing details have been updated.' })
    } catch (error: unknown) {
      toast({
        title: 'Save failed',
        description: error instanceof Error ? error.message : 'Failed to save billing profile',
        variant: 'destructive',
      })
    } finally {
      setSaving(false)
    }
  }

  const updateField = (field: keyof BillingProfile, value: string) => {
    setProfile((current) => ({ ...current, [field]: value }))
  }

  if (loading) {
    return <p className="text-sm text-muted-foreground">Loading billing profile...</p>
  }

  return (
    <div className="bg-card border rounded-lg p-6 space-y-6">
      <div>
        <h2 className="text-xl font-semibold">Billing</h2>
        <p className="text-sm text-muted-foreground">
          Registration, VAT, and bank details used on quotes and invoices.
        </p>
      </div>

      <div className="space-y-2">
        <Label htmlFor="billing-registration-number">Registration number</Label>
        <Input
          id="billing-registration-number"
          value={profile.registration_number}
          onChange={(e) => updateField('registration_number', e.target.value)}
          disabled={saving || !canWrite}
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="billing-vat-number">VAT number</Label>
        <Input
          id="billing-vat-number"
          value={profile.vat_number}
          onChange={(e) => updateField('vat_number', e.target.value)}
          disabled={saving || !canWrite}
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="billing-bank-name">Bank name</Label>
        <Input
          id="billing-bank-name"
          value={profile.bank_name}
          onChange={(e) => updateField('bank_name', e.target.value)}
          disabled={saving || !canWrite}
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="billing-bank-account-name">Bank account name</Label>
        <Input
          id="billing-bank-account-name"
          value={profile.bank_account_name}
          onChange={(e) => updateField('bank_account_name', e.target.value)}
          disabled={saving || !canWrite}
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="billing-bank-account-number">Bank account number</Label>
        <Input
          id="billing-bank-account-number"
          value={profile.bank_account_number}
          onChange={(e) => updateField('bank_account_number', e.target.value)}
          disabled={saving || !canWrite}
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="billing-bank-branch-code">Bank branch code</Label>
        <Input
          id="billing-bank-branch-code"
          value={profile.bank_branch_code}
          onChange={(e) => updateField('bank_branch_code', e.target.value)}
          disabled={saving || !canWrite}
        />
      </div>

      {canWrite ? (
        <Button
          onClick={handleSave}
          disabled={saving}
          className="text-white"
          style={{ backgroundColor: SETTINGS_BRAND_PRIMARY }}
          onMouseEnter={(e) => {
            e.currentTarget.style.backgroundColor = SETTINGS_BRAND_PRIMARY_HOVER
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.backgroundColor = SETTINGS_BRAND_PRIMARY
          }}
        >
          {saving ? 'Saving...' : 'Save billing details'}
        </Button>
      ) : null}
    </div>
  )
}
