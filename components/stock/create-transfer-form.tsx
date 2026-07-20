'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
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
import { OrganizationStockItemSelectField } from '@/components/stock/organization-stock-item-select-field'
import { createTransferAction } from '@/lib/stock/transfer-actions'
import type { OrganizationRestaurantOption, OrganizationStockItemOption } from '@/lib/stock/transfer-queries'

type LineRow = {
  key: string
  organizationStockItemId: string
  quantity: string
}

function emptyRow(): LineRow {
  return { key: crypto.randomUUID(), organizationStockItemId: '', quantity: '' }
}

export function CreateTransferForm({
  sourceRestaurantId,
  sourceRestaurantName,
  destinations,
  orgItems: initialOrgItems,
}: {
  sourceRestaurantId: string
  sourceRestaurantName: string
  destinations: OrganizationRestaurantOption[]
  orgItems: OrganizationStockItemOption[]
}) {
  const router = useRouter()
  const [orgItems, setOrgItems] = useState(initialOrgItems)
  const [toRestaurantId, setToRestaurantId] = useState(destinations[0]?.id ?? '')
  const [rows, setRows] = useState<LineRow[]>([emptyRow()])
  const [error, setError] = useState<string | null>(null)
  const [isPending, startTransition] = useTransition()

  const destination = destinations.find((d) => d.id === toRestaurantId) ?? null

  const updateRow = (key: string, patch: Partial<LineRow>) => {
    setRows((current) => current.map((row) => (row.key === key ? { ...row, ...patch } : row)))
  }

  const addRow = () => setRows((current) => [...current, emptyRow()])
  const removeRow = (key: string) =>
    setRows((current) => (current.length === 1 ? current : current.filter((row) => row.key !== key)))

  const handleSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setError(null)

    if (!toRestaurantId) {
      setError('Choose a destination location.')
      return
    }

    const items = rows
      .filter((row) => row.organizationStockItemId && Number(row.quantity) > 0)
      .map((row) => {
        const orgItem = orgItems.find((item) => item.id === row.organizationStockItemId)
        return {
          organizationStockItemId: row.organizationStockItemId,
          quantitySent: Number(row.quantity),
          unitId: orgItem?.baseUnitId ?? '',
        }
      })

    if (items.length === 0) {
      setError('Add at least one item with a quantity greater than zero.')
      return
    }

    startTransition(async () => {
      const result = await createTransferAction({ toRestaurantId, items })
      if ('error' in result) {
        setError(result.error)
        return
      }
      router.push('/stock/transfers?created=1')
    })
  }

  if (destinations.length === 0) {
    return (
      <div className="rounded-2xl border border-[#E9E9E7] bg-white p-5 text-sm text-[#6B675F]">
        There are no other locations in your organization to transfer stock to yet.
      </div>
    )
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      {error ? (
        <div className="rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
          {error}
        </div>
      ) : null}

      <div className="rounded-2xl border border-[#E9E9E7] bg-white p-5">
        <h2 className="font-serif text-xl font-semibold text-[#37352F]">Transfer details</h2>
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label>From</Label>
            <p className="rounded-lg border border-[#E9E9E7] bg-[#FAFAF8] px-3 py-2 text-sm text-[#37352F]">
              {sourceRestaurantName}
            </p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="to-restaurant">To</Label>
            <Select value={toRestaurantId} onValueChange={setToRestaurantId}>
              <SelectTrigger id="to-restaurant" className="w-full border-[#E9E9E7] bg-white">
                <SelectValue placeholder="Choose destination" />
              </SelectTrigger>
              <SelectContent>
                {destinations.map((restaurant) => (
                  <SelectItem key={restaurant.id} value={restaurant.id}>
                    {restaurant.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
      </div>

      <div className="rounded-2xl border border-[#E9E9E7] bg-white p-5">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h2 className="font-serif text-xl font-semibold text-[#37352F]">Items to transfer</h2>
            <p className="mt-1 text-sm text-[#6B675F]">Add one row per item being sent.</p>
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
              className="grid gap-3 rounded-xl border border-[#E9E9E7] bg-[#FAFAF8] p-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_auto]"
            >
              <OrganizationStockItemSelectField
                orgItems={orgItems}
                onOrgItemsChange={setOrgItems}
                sourceRestaurantId={sourceRestaurantId}
                sourceRestaurantName={sourceRestaurantName}
                destinationRestaurantId={toRestaurantId || null}
                destinationRestaurantName={destination?.name ?? null}
                value={row.organizationStockItemId}
                onValueChange={(id) => updateRow(row.key, { organizationStockItemId: id })}
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
        <Button type="submit" disabled={isPending} className="bg-[#FF6B35] text-white hover:bg-[#e85f2f]">
          {isPending ? 'Saving...' : 'Save as Draft'}
        </Button>
        <Button type="button" variant="outline" className="border-[#E9E9E7]" asChild>
          <Link href="/stock/transfers">Cancel</Link>
        </Button>
      </div>
    </form>
  )
}
