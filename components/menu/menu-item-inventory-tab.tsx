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
import {
  findRecipeQuantityWarnings,
  type RecipeQuantityWarningCode,
} from '@/lib/recipes/quantity-sanity'

/**
 * SIGNED COPY, 2026-08-27. Every string below is the owner's wording, verbatim.
 *
 * These rendered as `[PLACEHOLDER: ...]` on production to a live venue until today, because the
 * placeholder gate matches PENDING COPY / COPY PENDING and had never heard of PLACEHOLDER -- a
 * third spelling of the same convention.
 *
 * WHAT THE WARNINGS MUST KEEP. They read as questions, not accusations -- each is a heuristic, the
 * merchant may well be right, and none of them stops a save. TWO EXCEPTIONS TO THAT, both ruled
 * deliberately:
 *   exceeds_on_hand      is blunt on purpose. It is the Mingle nine caught at entry -- a delivery
 *                        count typed into a per-sale field, where one sale ate the whole delivery.
 *                        It states a consequence rather than asking a question.
 *   one_to_one_not_single names the 25ml tot explicitly, so a bar manager recognises their own
 *                        case in the sentence instead of wondering whether they have erred.
 */
const QUANTITY_FIELD_LABEL = 'Quantity used per single sale'

const QUANTITY_WARNING_COPY: Record<RecipeQuantityWarningCode, string> = {
  // Convey: this is exactly what you have in stock. Did you mean how much ONE sale uses?
  // Selling one would take the whole lot.
  equals_on_hand: 'this is exactly what you have in stock. did you mean how much one sale uses? as entered, selling one would take the whole lot.',
  // Convey: this is more than you have, so the first sale takes the balance below zero.
  exceeds_on_hand: 'this is more than you have in stock. as entered, the first sale takes the balance below zero.',
  // Convey: this ingredient is the same thing as the item being sold, so one sale should
  // normally use one — unless the stock item is counted in smaller pieces.
  one_to_one_not_single: 'this ingredient is the same item being sold, so one sale would normally use 1. that is fine if the stock item is counted in smaller pieces - a 25ml tot from a 750ml bottle, for example.',
}

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
  menuItemName = '',
  rows,
  onRowsChange,
  stockItems,
  onStockItemsChange,
  measurementUnits,
  onMeasurementUnitsChange,
  disabled = false,
}: {
  trackInventory: boolean
  /** Used only to spot a recipe whose single ingredient IS the item being sold. */
  menuItemName?: string
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

  // Advisory only — nothing here blocks a save. See lib/recipes/quantity-sanity.ts for what the
  // signals are and the production evidence behind them.
  //
  // Only the two balance-derived signals can fire on this surface, and that is by construction:
  // a stock item present in the loaded list always has a balance, and one absent from it has
  // neither a balance nor a name. The names are still passed so that the call stays correct if
  // that ever stops being true, but blanking either of them today fails no test — which was
  // verified by mutation rather than assumed. The name-based fallback earns its keep on the
  // standalone recipe editor, which knows names and does not load balances.
  const quantityWarningByStockItem = useMemo(() => {
    const found = findRecipeQuantityWarnings(
      menuItemName,
      rows.map((row) => ({
        stockItemId: row.stockItemId,
        quantity: row.quantity,
        stockItemName: stockItemById.get(row.stockItemId)?.name ?? null,
        // `undefined` rather than 0 when the item is not in the loaded list, so an unknown
        // balance suppresses the balance signals instead of reading as an empty shelf.
        currentStock: stockItemById.get(row.stockItemId)?.currentStock,
      })),
    )
    return new Map(found.map((warning) => [warning.stockItemId, warning]))
  }, [menuItemName, rows, stockItemById])

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
                  {/* Signed 2026-08-27. It must keep saying that this number is what ONE sale uses, by
                      selling ONE of this menu item, not how many are in stock. The bare word
                      "Quantity" is what let a delivery count be typed here nine times. */}
                  <Label htmlFor={`ingredient-qty-${row.key}`}>
                    {QUANTITY_FIELD_LABEL}
                  </Label>
                  <Input
                    id={`ingredient-qty-${row.key}`}
                    type="number"
                    min="0"
                    step="any"
                    value={row.quantity}
                    onChange={(event) => updateRow(row.key, { quantity: event.target.value })}
                    className="border-[#E9E9E7] bg-white"
                    disabled={disabled}
                    aria-describedby={
                      quantityWarningByStockItem.has(row.stockItemId)
                        ? `ingredient-qty-warning-${row.key}`
                        : undefined
                    }
                  />
                  {quantityWarningByStockItem.has(row.stockItemId) ? (
                    <p
                      id={`ingredient-qty-warning-${row.key}`}
                      role="status"
                      className="rounded-md border border-amber-200 bg-amber-50 px-2 py-1.5 text-xs text-amber-800"
                    >
                      {/* Signed 2026-08-27 — see QUANTITY_WARNING_COPY. */}
                      {QUANTITY_WARNING_COPY[
                        quantityWarningByStockItem.get(row.stockItemId)!.code
                      ]}
                    </p>
                  ) : null}
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
