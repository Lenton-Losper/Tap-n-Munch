'use client'

import { useCallback, useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Switch } from '@/components/ui/switch'
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
import {
  createTaxRateAction,
  deleteTaxRateAction,
  getTaxRatesAction,
  setDefaultTaxRateAction,
  updateTaxRateAction,
} from '@/lib/tax-rates/actions'
import type { TaxRateOption } from '@/lib/tax-rates/format'

export function TaxRatesSection() {
  const { toast } = useToast()
  const [loading, setLoading] = useState(true)
  const [rates, setRates] = useState<TaxRateOption[]>([])
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editingRate, setEditingRate] = useState<TaxRateOption | null>(null)

  const loadRates = useCallback(async () => {
    try {
      setLoading(true)
      const result = await getTaxRatesAction()
      if ('error' in result) {
        toast({ title: 'Error', description: result.error, variant: 'destructive' })
        return
      }
      setRates(result.data)
    } catch (error: unknown) {
      toast({
        title: 'Error',
        description: error instanceof Error ? error.message : 'Failed to load tax rates',
        variant: 'destructive',
      })
    } finally {
      setLoading(false)
    }
  }, [toast])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional deps-triggered data fetch
    void loadRates()
  }, [loadRates])

  const handleSaved = () => {
    setDialogOpen(false)
    setEditingRate(null)
    void loadRates()
  }

  const handleSetDefault = async (id: string) => {
    const result = await setDefaultTaxRateAction(id)
    if ('error' in result) {
      toast({ title: 'Error', description: result.error, variant: 'destructive' })
      return
    }
    void loadRates()
  }

  const handleDelete = async (rate: TaxRateOption) => {
    if (!window.confirm(`Delete "${rate.name}"? Items using it will fall back to 0% until reassigned.`)) {
      return
    }
    const result = await deleteTaxRateAction(rate.id)
    if ('error' in result) {
      toast({ title: 'Error', description: result.error, variant: 'destructive' })
      return
    }
    void loadRates()
  }

  return (
    <div className="bg-card border rounded-lg p-6 space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-xl font-semibold">Tax Rates</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Configure VAT/tax rates for menu items. Items left unconfigured use the default rate,
            or 0% if none is set.
          </p>
        </div>
        <Button
          type="button"
          onClick={() => {
            setEditingRate(null)
            setDialogOpen(true)
          }}
          className="shrink-0 text-white"
          style={{ backgroundColor: SETTINGS_BRAND_PRIMARY }}
          onMouseEnter={(e) => {
            e.currentTarget.style.backgroundColor = SETTINGS_BRAND_PRIMARY_HOVER
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.backgroundColor = SETTINGS_BRAND_PRIMARY
          }}
        >
          Add Tax Rate
        </Button>
      </div>

      {loading ? (
        <p className="text-sm text-muted-foreground">Loading tax rates...</p>
      ) : rates.length === 0 ? (
        <div className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
          No tax rates configured. Menu items compute 0% tax until you add one.
        </div>
      ) : (
        <div className="space-y-3">
          {rates.map((rate) => (
            <div
              key={rate.id}
              className="flex flex-col gap-2 rounded-lg border p-4 sm:flex-row sm:items-center sm:justify-between"
            >
              <div className="min-w-0 space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="font-medium truncate">{rate.name}</p>
                  <Badge variant="secondary">{rate.percentage}%</Badge>
                  <Badge variant="outline">{rate.is_inclusive ? 'Inclusive' : 'Exclusive'}</Badge>
                  {rate.is_default ? <Badge>Default</Badge> : null}
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {!rate.is_default ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => void handleSetDefault(rate.id)}
                  >
                    Set as default
                  </Button>
                ) : null}
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setEditingRate(rate)
                    setDialogOpen(true)
                  }}
                >
                  Edit
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="text-red-600 hover:text-red-700"
                  onClick={() => void handleDelete(rate)}
                >
                  Delete
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}

      <TaxRateDialog
        open={dialogOpen}
        editingRate={editingRate}
        onOpenChange={(next) => {
          setDialogOpen(next)
          if (!next) setEditingRate(null)
        }}
        onSaved={handleSaved}
      />
    </div>
  )
}

