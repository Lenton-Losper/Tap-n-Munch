'use client'

import { useMemo } from 'react'
import { Plus, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { MeasurementUnitSelectField } from '@/components/stock/measurement-unit-select-field'
import { SearchableStockItemSelectField } from '@/components/stock/searchable-stock-item-select-field'
import type { MeasurementUnitOption } from '@/lib/measurement-units/format'
import type { StockItemOption, StockItemOptionWithLevel } from '@/lib/stock/queries'

export type MenuItemIngredientRow = {
  key: string
  stockItemId: string
  quantity: string
  unitId: string
}

function emptyIngredientRow(): MenuItemIngredientRow {
  return { key: crypto.randomUUID(), stockItemId: '', quantity: '', unitId: '' }
}

export function toIngredientRowsFromLoaded(
  ingredients: Array<{ stockItemId: string; quantity: number; unitId: string }>,
): MenuItemIngredientRow[] {
  if (ingredients.length === 0) return [emptyIngredientRow()]
  return ingredients.map((row) => ({
    key: crypto.randomUUID(),
    stockItemId: row.stockItemId,
    quantity: String(row.quantity),
    unitId: row.unitId,
  }))
}

export function MenuItemInventoryTab({
  trackInventory,
  rows,
  onRowsChange,
  stockItems,
  onStockItemsChange,
  measurementUnits,
  onMeasurementUnitsChange,
  disabled = false,
}: {
  trackInventory: boolean
  rows: MenuItemIngredientRow[]
  onRowsChange: (rows: MenuItemIngredientRow[]) => void
  stockItems: StockItemOptionWithLevel[]
  onStockItemsChange: (items: StockItemOption[]) => void
  measurementUnits: MeasurementUnitOption[]
  onMeasurementUnitsChange?: (units: MeasurementUnitOption[]) => void
  disabled?: boolean
}) {
  const stockItemById = useMemo(
    () => new Map(stockItems.map((item) => [item.id, item])),
    [stockItems],
  )

  const validRows = rows.filter(
    (row) => row.stockItemId && row.unitId && Number(row.quantity) > 0,
  )

  const hasMissingIngredient = validRows.some((row) => !stockItemById.has(row.stockItemId))

  const updateRow = (key: string, patch: Partial<MenuItemIngredientRow>) => {
    onRowsChange(rows.map((row) => (row.key === key ? { ...row, ...patch } : row)))
  }

  const handleStockItemChange = (key: string, stockItemId: string) => {
    const stockItem = stockItemById.get(stockItemId)
    updateRow(key, {
      stockItemId,
      unitId: stockItem?.unit_id ?? '',
    })
  }

  const completeness = useMemo(() => {
    if (!trackInventory) return null
    if (hasMissingIngredient) {
      return { tone: 'amber' as const, message: '⚠ Missing Ingredients' }
    }
    if (validRows.length >= 1) {
      return {
        tone: 'green' as const,
        message: `✓ Inventory Complete — ${validRows.length} Ingredients`,
      }
    }
    return null
  }, [trackInventory, hasMissingIngredient, validRows.length])

  return (
    <div className="space-y-4">
      {trackInventory ? (
        <>
          {completeness ? (
            <div
              className={`rounded-lg border px-3 py-2 text-sm ${
                completeness.tone === 'amber'
                  ? 'border-amber-200 bg-amber-50 text-amber-800'
                  : 'border-green-200 bg-green-50 text-green-800'
              }`}
            >
              {completeness.message}
            </div>
          ) : null}

          <div className="flex items-center justify-between gap-3">
            <div>
              <h3 className="font-medium text-[#37352F]">Ingredients</h3>
              <p className="text-sm text-muted-foreground">
                Quantities are per single unit sold of this menu item.
              </p>
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => onRowsChange([...rows, emptyIngredientRow()])}
              disabled={disabled}
            >
              <Plus className="mr-2 h-4 w-4" />
              Add Ingredient
            </Button>
          </div>

          <div className="space-y-4">
            {rows.map((row, index) => (
              <div
                key={row.key}
                className="grid gap-3 rounded-xl border border-[#E9E9E7] bg-[#FAFAF8] p-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)_auto]"
              >
                <SearchableStockItemSelectField
                  stockItems={stockItems}
                  onStockItemsChange={onStockItemsChange}
                  measurementUnits={measurementUnits}
                  onMeasurementUnitsChange={onMeasurementUnitsChange}
                  value={row.stockItemId}
                  onValueChange={(value) => handleStockItemChange(row.key, value)}
                  disabled={disabled}
                  allowCreate={!disabled}
                  label="Ingredient"
                />
                <div className="space-y-1.5">
                  <Label htmlFor={`ingredient-qty-${row.key}`}>Quantity</Label>
                  <Input
                    id={`ingredient-qty-${row.key}`}
                    type="number"
                    min="0"
                    step="any"
                    value={row.quantity}
                    onChange={(event) => updateRow(row.key, { quantity: event.target.value })}
                    className="border-[#E9E9E7] bg-white"
                    disabled={disabled}
                  />
                </div>
                <MeasurementUnitSelectField
                  measurementUnits={measurementUnits}
                  onMeasurementUnitsChange={onMeasurementUnitsChange}
                  value={row.unitId}
                  onValueChange={(unitId) => updateRow(row.key, { unitId })}
                  disabled={disabled}
                  allowCreate={!disabled}
                  label="Unit"
                />
                <div className="flex items-end justify-end">
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    onClick={() =>
                      onRowsChange(rows.length === 1 ? rows : rows.filter((r) => r.key !== row.key))
                    }
                    disabled={disabled || rows.length === 1}
                    aria-label={`Remove ingredient row ${index + 1}`}
                  >
                    <X className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            ))}
          </div>
        </>
      ) : null}
    </div>
  )
}

export { emptyIngredientRow }
