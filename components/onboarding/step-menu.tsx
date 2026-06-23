'use client'

import { forwardRef, useImperativeHandle, useState } from 'react'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Button } from '@/components/ui/button'
import { onboardingFetch } from '@/lib/onboarding/api-client'
import type { StepHandle } from './types'

type MenuItemRow = {
  id: string
  name: string
  category: string
  price: number
}

type StepMenuProps = {
  restaurantId: string
  onError: (message: string) => void
  setSaving: (saving: boolean) => void
}

export const StepMenu = forwardRef<StepHandle, StepMenuProps>(function StepMenu(
  { restaurantId, onError, setSaving },
  ref
) {
  const [name, setName] = useState('')
  const [category, setCategory] = useState('Mains')
  const [price, setPrice] = useState('')
  const [description, setDescription] = useState('')
  const [items, setItems] = useState<MenuItemRow[]>([])
  const [adding, setAdding] = useState(false)

  const handleAddItem = async () => {
    const itemName = name.trim()
    const categoryName = category.trim()
    const itemPrice = Number(price)

    if (!itemName) {
      onError('Item name is required')
      return
    }
    if (!categoryName) {
      onError('Category is required')
      return
    }
    if (!Number.isFinite(itemPrice) || itemPrice <= 0) {
      onError('Enter a valid price')
      return
    }

    setAdding(true)
    onError('')

    try {
      const categoryPayload = await onboardingFetch('/api/admin/menu/categories', {
        method: 'POST',
        body: JSON.stringify({ restaurantId, name: categoryName }),
      })

      const itemPayload = await onboardingFetch('/api/admin/menu/items', {
        method: 'POST',
        body: JSON.stringify({
          restaurant_id: restaurantId,
          category_id: categoryPayload.id,
          name: itemName,
          base_price: itemPrice,
          description: description.trim() || null,
        }),
      })

      setItems((prev) => [
        ...prev,
        {
          id: String(itemPayload.id || itemPayload.data?.id || crypto.randomUUID()),
          name: itemName,
          category: categoryName,
          price: itemPrice,
        },
      ])
      setName('')
      setPrice('')
      setDescription('')
    } catch (error: unknown) {
      onError(error instanceof Error ? error.message : 'Failed to add menu item')
    } finally {
      setAdding(false)
    }
  }

  useImperativeHandle(ref, () => ({
    save: async () => {
      if (items.length < 1) {
        onError('Add at least one menu item to continue')
        return false
      }

      setSaving(true)
      onError('')

      try {
        await onboardingFetch('/api/admin/setup-status', {
          method: 'PATCH',
          body: JSON.stringify({ flag: 'menu_added' }),
        })
        return true
      } catch (error: unknown) {
        onError(error instanceof Error ? error.message : 'Failed to save menu step')
        return false
      } finally {
        setSaving(false)
      }
    },
  }))

  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2 sm:col-span-2">
          <Label htmlFor="itemName">Item name</Label>
          <Input
            id="itemName"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Grilled Chicken"
            className="rounded-lg border-[#E9E9E7]"
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="category">Category</Label>
          <Input
            id="category"
            value={category}
            onChange={(event) => setCategory(event.target.value)}
            placeholder="Mains"
            className="rounded-lg border-[#E9E9E7]"
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="price">Price</Label>
          <Input
            id="price"
            type="number"
            min={0}
            step="0.01"
            value={price}
            onChange={(event) => setPrice(event.target.value)}
            placeholder="120.00"
            className="rounded-lg border-[#E9E9E7]"
          />
        </div>

        <div className="space-y-2 sm:col-span-2">
          <Label htmlFor="description">Description (optional)</Label>
          <Input
            id="description"
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            placeholder="Served with seasonal vegetables"
            className="rounded-lg border-[#E9E9E7]"
          />
        </div>
      </div>

      <Button
        type="button"
        variant="outline"
        onClick={handleAddItem}
        disabled={adding}
        className="rounded-lg border-[#E9E9E7]"
      >
        {adding ? 'Adding...' : 'Add Item'}
      </Button>

      {items.length > 0 ? (
        <div className="rounded-lg border border-[#E9E9E7]">
          <div className="border-b border-[#E9E9E7] px-4 py-2 text-sm font-medium text-[#37352F]">
            Added items ({items.length})
          </div>
          <ul className="divide-y divide-[#E9E9E7]">
            {items.map((item) => (
              <li key={item.id} className="flex items-center justify-between px-4 py-3 text-sm">
                <div>
                  <p className="font-medium text-[#37352F]">{item.name}</p>
                  <p className="text-[#6B675F]">{item.category}</p>
                </div>
                <p className="font-medium text-[#37352F]">{item.price.toFixed(2)}</p>
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <p className="text-sm text-[#6B675F]">Add at least one item to continue.</p>
      )}
    </div>
  )
})
