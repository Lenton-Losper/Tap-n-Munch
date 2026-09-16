'use client'

import { useCallback, useEffect, useState } from 'react'
import { useAuth } from '@/components/auth/auth-provider'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
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

/**
 * THREE STATES, BECAUSE THE COLUMN HAS THREE.
 *
 * `restaurant_billing_profiles.vat_registered` is `boolean NULL`, and the route that reads it
 * (app/api/admin/restaurants/[id]/billing-profile/route.ts) goes out of its way to keep the third
 * state alive: null means the merchant has never been asked, which is every venue today, and is
 * NOT the same answer as "no". A two-state control would have to invent one of those on load, and
 * the invented answer would then be written back on the first unrelated save.
 *
 * So the form carries the same three states the database does, and a merchant who has never
 * answered stays unanswered until they say something.
 */
type VatRegistration = 'unanswered' | 'registered' | 'not_registered'

const VAT_REGISTRATION_FROM_BOOLEAN = (value: unknown): VatRegistration => {
  if (value === true) return 'registered'
  if (value === false) return 'not_registered'
  return 'unanswered'
}

const VAT_REGISTRATION_TO_BOOLEAN = (value: VatRegistration): boolean | null => {
  if (value === 'registered') return true
  if (value === 'not_registered') return false
  return null
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
  const [vatRegistration, setVatRegistration] = useState<VatRegistration>('unanswered')
  /**
   * Whether this venue's database can hold the answer at all -- the route reports it as
   * `vatRegistrationSupported` precisely so the client can hide a control the database cannot
   * back, rather than offering a toggle whose save is guaranteed to be refused with a 409.
   *
   * Starts false so nothing is offered before the GET has said otherwise.
   */
  const [vatRegistrationSupported, setVatRegistrationSupported] = useState(false)
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
      setVatRegistration(VAT_REGISTRATION_FROM_BOOLEAN(payload.billingProfile?.vat_registered))
      setVatRegistrationSupported(payload.vatRegistrationSupported === true)
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

    /**
     * THE SAME RULE THE ROUTE AND THE DATABASE CHECK BOTH ENFORCE, asked here first so the
     * merchant is told which field to fill in rather than being handed the server's refusal as a
     * bare "Save failed". This is a courtesy, not the check: the route validates the MERGED
     * profile regardless of what this form sends.
     */
    if (vatRegistration === 'registered' && !profile.vat_number.trim()) {
      toast({
        title: 'VAT number required',
        description:
          'A business that is VAT registered must state its VAT number, because it appears on ' +
          'every invoice and receipt that charges VAT.',
        variant: 'destructive',
      })
      return
    }

    try {
      setSaving(true)
      const token = await getSettingsAccessToken()
      /**
       * `vat_registered` IS SENT ON EVERY SAVE where the column exists, and is OMITTED where it
       * does not.
       *
       * Omitting it used to be unconditional, and that was defect D1: the route treated a missing
       * key as an explicit null and upserted it, so saving a bank branch code silently wiped a
       * merchant's VAT-registration answer. The route no longer does that -- an omitted field now
       * keeps its stored value -- but this form owns the answer it is displaying, so it states it
       * rather than relying on the server to leave it alone.
       *
       * Where the column is absent the key is left out entirely, which is the one thing that both
       * avoids the route's VAT_REGISTRATION_UNAVAILABLE refusal and changes nothing stored.
       */
      const body: Record<string, string | boolean | null> = {
        registration_number: profile.registration_number.trim() || null,
        vat_number: profile.vat_number.trim() || null,
        bank_name: profile.bank_name.trim() || null,
        bank_account_name: profile.bank_account_name.trim() || null,
        bank_account_number: profile.bank_account_number.trim() || null,
        bank_branch_code: profile.bank_branch_code.trim() || null,
      }
      if (vatRegistrationSupported) {
        body.vat_registered = VAT_REGISTRATION_TO_BOOLEAN(vatRegistration)
      }

      const response = await fetch(`/api/admin/restaurants/${restaurantId}/billing-profile`, {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      })
      const payload = await response.json()
      if (!response.ok) {
        throw new Error(payload?.error || 'Failed to save billing profile')
      }
      setProfile(billingProfileFromPayload(payload.billingProfile))
      // Echoed back from the row that was actually written, not from what this form sent.
      setVatRegistration(VAT_REGISTRATION_FROM_BOOLEAN(payload.billingProfile?.vat_registered))
      if (typeof payload.vatRegistrationSupported === 'boolean') {
        setVatRegistrationSupported(payload.vatRegistrationSupported)
      }
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

      {vatRegistrationSupported ? (
        <div className="space-y-2">
          <Label>VAT registration</Label>
          <p className="text-sm text-muted-foreground">
            Whether this business is registered for VAT. Invoices state this, so leave it
            unanswered rather than guessing.
          </p>
          <RadioGroup
            value={vatRegistration}
            onValueChange={(value) => setVatRegistration(value as VatRegistration)}
            disabled={saving || !canWrite}
            className="pt-1"
          >
            <div className="flex items-center gap-2">
              <RadioGroupItem value="registered" id="billing-vat-registered-yes" />
              <Label htmlFor="billing-vat-registered-yes" className="font-normal">
                Yes — this business is VAT registered
              </Label>
            </div>
            <div className="flex items-center gap-2">
              <RadioGroupItem value="not_registered" id="billing-vat-registered-no" />
              <Label htmlFor="billing-vat-registered-no" className="font-normal">
                No — this business is not VAT registered
              </Label>
            </div>
            <div className="flex items-center gap-2">
              <RadioGroupItem value="unanswered" id="billing-vat-registered-unanswered" />
              <Label htmlFor="billing-vat-registered-unanswered" className="font-normal">
                Not answered
              </Label>
            </div>
          </RadioGroup>
        </div>
      ) : null}

      <div className="space-y-2">
        <Label htmlFor="billing-vat-number">
          VAT number{vatRegistration === 'registered' ? ' (required)' : ''}
        </Label>
        <Input
          id="billing-vat-number"
          value={profile.vat_number}
          onChange={(e) => updateField('vat_number', e.target.value)}
          disabled={saving || !canWrite}
        />
        {vatRegistration === 'registered' && !profile.vat_number.trim() ? (
          <p className="text-sm text-destructive">
            A VAT registered business must state its VAT number.
          </p>
        ) : null}
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
