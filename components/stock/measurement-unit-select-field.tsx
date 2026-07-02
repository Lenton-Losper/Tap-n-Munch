'use client'

import { useMemo, useState } from 'react'
import { Label } from '@/components/ui/label'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
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
import { createMeasurementUnitAction } from '@/lib/measurement-units/actions'
import { formatMeasurementUnitLabel, type MeasurementUnitOption } from '@/lib/measurement-units/format'

export function MeasurementUnitSelectField({
  measurementUnits,
  onMeasurementUnitsChange,
  value,
  onValueChange,
  disabled = false,
  allowCreate = true,
  label = 'Unit',
}: {
  measurementUnits: MeasurementUnitOption[]
  onMeasurementUnitsChange?: (units: MeasurementUnitOption[]) => void
  value: string
  onValueChange: (unitId: string) => void
  disabled?: boolean
  allowCreate?: boolean
  label?: string
}) {
  const [createOpen, setCreateOpen] = useState(false)
  const [newUnitName, setNewUnitName] = useState('')
  const [newUnitSymbol, setNewUnitSymbol] = useState('')
  const [createError, setCreateError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)

  const unitOptions = useMemo(
    () => [...measurementUnits].sort((a, b) => a.name.localeCompare(b.name)),
    [measurementUnits],
  )

  const resetCreateForm = () => {
    setNewUnitName('')
    setNewUnitSymbol('')
    setCreateError(null)
  }

  const handleCreateUnit = async () => {
    setCreating(true)
    setCreateError(null)
    const result = await createMeasurementUnitAction({
      name: newUnitName,
      symbol: newUnitSymbol || null,
    })
    setCreating(false)

    if (result.error || !result.data) {
      setCreateError(result.error ?? 'Failed to create unit.')
      return
    }

    const created = result.data
    onMeasurementUnitsChange?.([...measurementUnits, created])
    onValueChange(created.id)
    resetCreateForm()
    setCreateOpen(false)
  }

  return (
    <>
      <div className="space-y-1.5">
        <Label>{label}</Label>
        <Select value={value} onValueChange={onValueChange} disabled={disabled}>
          <SelectTrigger className="w-full border-[#E9E9E7] bg-white">
            <SelectValue placeholder="Select unit" />
          </SelectTrigger>
          <SelectContent>
            {unitOptions.map((unit) => (
              <SelectItem key={unit.id} value={unit.id}>
                {unit.name}
                {unit.symbol && unit.symbol !== unit.name ? ` (${unit.symbol})` : ''}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {allowCreate && !disabled ? (
          <button
            type="button"
            onClick={() => {
              resetCreateForm()
              setCreateOpen(true)
            }}
            className="text-xs font-medium text-[#FF6B35] hover:underline"
          >
            + Create unit
          </button>
        ) : null}
      </div>

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="border-[#E9E9E7]">
          <DialogHeader>
            <DialogTitle>Create measurement unit</DialogTitle>
            <DialogDescription>
              Add a custom unit for this restaurant (e.g. loaf, bunch).
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            {createError ? (
              <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
                {createError}
              </div>
            ) : null}
            <div className="space-y-1.5">
              <Label htmlFor="new-unit-name">Name</Label>
              <Input
                id="new-unit-name"
                value={newUnitName}
                onChange={(event) => setNewUnitName(event.target.value)}
                className="border-[#E9E9E7]"
                placeholder="e.g. loaf"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="new-unit-symbol">Symbol (optional)</Label>
              <Input
                id="new-unit-symbol"
                value={newUnitSymbol}
                onChange={(event) => setNewUnitSymbol(event.target.value)}
                className="border-[#E9E9E7]"
                placeholder={formatMeasurementUnitLabel({ name: newUnitName || 'unit', symbol: null })}
              />
            </div>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setCreateOpen(false)}>
              Cancel
            </Button>
            <Button
              type="button"
              onClick={() => void handleCreateUnit()}
              disabled={creating}
              className="bg-[#FF6B35] text-white hover:bg-[#e85f2f]"
            >
              {creating ? 'Creating...' : 'Create unit'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
