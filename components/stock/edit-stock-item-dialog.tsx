'use client'

import { useState } from 'react'
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
import { MeasurementUnitSelectField } from '@/components/stock/measurement-unit-select-field'
import { updateStockItemAction } from '@/lib/stock/actions'
import type { MeasurementUnitOption } from '@/lib/measurement-units/format'
import type { StockOverviewRow } from '@/lib/stock/queries'

function EditStockItemForm({
  item,
  measurementUnits,
  onMeasurementUnitsChange,
  onOpenChange,
  onSaved,
}: {
  item: StockOverviewRow
  measurementUnits: MeasurementUnitOption[]
  onMeasurementUnitsChange?: (units: MeasurementUnitOption[]) => void
  onOpenChange: (open: boolean) => void
  onSaved: (message: string) => void
}) {
  const [name, setName] = useState(item.name)
  const [unitId, setUnitId] = useState(item.unit_id)
  const [parLevel, setParLevel] = useState(item.par_level != null ? String(item.par_level) : '')
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const handleSave = async () => {
    const trimmedParLevel = parLevel.trim()
    const parsedParLevel =
      trimmedParLevel === '' ? null : Number(trimmedParLevel)

    if (
      parsedParLevel != null &&
      (!Number.isFinite(parsedParLevel) || parsedParLevel < 0)
    ) {
      setError('Low stock threshold must be zero or greater, or left blank.')
      return
    }

    setSaving(true)
    setError(null)
    const result = await updateStockItemAction({
      stockItemId: item.id,
      name,
      unitId,
      parLevel: parsedParLevel,
    })
    setSaving(false)

    if (result.error) {
      setError(result.error)
      return
    }

    onSaved(`Updated ${result.data?.name ?? item.name}.`)
    onOpenChange(false)
  }

  return (
    <>
      <div className="space-y-4">
        {error ? (
          <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
            {error}
          </div>
        ) : null}
        <div className="space-y-1.5">
          <Label htmlFor="edit-item-name">Name</Label>
          <Input
            id="edit-item-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            className="border-[#E9E9E7]"
          />
        </div>
        <MeasurementUnitSelectField
          measurementUnits={measurementUnits}
          onMeasurementUnitsChange={onMeasurementUnitsChange}
          value={unitId}
          onValueChange={setUnitId}
          label="Unit"
        />
        <div className="space-y-1.5">
          <Label htmlFor="edit-item-par-level">Low stock threshold (optional)</Label>
          <Input
            id="edit-item-par-level"
            type="number"
            min="0"
            step="any"
            value={parLevel}
            onChange={(event) => setParLevel(event.target.value)}
            placeholder="Leave blank for no threshold"
            className="border-[#E9E9E7]"
          />
          <p className="text-xs text-[#6B675F]">
            Same unit as this item ({item.unit_label}). Used for Low Stock alerts on the overview.
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
          disabled={saving}
          className="bg-[#FF6B35] text-white hover:bg-[#e85f2f]"
        >
          {saving ? 'Saving...' : 'Save changes'}
        </Button>
      </DialogFooter>
    </>
  )
}

export function EditStockItemDialog({
  item,
  open,
  onOpenChange,
  measurementUnits,
  onMeasurementUnitsChange,
  onSaved,
}: {
  item: StockOverviewRow | null
  open: boolean
  onOpenChange: (open: boolean) => void
  measurementUnits: MeasurementUnitOption[]
  onMeasurementUnitsChange?: (units: MeasurementUnitOption[]) => void
  onSaved: (message: string) => void
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="border-[#E9E9E7]">
        <DialogHeader>
          <DialogTitle>Edit stock item</DialogTitle>
          <DialogDescription>
            Change the item name, unit, or low stock threshold. Stock balances are not affected.
          </DialogDescription>
        </DialogHeader>

        {open && item ? (
          <EditStockItemForm
            key={item.id}
            item={item}
            measurementUnits={measurementUnits}
            onMeasurementUnitsChange={onMeasurementUnitsChange}
            onOpenChange={onOpenChange}
            onSaved={onSaved}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  )
}
