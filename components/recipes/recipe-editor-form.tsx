'use client'

import { useMemo, useState, useTransition } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { Plus, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { MeasurementUnitSelectField } from '@/components/stock/measurement-unit-select-field'
import { StockItemSelectField } from '@/components/stock/stock-item-select-field'
import { removeRecipeLinkAction, saveRecipeAction } from '@/lib/recipes/actions'
import {
  findRecipeQuantityWarnings,
  type RecipeQuantityWarningCode,
} from '@/lib/recipes/quantity-sanity'
import type { RecipeEditorData } from '@/lib/recipes/queries'
import type { MeasurementUnitOption } from '@/lib/measurement-units/format'
import type { StockItemOption } from '@/lib/stock/queries'

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
  equals_on_hand: 'this is exactly what you have in stock. did you mean how much one sale uses? as entered, selling one would take the whole lot.',
  exceeds_on_hand: 'this is more than you have in stock. as entered, the first sale takes the balance below zero.',
  one_to_one_not_single: 'this ingredient is the same item being sold, so one sale would normally use 1. that is fine if the stock item is counted in smaller pieces - a 25ml tot from a 750ml bottle, for example.',
}

type IngredientRow = {
  key: string
  stockItemId: string
  quantity: string
  unitId: string
}

function toIngredientRows(ingredients: RecipeEditorData['ingredients']): IngredientRow[] {
  if (ingredients.length === 0) {
    return [{ key: crypto.randomUUID(), stockItemId: '', quantity: '', unitId: '' }]
  }
  return ingredients.map((row) => ({
    key: crypto.randomUUID(),
    stockItemId: row.stockItemId,
    quantity: String(row.quantity),
    unitId: row.unitId,
  }))
}

function emptyRow(): IngredientRow {
  return { key: crypto.randomUUID(), stockItemId: '', quantity: '', unitId: '' }
}