type TaxRateDialogProps = {
  open: boolean
  editingRate: TaxRateOption | null
  onOpenChange: (open: boolean) => void
  onSaved: () => void
}

function TaxRateDialog({ open, editingRate, onOpenChange, onSaved }: TaxRateDialogProps) {
  const { toast } = useToast()
  const [name, setName] = useState('')
  const [percentage, setPercentage] = useState('')
  const [isInclusive, setIsInclusive] = useState(true)
  const [isDefault, setIsDefault] = useState(false)
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    if (!open) return
    // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional reset when the dialog opens
    setName(editingRate?.name ?? '')
    setPercentage(editingRate ? String(editingRate.percentage) : '')
    setIsInclusive(editingRate?.is_inclusive ?? true)
    setIsDefault(editingRate?.is_default ?? false)
  }, [open, editingRate])

  const handleSubmit = async () => {
    const trimmedName = name.trim()
    const pct = Number(percentage)

    if (!trimmedName) {
      toast({ title: 'Validation error', description: 'Name is required', variant: 'destructive' })
      return
    }
    if (!Number.isFinite(pct) || pct < 0) {
      toast({
        title: 'Validation error',
        description: 'Enter a valid non-negative percentage',
        variant: 'destructive',
      })
      return
    }

    try {
      setSubmitting(true)
      const result = editingRate
        ? await updateTaxRateAction({
            id: editingRate.id,
            name: trimmedName,
            percentage: pct,
            isInclusive,
          })
        : await createTaxRateAction({
            name: trimmedName,
            percentage: pct,
            isInclusive,
            isDefault,
          })

      if ('error' in result) {
        toast({ title: 'Save failed', description: result.error, variant: 'destructive' })
        return
      }
      toast({ title: editingRate ? 'Tax rate updated' : 'Tax rate added' })
      onSaved()
    } catch (error: unknown) {
      toast({
        title: 'Save failed',
        description: error instanceof Error ? error.message : 'Failed to save tax rate',
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
          <DialogTitle>{editingRate ? 'Edit Tax Rate' : 'Add Tax Rate'}</DialogTitle>
          <DialogDescription>
            {editingRate
              ? 'Update this tax rate. Menu items using it pick up the change immediately.'
              : 'Add a tax rate that menu items can be assigned to (e.g. Standard, Zero-rated).'}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="tax-rate-name">Name</Label>
            <Input
              id="tax-rate-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Standard"
              disabled={submitting}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="tax-rate-percentage">Percentage</Label>
            <Input
              id="tax-rate-percentage"
              type="number"
              step="0.01"
              min="0"
              value={percentage}
              onChange={(e) => setPercentage(e.target.value)}
              placeholder="15"
              disabled={submitting}
            />
          </div>

          <div className="flex items-center justify-between gap-4 rounded-lg border p-4">
            <div className="space-y-1">
              <Label htmlFor="tax-rate-inclusive" className="font-medium">
                Tax-inclusive
              </Label>
              <p className="text-sm text-muted-foreground">
                On: price already includes tax. Off: tax is added on top.
              </p>
            </div>
            <Switch
              id="tax-rate-inclusive"
              checked={isInclusive}
              onCheckedChange={setIsInclusive}
              disabled={submitting}
            />
          </div>

          {!editingRate ? (
            <div className="flex items-center justify-between gap-4 rounded-lg border p-4">
              <div className="space-y-1">
                <Label htmlFor="tax-rate-default" className="font-medium">
                  Set as default
                </Label>
                <p className="text-sm text-muted-foreground">
                  Applies to items that don&apos;t have a tax rate explicitly chosen.
                </p>
              </div>
              <Switch
                id="tax-rate-default"
                checked={isDefault}
                onCheckedChange={setIsDefault}
                disabled={submitting}
              />
            </div>
          ) : null}
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
            {submitting ? 'Saving...' : editingRate ? 'Save Changes' : 'Add Tax Rate'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
