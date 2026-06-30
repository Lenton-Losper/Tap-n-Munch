'use client'

import { useMemo, useState, useTransition } from 'react'
import Link from 'next/link'
import { Plus, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
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
import { createStockItemAction, saveGrvAction } from '@/lib/stock/actions'
import type { StockItemOption } from '@/lib/stock/queries'

type LineRow = {
  key: string
  stockItemId: string
  quantity: string
  unitCost: string
}

const BASE_UNITS = ['unit', 'kg', 'g', 'l', 'ml']

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
  showUnitCost = false,
}: {
  stockItems: StockItemOption[]
  showUnitCost?: boolean
}) {
  const [stockItems, setStockItems] = useState(initialStockItems)
  const [supplier, setSupplier] = useState('')
  const [invoiceNumber, setInvoiceNumber] = useState('')
  const [rows, setRows] = useState<LineRow[]>([emptyRow()])
  const [error, setError] = useState<string | null>(null)
  const [isPending, startTransition] = useTransition()

  const [createOpen, setCreateOpen] = useState(false)
  const [createRowKey, setCreateRowKey] = useState<string | null>(null)
  const [newItemName, setNewItemName] = useState('')
  const [newItemBaseUnit, setNewItemBaseUnit] = useState('unit')
  const [createError, setCreateError] = useState<string | null>(null)
  const [creatingItem, setCreatingItem] = useState(false)

  const stockItemOptions = useMemo(
    () => [...stockItems].sort((a, b) => a.name.localeCompare(b.name)),
    [stockItems],
  )

  const updateRow = (key: string, patch: Partial<LineRow>) => {
    setRows((current) => current.map((row) => (row.key === key ? { ...row, ...patch } : row)))
  }

  const addRow = () => {
    setRows((current) => [...current, emptyRow()])
  }

  const removeRow = (key: string) => {
    setRows((current) => (current.length === 1 ? current : current.filter((row) => row.key !== key)))
  }

  const openCreateItem = (rowKey: string) => {
    setCreateRowKey(rowKey)
    setNewItemName('')
    setNewItemBaseUnit('unit')
    setCreateError(null)
    setCreateOpen(true)
  }

  const handleCreateItem = async () => {
    setCreatingItem(true)
    setCreateError(null)
    const result = await createStockItemAction({
      name: newItemName,
      baseUnit: newItemBaseUnit,
    })
    setCreatingItem(false)

    if (result.error || !result.data) {
      setCreateError(result.error ?? 'Failed to create item.')
      return
    }

    const created = result.data
    setStockItems((current) => [...current, created])
    if (createRowKey) {
      updateRow(createRowKey, { stockItemId: created.id })
    }
    setCreateOpen(false)
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
    <>
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
              <Label htmlFor="invoice-number">Invoice number</Label>
              <Input
                id="invoice-number"
                value={invoiceNumber}
                onChange={(event) => setInvoiceNumber(event.target.value)}
                className="border-[#E9E9E7]"
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
                <div className="space-y-1.5">
                  <Label>Stock item</Label>
                  <Select
                    value={row.stockItemId}
                    onValueChange={(value) => updateRow(row.key, { stockItemId: value })}
                  >
                    <SelectTrigger className="w-full border-[#E9E9E7] bg-white">
                      <SelectValue placeholder="Select item" />
                    </SelectTrigger>
                    <SelectContent>
                      {stockItemOptions.map((item) => (
                        <SelectItem key={item.id} value={item.id}>
                          {item.name} ({item.base_unit})
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <button
                    type="button"
                    onClick={() => openCreateItem(row.key)}
                    className="text-xs font-medium text-[#FF6B35] hover:underline"
                  >
                    + Create item
                  </button>
                </div>
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
            {isPending ? 'Saving...' : 'Save GRV'}
          </Button>
          <Button type="button" variant="outline" className="border-[#E9E9E7]" asChild>
            <Link href="/stock">Cancel</Link>
          </Button>
        </div>
      </form>

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="border-[#E9E9E7]">
          <DialogHeader>
            <DialogTitle>Create stock item</DialogTitle>
            <DialogDescription>Add a new tracked item without leaving this form.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            {createError ? (
              <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
                {createError}
              </div>
            ) : null}
            <div className="space-y-1.5">
              <Label htmlFor="new-item-name">Name</Label>
              <Input
                id="new-item-name"
                value={newItemName}
                onChange={(event) => setNewItemName(event.target.value)}
                className="border-[#E9E9E7]"
              />
            </div>
            <div className="space-y-1.5">
              <Label>Base unit</Label>
              <Select value={newItemBaseUnit} onValueChange={setNewItemBaseUnit}>
                <SelectTrigger className="w-full border-[#E9E9E7]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {BASE_UNITS.map((unit) => (
                    <SelectItem key={unit} value={unit}>
                      {unit}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setCreateOpen(false)}>
              Cancel
            </Button>
            <Button
              type="button"
              onClick={() => void handleCreateItem()}
              disabled={creatingItem}
              className="bg-[#FF6B35] text-white hover:bg-[#e85f2f]"
            >
              {creatingItem ? 'Creating...' : 'Create item'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