export function RecipeEditorForm({
  data,
  stockItems: initialStockItems,
  measurementUnits: initialMeasurementUnits,
  canEdit,
}: {
  data: RecipeEditorData
  stockItems: StockItemOption[]
  measurementUnits: MeasurementUnitOption[]
  canEdit: boolean
}) {
  const router = useRouter()
  const [stockItems, setStockItems] = useState(initialStockItems)
  const [measurementUnits, setMeasurementUnits] = useState(initialMeasurementUnits)
  const [rows, setRows] = useState<IngredientRow[]>(() => toIngredientRows(data.ingredients))
  const [error, setError] = useState<string | null>(null)
  const [successMessage, setSuccessMessage] = useState<string | null>(null)
  const [isPending, startTransition] = useTransition()
  const [confirmingRemove, setConfirmingRemove] = useState(false)
  const [removing, setRemoving] = useState(false)

  const handleRemoveLink = () => {
    setError(null)
    setSuccessMessage(null)
    setConfirmingRemove(true)
  }

  // Soft delete: the recipe is tombstoned (deleted_at set) and tracking switched off. The row
  // and its ingredients are kept as the record of what the recipe was -- state is marked
  // explicitly rather than erased. Every read path filters on deleted_at, so it is gone from
  // the merchant's point of view and stops deducting. Historic stock movements are untouched.
  const confirmRemoveLink = () => {
    setRemoving(true)
    setError(null)
    startTransition(async () => {
      const result = await removeRecipeLinkAction(data.menuItemId)
      setRemoving(false)
      if (result.error) {
        setConfirmingRemove(false)
        setError(result.error)
        return
      }
      setConfirmingRemove(false)
      setRows(toIngredientRows([]))
      setSuccessMessage(
        'Stock link removed. This item no longer deducts stock. Past movements are unchanged, and you can link it again at any time.',
      )
      router.refresh()
    })
  }

  const stockItemById = useMemo(
    () => new Map(stockItems.map((item) => [item.id, item])),
    [stockItems],
  )

  // Advisory only — nothing here blocks a save. This surface does NOT load ledger balances, so
  // only the name-based fallback signal can fire: a single-ingredient recipe whose one ingredient
  // is the menu item itself, carrying a quantity other than 1. Balances are deliberately left as
  // undefined rather than 0 — reading "not loaded here" as "empty shelf" would warn on every row.
  const quantityWarningByStockItem = useMemo(() => {
    const found = findRecipeQuantityWarnings(
      data.menuItemName,
      rows.map((row) => ({
        stockItemId: row.stockItemId,
        quantity: row.quantity,
        stockItemName: stockItemById.get(row.stockItemId)?.name ?? null,
        currentStock: undefined,
      })),
    )
    return new Map(found.map((warning) => [warning.stockItemId, warning]))
  }, [data.menuItemName, rows, stockItemById])

  const updateRow = (key: string, patch: Partial<IngredientRow>) => {
    setRows((current) => current.map((row) => (row.key === key ? { ...row, ...patch } : row)))
  }

  const handleStockItemChange = (key: string, stockItemId: string) => {
    const stockItem = stockItemById.get(stockItemId)
    updateRow(key, {
      stockItemId,
      unitId: stockItem?.unit_id ?? '',
    })
  }

  const addRow = () => {
    setRows((current) => [...current, emptyRow()])
  }

  const removeRow = (key: string) => {
    setRows((current) => (current.length === 1 ? current : current.filter((row) => row.key !== key)))
  }

  const handleSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!canEdit) return

    setError(null)
    setSuccessMessage(null)

    const ingredients = rows
      .filter((row) => row.stockItemId && row.unitId && Number(row.quantity) > 0)
      .map((row) => ({
        stockItemId: row.stockItemId,
        quantity: Number(row.quantity),
        unitId: row.unitId,
      }))

    startTransition(async () => {
      const result = await saveRecipeAction({
        menuItemId: data.menuItemId,
        ingredients,
      })

      if (result.error) {
        setError(result.error)
        return
      }

      setSuccessMessage('Recipe saved.')
      router.refresh()
    })
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      {successMessage ? (
        <div className="rounded-2xl border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-800">
          {successMessage}
        </div>
      ) : null}
      {error ? (
        <div className="rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
          {error}
        </div>
      ) : null}

      <div className="rounded-2xl border border-[#E9E9E7] bg-white p-5">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-[#6B675F]">Menu item</p>
            <h2 className="font-serif text-2xl font-semibold text-[#37352F]">{data.menuItemName}</h2>
          </div>
          {!canEdit ? (
            <p className="text-sm text-[#6B675F]">Read-only — you do not have permission to edit recipes.</p>
          ) : null}
        </div>
      </div>

      <div className="rounded-2xl border border-[#E9E9E7] bg-white p-5">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h3 className="font-serif text-xl font-semibold text-[#37352F]">Ingredients</h3>
            <p className="mt-1 text-sm text-[#6B675F]">
              Quantities are per single unit sold of this menu item.
            </p>
          </div>
          {canEdit ? (
            <Button type="button" variant="outline" onClick={addRow} className="border-[#E9E9E7]">
              <Plus className="mr-2 h-4 w-4" />
              Add ingredient
            </Button>
          ) : null}
        </div>

        <div className="mt-4 space-y-4">
          {rows.map((row, index) => (
            <div
              key={row.key}
              className="grid gap-3 rounded-xl border border-[#E9E9E7] bg-[#FAFAF8] p-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)_auto]"
            >
              <StockItemSelectField
                stockItems={stockItems}
                onStockItemsChange={setStockItems}
                measurementUnits={measurementUnits}
                onMeasurementUnitsChange={setMeasurementUnits}
                value={row.stockItemId}
                onValueChange={(value) => handleStockItemChange(row.key, value)}
                disabled={!canEdit}
                allowCreate={canEdit}
                label="Stock item"
              />
              <div className="space-y-1.5">
                {/* Signed 2026-08-27. It must keep saying that this number is what ONE sale uses, by
                    selling ONE of this menu item, not how many are in stock. */}
                <Label htmlFor={`quantity-${row.key}`}>{QUANTITY_FIELD_LABEL}</Label>
                <Input
                  id={`quantity-${row.key}`}
                  type="number"
                  min="0"
                  step="any"
                  value={row.quantity}
                  onChange={(event) => updateRow(row.key, { quantity: event.target.value })}
                  className="border-[#E9E9E7] bg-white"
                  disabled={!canEdit}
                  aria-describedby={
                    quantityWarningByStockItem.has(row.stockItemId)
                      ? `quantity-warning-${row.key}`
                      : undefined
                  }
                />
                {quantityWarningByStockItem.has(row.stockItemId) ? (
                  <p
                    id={`quantity-warning-${row.key}`}
                    role="status"
                    className="rounded-md border border-amber-200 bg-amber-50 px-2 py-1.5 text-xs text-amber-800"
                  >
                    {QUANTITY_WARNING_COPY[
                      quantityWarningByStockItem.get(row.stockItemId)!.code
                    ]}
                  </p>
                ) : null}
              </div>
              <MeasurementUnitSelectField
                measurementUnits={measurementUnits}
                onMeasurementUnitsChange={setMeasurementUnits}
                value={row.unitId}
                onValueChange={(unitId) => updateRow(row.key, { unitId })}
                disabled={!canEdit}
                allowCreate={canEdit}
                label="Unit"
              />
              <div className="flex items-end justify-end">
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  onClick={() => removeRow(row.key)}
                  disabled={!canEdit || rows.length === 1}
                  aria-label={`Remove ingredient row ${index + 1}`}
                >
                  <X className="h-4 w-4" />
                </Button>
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="flex flex-wrap gap-3">
        <Button
          type="submit"
          disabled={!canEdit || isPending}
          className="bg-[#FF6B35] text-white hover:bg-[#e85f2f] disabled:opacity-50"
        >
          {isPending ? 'Saving...' : 'Save recipe'}
        </Button>
        <Button type="button" variant="outline" className="border-[#E9E9E7]" asChild>
          <Link href="/stock/recipes">Back to recipes</Link>
        </Button>

        {/* Unlinking is deliberately distinct from turning tracking off. Unticking "Track
            inventory" used to be the only lever, so it had to mean both "pause this" and
            "undo this" — which is how items ended up linked but untracked. */}
        {canEdit && data.ingredients.length > 0 ? (
          <Button
            type="button"
            variant="outline"
            disabled={isPending || removing}
            onClick={handleRemoveLink}
            className="ml-auto border-red-200 text-red-800 hover:bg-red-50"
          >
            {removing ? 'Removing…' : 'Remove stock link'}
          </Button>
        ) : null}
      </div>

      {confirmingRemove ? (
        <div className="rounded-2xl border border-red-200 bg-red-50 p-5">
          <p className="text-sm font-medium text-red-900">
            Remove this recipe and its stock link?
          </p>
          <p className="mt-1 text-sm text-red-800">
            {data.menuItemName} will stop deducting stock and disappear from your inventory
            screens. Past stock movements are kept — your history is not changed — and the
            recipe is retained as a record, so you can link it again later.
          </p>
          <div className="mt-4 flex flex-wrap gap-3">
            <Button
              type="button"
              disabled={removing}
              onClick={confirmRemoveLink}
              className="bg-red-600 text-white hover:bg-red-700 disabled:opacity-50"
            >
              {removing ? 'Removing…' : 'Yes, remove the link'}
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={removing}
              onClick={() => setConfirmingRemove(false)}
              className="border-[#E9E9E7]"
            >
              Cancel
            </Button>
          </div>
        </div>
      ) : null}
    </form>
  )
}
