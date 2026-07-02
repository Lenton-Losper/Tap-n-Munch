'use client'

import { useMemo, useState } from 'react'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { CreateStockItemDialog } from '@/components/stock/create-stock-item-dialog'
import { formatStockQuantity } from '@/lib/stock/format'
import type { MeasurementUnitOption } from '@/lib/measurement-units/format'
import type { StockItemOption, StockItemOptionWithLevel } from '@/lib/stock/queries'

export function SearchableStockItemSelectField({
  stockItems,
  onStockItemsChange,
  measurementUnits,
  onMeasurementUnitsChange,
  value,
  onValueChange,
  disabled = false,
  allowCreate = true,
  label = 'Ingredient',
}: {
  stockItems: StockItemOptionWithLevel[]
  onStockItemsChange: (items: StockItemOption[]) => void
  measurementUnits: MeasurementUnitOption[]
  onMeasurementUnitsChange?: (units: MeasurementUnitOption[]) => void
  value: string
  onValueChange: (stockItemId: string) => void
  disabled?: boolean
  allowCreate?: boolean
  label?: string
}) {
  const [query, setQuery] = useState('')
  const [createOpen, setCreateOpen] = useState(false)
  const [open, setOpen] = useState(false)

  const selected = stockItems.find((item) => item.id === value)

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    const sorted = [...stockItems].sort((a, b) => a.name.localeCompare(b.name))
    if (!q) return sorted
    return sorted.filter((item) => item.name.toLowerCase().includes(q))
  }, [query, stockItems])

  return (
    <>
      <div className="relative space-y-1.5">
        <Label>{label}</Label>
        <Input
          value={open ? query : (selected?.name ?? '')}
          onChange={(event) => {
            setQuery(event.target.value)
            setOpen(true)
          }}
          onFocus={() => {
            setQuery(selected?.name ?? '')
            setOpen(true)
          }}
          onBlur={() => {
            window.setTimeout(() => setOpen(false), 150)
          }}
          placeholder="Search ingredients..."
          className="border-[#E9E9E7] bg-white"
          disabled={disabled}
        />
        {open && !disabled ? (
          <div className="absolute z-20 mt-1 max-h-56 w-full overflow-y-auto rounded-lg border border-[#E9E9E7] bg-white shadow-md">
            {filtered.length === 0 ? (
              <p className="px-3 py-2 text-sm text-[#6B675F]">No ingredients match your search.</p>
            ) : (
              filtered.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className="flex w-full flex-col items-start px-3 py-2 text-left text-sm hover:bg-[#FAFAF8]"
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => {
                    onValueChange(item.id)
                    setQuery(item.name)
                    setOpen(false)
                  }}
                >
                  <span className="font-medium text-[#37352F]">{item.name}</span>
                  <span className="text-xs text-[#6B675F]">
                    Current Stock: {formatStockQuantity(item.currentStock, item.unit_label)}
                  </span>
                </button>
              ))
            )}
          </div>
        ) : null}
        {allowCreate && !disabled ? (
          <button
            type="button"
            onClick={() => setCreateOpen(true)}
            className="text-xs font-medium text-[#FF6B35] hover:underline"
          >
            + Create ingredient
          </button>
        ) : null}
      </div>

      <CreateStockItemDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        measurementUnits={measurementUnits}
        onMeasurementUnitsChange={onMeasurementUnitsChange}
        onCreated={(created) => {
          onStockItemsChange([...stockItems, { ...created, currentStock: 0 }])
          onValueChange(created.id)
          setQuery(created.name)
        }}
      />
    </>
  )
}
