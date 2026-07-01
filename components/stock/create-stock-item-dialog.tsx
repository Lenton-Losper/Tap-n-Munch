'use client'

import { useState } from 'react'
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
import { createStockItemAction } from '@/lib/stock/actions'
import type { StockItemOption } from '@/lib/stock/queries'

export const STOCK_ITEM_BASE_UNITS = ['unit', 'kg', 'g', 'l', 'ml']

export function CreateStockItemDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreated: (item: StockItemOption) => void
}) {
  const [newItemName, setNewItemName] = useState('')
  const [newItemBaseUnit, setNewItemBaseUnit] = useState('unit')
  const [createError, setCreateError] = useState<string | null>(null)
  const [creatingItem, setCreatingItem] = useState(false)

  const resetForm = () => {
    setNewItemName('')
    setNewItemBaseUnit('unit')
    setCreateError(null)
  }

  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen) {
      resetForm()
    }
    onOpenChange(nextOpen)
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

    onCreated(result.data)
    handleOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
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
                {STOCK_ITEM_BASE_UNITS.map((unit) => (
                  <SelectItem key={unit} value={unit}>
                    {unit}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => handleOpenChange(false)}>
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
  )
}
