'use client'

import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { configureCanonicalItemAction } from '@/lib/stock/transfer-actions'

export type ConfigureCanonicalItemTarget = {
  organizationStockItemId: string
  itemName: string
  baseUnitId: string
  baseUnitLabel: string
  restaurantId: string
  restaurantName: string
}

/**
 * Links an EXISTING canonical (organization_stock_items) item to a new local stock_items
 * row at a specific restaurant -- distinct from CreateStockItemDialog, which always mints a
 * brand-new canonical item. Reusing that flow here would silently fork a second, disconnected
 * canonical item with the same name instead of configuring the one already referenced by a
 * transfer, so this calls configureCanonicalItemAction instead. Unit is locked to the
 * canonical item's base unit -- keeping every location's mapping in the same unit avoids a
 * per-restaurant unit mismatch this app doesn't reconcile anywhere.
 */
export function ConfigureCanonicalItemDialog({
  target,
  open,
  onOpenChange,
  onConfigured,
}: {
  target: ConfigureCanonicalItemTarget | null
  open: boolean
  onOpenChange: (open: boolean) => void
  onConfigured: (target: ConfigureCanonicalItemTarget) => void
}) {
  const [name, setName] = useState(target?.itemName ?? '')
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  /* eslint-disable react-hooks/set-state-in-effect -- reset the form each time a new target opens */
  useEffect(() => {
    if (open && target) {
      setName(target.itemName)
      setError(null)
    }
  }, [open, target])
  /* eslint-enable react-hooks/set-state-in-effect */

  if (!target) return null

  const handleSave = async () => {
    setSaving(true)
    setError(null)
    const result = await configureCanonicalItemAction({
      organizationStockItemId: target.organizationStockItemId,
      restaurantId: target.restaurantId,
      unitId: target.baseUnitId,
      name,
    })
    setSaving(false)

    if ('error' in result) {
      setError(result.error)
      return
    }

    onConfigured(target)
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="border-[#E9E9E7]">
        <DialogHeader>
          <DialogTitle>Configure &quot;{target.itemName}&quot; at {target.restaurantName}</DialogTitle>
          <DialogDescription>
            This canonical item exists in your organization but hasn&apos;t been set up at{' '}
            {target.restaurantName} yet. Configuring it links the two so stock can be tracked
            there.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          {error ? (
            <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
              {error}
            </div>
          ) : null}
          <div className="space-y-1.5">
            <Label htmlFor="configure-item-name">Name at {target.restaurantName}</Label>
            <Input
              id="configure-item-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              className="border-[#E9E9E7]"
            />
          </div>
          <div className="space-y-1.5">
            <Label>Unit</Label>
            <p className="rounded-lg border border-[#E9E9E7] bg-[#FAFAF8] px-3 py-2 text-sm text-[#37352F]">
              {target.baseUnitLabel}
            </p>
            <p className="text-xs text-[#6B675F]">
              Matches the organization&apos;s unit for this item, so transfers stay in the same unit
              at every location.
            </p>
          </div>
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            type="button"
            onClick={() => void handleSave()}
            disabled={saving || !name.trim()}
            className="bg-[#FF6B35] text-white hover:bg-[#e85f2f]"
          >
            {saving ? 'Configuring...' : `Configure at ${target.restaurantName}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
