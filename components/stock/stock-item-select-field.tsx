'use client'

import { useMemo, useState } from 'react'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { CreateStockItemDialog } from '@/components/stock/create-stock-item-dialog'
import type { MeasurementUnitOption } from '@/lib/measurement-units/format'
import type { StockItemOption } from '@/lib/stock/queries'

export function StockItemSelectField({
  stockItems,
  onStockItemsChange,
  measurementUnits,
  onMeasurementUnitsChange,
  value,
  onValueChange,
  disabled = false,
  allowCreate = true,
  label = 'Stock item',
}: {
  stockItems: StockItemOption[]
  onStockItemsChange: (items: StockItemOption[]) => void
  measurementUnits: MeasurementUnitOption[]
  onMeasurementUnitsChange?: (units: MeasurementUnitOption[]) => void
  value: string
  onValueChange: (stockItemId: string) => void
  disabled?: boolean
  allowCreate?: boolean
  label?: string
}) {
  const [createOpen, setCreateOpen] = useState(false)

  const stockItemOptions = useMemo(
    () => [...stockItems].sort((a, b) => a.name.localeCompare(b.name)),
    [stockItems],
  )

  return (
    <>
      <div className="space-y-1.5">
        <Label>{label}</Label>
        <Select value={value} onValueChange={onValueChange} disabled={disabled}>
          <SelectTrigger className="w-full border-[#E9E9E7] bg-white">
            <SelectValue placeholder="Select item" />
          </SelectTrigger>
          <SelectContent>
            {stockItemOptions.map((item) => (
              <SelectItem key={item.id} value={item.id}>
                {item.name} ({item.unit_label})
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {allowCreate && !disabled ? (
          <button
            type="button"
            onClick={() => setCreateOpen(true)}
            className="text-xs font-medium text-[#FF6B35] hover:underline"
          >
            + Create item
          </button>
        ) : null}
      </div>

      <CreateStockItemDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        measurementUnits={measurementUnits}
        onMeasurementUnitsChange={onMeasurementUnitsChange}
        onCreated={(created) => {
          onStockItemsChange([...stockItems, created])
          onValueChange(created.id)
        }}
      />
    </>
  )
}
