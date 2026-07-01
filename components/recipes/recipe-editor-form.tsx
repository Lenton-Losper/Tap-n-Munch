'use client'

import { useMemo, useState, useTransition } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { Plus, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { StockItemSelectField } from '@/components/stock/stock-item-select-field'
import { saveRecipeAction } from '@/lib/recipes/actions'
import type { RecipeEditorData } from '@/lib/recipes/queries'
import type { StockItemOption } from '@/lib/stock/queries'

type IngredientRow = {
  key: string
  stockItemId: string
  quantity: string
  unit: string
}

function toIngredientRows(ingredients: RecipeEditorData['ingredients']): IngredientRow[] {
  if (ingredients.length === 0) {
    return [{ key: crypto.randomUUID(), stockItemId: '', quantity: '', unit: '' }]
  }
  return ingredients.map((row) => ({
    key: crypto.randomUUID(),
    stockItemId: row.stockItemId,
    quantity: String(row.quantity),
    unit: row.unit ?? row.baseUnit,
  }))
}

function emptyRow(): IngredientRow {
  return { key: crypto.randomUUID(), stockItemId: '', quantity: '', unit: '' }
}

export function RecipeEditorForm({
  data,
  stockItems: initialStockItems,
  canEdit,
}: {
  data: RecipeEditorData
  stockItems: StockItemOption[]
  canEdit: boolean
}) {
  const router = useRouter()
  const [stockItems, setStockItems] = useState(initialStockItems)
  const [rows, setRows] = useState<IngredientRow[]>(() => toIngredientRows(data.ingredients))
  const [error, setError] = useState<string | null>(null)
  const [successMessage, setSuccessMessage] = useState<string | null>(null)
  const [isPending, startTransition] = useTransition()

  const stockItemById = useMemo(
    () => new Map(stockItems.map((item) => [item.id, item])),
    [stockItems],
  )

  const updateRow = (key: string, patch: Partial<IngredientRow>) => {
    setRows((current) => current.map((row) => (row.key === key ? { ...row, ...patch } : row)))
  }

  const handleStockItemChange = (key: string, stockItemId: string) => {
    const stockItem = stockItemById.get(stockItemId)
    updateRow(key, {
      stockItemId,
      unit: stockItem?.base_unit ?? '',
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
      .filter((row) => row.stockItemId && Number(row.quantity) > 0)
      .map((row) => ({
        stockItemId: row.stockItemId,
        quantity: Number(row.quantity),
        unit: row.unit.trim() || null,
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
                value={row.stockItemId}
                onValueChange={(value) => handleStockItemChange(row.key, value)}
                disabled={!canEdit}
                allowCreate={canEdit}
                label="Stock item"
              />
              <div className="space-y-1.5">
                <Label htmlFor={`quantity-${row.key}`}>Quantity</Label>
                <Input
                  id={`quantity-${row.key}`}
                  type="number"
                  min="0"
                  step="any"
                  value={row.quantity}
                  onChange={(event) => updateRow(row.key, { quantity: event.target.value })}
                  className="border-[#E9E9E7] bg-white"
                  disabled={!canEdit}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor={`unit-${row.key}`}>Unit</Label>
                <Input
                  id={`unit-${row.key}`}
                  value={row.unit}
                  onChange={(event) => updateRow(row.key, { unit: event.target.value })}
                  className="border-[#E9E9E7] bg-white"
                  disabled={!canEdit}
                  placeholder="e.g. g"
                />
              </div>
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
      </div>
    </form>
  )
}
