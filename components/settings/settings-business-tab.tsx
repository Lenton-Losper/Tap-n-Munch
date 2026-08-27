'use client'

import { useCallback, useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { useToast } from '@/hooks/use-toast'
import { SETTINGS_BRAND_PRIMARY, SETTINGS_BRAND_PRIMARY_HOVER } from './constants'
import { TaxRatesSection } from './tax-rates-section'
import {
  createLocationAction,
  getLocationsPageDataAction,
  type LocationsPageData,
} from '@/lib/organizations/actions'

/**
 * THIS LIST IS NOT ALWAYS THE BUSINESS'S LIST, AND IT USED TO SAY OTHERWISE.
 *
 * `getLocationsPageDataAction` takes the elevated read only for an organisation OWNER
 * (`resolveVisibleLocations`, gated on `authorizeOrganization(..., 'view_all_locations')`). Everyone
 * else gets the SESSION-client read, which `restaurants` RLS narrows to their own
 * `restaurant_users` memberships — there is no organisation path in that policy.
 *
 * So a location manager in a three-location business opened this tab and saw one card, under a
 * heading that says "Every location shares this business". Nothing on the screen distinguished
 * "your business has one location" from "you are attached to one of its locations". Measured on
 * production 2026-08-27: Gosto Investment CC has three locations and six staff users, five of whom
 * belong to exactly one; all five hold `settings:read` and reach this tab.
 *
 * THE SCOPING IS THE RULING, NOT THE DEFECT — the owner's words on the sibling case in
 * components/stock/create-transfer-form.tsx: "a permission to create cross-location transfers is
 * not a permission to see every location in the organisation." The fix is to say so, not to widen.
 *
 * WHY THIS NOTE IS SAFE TO SHOW WHENEVER THE READ WAS SCOPED, including to the sole manager of a
 * genuinely single-location business: it qualifies the list without claiming anything is missing.
 * It must stay that way — see the copy requirement below. (The transfer picker's zero-row message
 * cannot be written that way and therefore still owes a second string; noted there.)
 */
const SCOPED_LIST_COPY_PENDING = {
  /**
   * Placeholder, not drafted copy. MUST CONVEY, once signed off:
   *   1. this list shows the locations the reader is attached to, not necessarily every location in
   *      the business;
   *   2. if the business has others, the reader has not been given access to them;
   *   3. who to ask — a manager or the business owner.
   * MUST NOT assert that other locations DO exist (this renders for single-location businesses too),
   * MUST NOT read as an error or a failed load, and MUST NOT imply the reader has lost access to
   * something they previously had.
   */
  note:
    'This shows the locations you are attached to. If your business has others, you have not been given access to them - ask a manager or the business owner.',
}

function locationTypeLabel(locationType: string): string {
  return locationType
    .toLowerCase()
    .split('_')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ')
}

export function SettingsBusinessTab() {
  const { toast } = useToast()
  const [loading, setLoading] = useState(true)
  const [pageData, setPageData] = useState<LocationsPageData | null>(null)
  const [dialogOpen, setDialogOpen] = useState(false)

  const loadLocations = useCallback(async () => {
    try {
      setLoading(true)
      const result = await getLocationsPageDataAction()
      if ('error' in result) {
        toast({ title: 'Error', description: result.error, variant: 'destructive' })
        return
      }
      setPageData(result.data)
    } catch (error: unknown) {
      toast({
        title: 'Error',
        description: error instanceof Error ? error.message : 'Failed to load locations',
        variant: 'destructive',
      })
    } finally {
      setLoading(false)
    }
  }, [toast])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional deps-triggered data fetch; React Query refactor out of scope
    void loadLocations()
  }, [loadLocations])

  const handleCreated = () => {
    setDialogOpen(false)
    void loadLocations()
  }

  return (
    <div className="space-y-6">
      <div className="bg-card border rounded-lg p-6 space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-xl font-semibold">Locations</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Every location shares this business and can be used for stock transfers between
            branches.
          </p>
        </div>
        {!loading && pageData?.canCreateLocation ? (
          <Button
            type="button"
            onClick={() => setDialogOpen(true)}
            className="shrink-0 text-white"
            style={{ backgroundColor: SETTINGS_BRAND_PRIMARY }}
            onMouseEnter={(e) => {
              e.currentTarget.style.backgroundColor = SETTINGS_BRAND_PRIMARY_HOVER
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.backgroundColor = SETTINGS_BRAND_PRIMARY
            }}
          >
            Add Location
          </Button>
        ) : null}
      </div>

      {loading ? (
        <p className="text-sm text-muted-foreground">Loading locations...</p>
      ) : !pageData ? (
        <p className="text-sm text-muted-foreground">Unable to load locations.</p>
      ) : pageData.locations.length === 0 ? (
        <div className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
          No locations found.
        </div>
      ) : (
        <div className="space-y-3">
          {pageData.listIsScopedToCallerMemberships ? (
            <p className="rounded-lg border border-[#E9E9E7] bg-[#FAFAF8] px-3 py-2 text-sm text-muted-foreground">
              {SCOPED_LIST_COPY_PENDING.note}
            </p>
          ) : null}
          {pageData.locations.map((location) => (
            <div
              key={location.id}
              className="flex flex-col gap-2 rounded-lg border p-4 sm:flex-row sm:items-center sm:justify-between"
            >
              <div className="min-w-0 space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="font-medium truncate">{location.name}</p>
                  <Badge variant="secondary">{locationTypeLabel(location.locationType)}</Badge>
                </div>
                {location.address ? (
                  <p className="text-sm text-muted-foreground">{location.address}</p>
                ) : null}
              </div>
            </div>
          ))}
        </div>
      )}

      {pageData ? (
        <AddLocationDialog
          open={dialogOpen}
          onOpenChange={setDialogOpen}
          existingLocations={pageData.locations}
          onCreated={handleCreated}
        />
      ) : null}
      </div>

      <TaxRatesSection />
    </div>
  )
}

type AddLocationDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  existingLocations: LocationsPageData['locations']
  onCreated: () => void
}

function AddLocationDialog({
  open,
  onOpenChange,
  existingLocations,
  onCreated,
}: AddLocationDialogProps) {
  const { toast } = useToast()
  const [name, setName] = useState('')
  const [address, setAddress] = useState('')
  const [setupMode, setSetupMode] = useState<'empty' | 'copy'>('empty')
  const [copySourceId, setCopySourceId] = useState<string>('')
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    if (!open) return
    // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional reset when the dialog opens
    setName('')
    setAddress('')
    setSetupMode('empty')
    setCopySourceId(existingLocations[0]?.id ?? '')
  }, [open, existingLocations])

  const handleSubmit = async () => {
    if (!name.trim()) {
      toast({ title: 'Validation error', description: 'Location name is required', variant: 'destructive' })
      return
    }
    if (setupMode === 'copy' && !copySourceId) {
      toast({
        title: 'Validation error',
        description: 'Choose a location to copy stock configuration from',
        variant: 'destructive',
      })
      return
    }

    try {
      setSubmitting(true)
      const result = await createLocationAction({
        name: name.trim(),
        address: address.trim() || undefined,
        copyStockConfigFromRestaurantId: setupMode === 'copy' ? copySourceId : undefined,
      })
      if ('error' in result) {
        toast({ title: 'Add location failed', description: result.error, variant: 'destructive' })
        return
      }
      toast({ title: 'Location added', description: `${name.trim()} was created.` })
      onCreated()
    } catch (error: unknown) {
      toast({
        title: 'Add location failed',
        description: error instanceof Error ? error.message : 'Failed to add location',
        variant: 'destructive',
      })
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !submitting && onOpenChange(next)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add Location</DialogTitle>
          <DialogDescription>
            New locations share this business and its owner, and can immediately send or receive
            stock transfers.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="location-name">Location name</Label>
            <Input
              id="location-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Downtown Branch"
              disabled={submitting}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="location-address">Address</Label>
            <Input
              id="location-address"
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              placeholder="123 Main Street"
              disabled={submitting}
            />
          </div>

          <div className="space-y-3">
            <Label>Stock configuration</Label>
            <RadioGroup
              value={setupMode}
              onValueChange={(value) => setSetupMode(value as 'empty' | 'copy')}
              disabled={submitting}
            >
              <div className="flex items-start gap-2">
                <RadioGroupItem value="empty" id="setup-empty" className="mt-1" />
                <Label htmlFor="setup-empty" className="font-normal">
                  Start empty
                  <span className="block text-sm font-normal text-muted-foreground">
                    Set up stock items for this location from scratch.
                  </span>
                </Label>
              </div>
              <div className="flex items-start gap-2">
                <RadioGroupItem
                  value="copy"
                  id="setup-copy"
                  className="mt-1"
                  disabled={existingLocations.length === 0}
                />
                <Label htmlFor="setup-copy" className="font-normal">
                  Copy configuration from an existing location
                  <span className="block text-sm font-normal text-muted-foreground">
                    Copies item setup (par levels, units) only. Stock quantities always start at
                    zero.
                  </span>
                </Label>
              </div>
            </RadioGroup>

            {setupMode === 'copy' ? (
              <Select value={copySourceId} onValueChange={setCopySourceId} disabled={submitting}>
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="Choose a location" />
                </SelectTrigger>
                <SelectContent>
                  {existingLocations.map((location) => (
                    <SelectItem key={location.id} value={location.id}>
                      {location.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : null}
          </div>
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
            Cancel
          </Button>
          <Button
            type="button"
            onClick={() => void handleSubmit()}
            disabled={submitting}
            className="text-white"
            style={{ backgroundColor: SETTINGS_BRAND_PRIMARY }}
            onMouseEnter={(e) => {
              e.currentTarget.style.backgroundColor = SETTINGS_BRAND_PRIMARY_HOVER
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.backgroundColor = SETTINGS_BRAND_PRIMARY
            }}
          >
            {submitting ? 'Adding...' : 'Add Location'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
