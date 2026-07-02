'use client'

import { useState, useTransition } from 'react'
import Link from 'next/link'
import { Plus, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { StockItemSelectField } from '@/components/stock/stock-item-select-field'
import { saveGrvAction } from '@/lib/stock/actions'
import type { MeasurementUnitOption } from '@/lib/measurement-units/format'
import type { StockItemOption } from '@/lib/stock/queries'

type LineRow = {
  key: string
  stockItemId: string
  quantity: string
  unitCost: string
}


function emptyRow(): LineRow {
  return {
    key: crypto.randomUUID(),
    stockItemId: '',
    quantity: '',
    unitCost: '',
  }
}

export function ReceiveStockForm({
  stockItems: initialStockItems,
  measurementUnits: initialMeasurementUnits,
  showUnitCost = false,
}: {
  stockItems: StockItemOption[]
  measurementUnits: MeasurementUnitOption[]
  showUnitCost?: boolean
}) {
  const [stockItems, setStockItems] = useState(initialStockItems)
  const [measurementUnits, setMeasurementUnits] = useState(initialMeasurementUnits)
  const [supplier, setSupplier] = useState('')
  const [invoiceNumber, setInvoiceNumber] = useState('')
  const [rows, setRows] = useState<LineRow[]>([emptyRow()])
  const [error, setError] = useState<string | null>(null)
  const [isPending, startTransition] = useTransition()

  const updateRow = (key: string, patch: Partial<LineRow>) => {
    setRows((current) => current.map((row) => (row.key === key ? { ...row, ...patch } : row)))
  }

  const addRow = () => {
    setRows((current) => [...current, emptyRow()])
  }

  const removeRow = (key: string) => {
    setRows((current) => (current.length === 1 ? current : current.filter((row) => row.key !== key)))
  }

  const handleSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setError(null)

    const lineItems = rows
      .filter((row) => row.stockItemId && Number(row.quantity) > 0)
      .map((row) => ({
        stockItemId: row.stockItemId,
        quantity: Number(row.quantity),
        unitCost: showUnitCost && row.unitCost.trim() ? Number(row.unitCost) : null,
      }))

    startTransition(async () => {
      const result = await saveGrvAction({
        supplier,
        invoiceNumber,
        lineItems,
      })

      if (result?.error) {
        setError(result.error)
      }
    })
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
        {error ? (
          <div className="rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
            {error}
          </div>
        ) : null}

        <div className="rounded-2xl border border-[#E9E9E7] bg-white p-5">
          <h2 className="font-serif text-xl font-semibold text-[#37352F]">Delivery details</h2>
          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="supplier">Supplier</Label>
              <Input
                id="supplier"
                value={supplier}
                onChange={(event) => setSupplier(event.target.value)}
                className="border-[#E9E9E7]"
                required
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="invoice-number">Supplier reference (optional)</Label>
              <Input
                id="invoice-number"
                value={invoiceNumber}
                onChange={(event) => setInvoiceNumber(event.target.value)}
                className="border-[#E9E9E7]"
                placeholder="Leave blank to use the delivery reference number"
              />
            </div>
          </div>
        </div>

        <div className="rounded-2xl border border-[#E9E9E7] bg-white p-5">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h2 className="font-serif text-xl font-semibold text-[#37352F]">Items received</h2>
              <p className="mt-1 text-sm text-[#6B675F]">Add one row per stock item on this delivery.</p>
            </div>
            <Button type="button" variant="outline" onClick={addRow} className="border-[#E9E9E7]">
              <Plus className="mr-2 h-4 w-4" />
              Add item
            </Button>
          </div>

          <div className="mt-4 space-y-4">
            {rows.map((row, index) => (
              <div
                key={row.key}
                className={
                  showUnitCost
                    ? 'grid gap-3 rounded-xl border border-[#E9E9E7] bg-[#FAFAF8] p-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)_auto]'
                    : 'grid gap-3 rounded-xl border border-[#E9E9E7] bg-[#FAFAF8] p-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_auto]'
                }
              >
                <StockItemSelectField
                  stockItems={stockItems}
                  onStockItemsChange={setStockItems}
                  measurementUnits={measurementUnits}
                  onMeasurementUnitsChange={setMeasurementUnits}
                  value={row.stockItemId}
                  onValueChange={(value) => updateRow(row.key, { stockItemId: value })}
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
                  />
                </div>
                {showUnitCost ? (
                  <div className="space-y-1.5">
                    <Label htmlFor={`unit-cost-${row.key}`}>Unit cost (optional)</Label>
                    <Input
                      id={`unit-cost-${row.key}`}
                      type="number"
                      min="0"
                      step="any"
                      value={row.unitCost}
                      onChange={(event) => updateRow(row.key, { unitCost: event.target.value })}
                      className="border-[#E9E9E7] bg-white"
                    />
                  </div>
                ) : null}
                <div className="flex items-end justify-end">
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    onClick={() => removeRow(row.key)}
                    disabled={rows.length === 1}
                    aria-label={`Remove item row ${index + 1}`}
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
            disabled={isPending}
            className="bg-[#FF6B35] text-white hover:bg-[#e85f2f]"
          >
            {isPending ? 'Saving...' : 'Save Delivery'}
          </Button>
          <Button type="button" variant="outline" className="border-[#E9E9E7]" asChild>
            <Link href="/stock">Cancel</Link>
          </Button>
        </div>
      </form>
  )
}
