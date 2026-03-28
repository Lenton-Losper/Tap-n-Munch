'use client'

export const dynamic = "force-dynamic";

import { useEffect, useState } from 'react'
import { useParams, useSearchParams, useRouter } from 'next/navigation'
import { getRestaurant } from '@/lib/firebase/restaurants'
import { useCart } from '@/contexts/cart-context'
import { useClearCartOnTableChange } from '@/hooks/useClearCartOnTableChange'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import { ArrowLeft, Edit, Trash2, ShoppingCart, UtensilsCrossed } from 'lucide-react'
import Image from 'next/image'
import Link from 'next/link'
import { ItemDetailModal } from '@/components/menu/item-detail-modal'
import { getMenuItem } from '@/lib/firebase/menu-items'

export default function CartPage() {
  const params = useParams()
  const searchParams = useSearchParams()
  const router = useRouter()
  const restaurantId = params.restaurantId as string
  const tableNumber = parseInt(searchParams.get('table') || '0')

  useClearCartOnTableChange(restaurantId, tableNumber)

  const { items, updateItem, removeItem, getTotal, clearCart } = useCart()
  const [restaurant, setRestaurant] = useState<any>(null)
  const [orderInstructions, setOrderInstructions] = useState('')
  const [editingIndex, setEditingIndex] = useState<number | null>(null)
  const [editingItem, setEditingItem] = useState<any>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const loadRestaurant = async () => {
      try {
        const restaurantData = await getRestaurant(restaurantId)
        setRestaurant(restaurantData)
      } catch (err) {
        console.error('Failed to load restaurant:', err)
      } finally {
        setLoading(false)
      }
    }
    
    if (restaurantId) {
      loadRestaurant()
    }
  }, [restaurantId])

  const handleEdit = async (index: number) => {
    const cartItem = items[index]
    try {
      const menuItem = await getMenuItem(cartItem.menu_item_id, restaurantId)
      if (menuItem) {
        setEditingItem(menuItem)
        setEditingIndex(index)
      }
    } catch (err) {
      console.error('Failed to load menu item:', err)
    }
  }

  const handleUpdateItem = (updatedCartItem: any) => {
    if (editingIndex !== null) {
      updateItem(editingIndex, updatedCartItem)
      setEditingIndex(null)
      setEditingItem(null)
    }
  }

  const subtotal = getTotal()
  const taxRate = restaurant?.tax_rate || 0.15
  const tax = subtotal * taxRate
  const total = subtotal + tax

  if (loading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="w-10 h-10 border-2 border-border border-t-foreground animate-spin" />
      </div>
    )
  }

  // Empty cart state
  if (items.length === 0) {
    return (
      <div className="min-h-screen bg-background">
        <div className="max-w-4xl mx-auto px-4 py-6">
          {/* Header */}
          <div className="flex items-center gap-3 mb-8">
            <Button variant="ghost" size="icon" onClick={() => router.back()}>
              <ArrowLeft className="w-5 h-5 stroke-[1.5]" />
            </Button>
            <h1 className="text-2xl font-serif font-bold text-foreground">Your Order</h1>
          </div>
          
          {/* Empty State */}
          <div className="bg-card border border-border p-16 text-center">
            <ShoppingCart className="w-16 h-16 text-muted-foreground mx-auto mb-6" />
            <h2 className="text-xl font-serif font-bold text-foreground mb-2">Your cart is empty</h2>
            <p className="text-muted-foreground font-sans mb-8">Add some items to get started!</p>
            <Link href={`/menu/${restaurantId}/browse${tableNumber > 0 ? `?table=${tableNumber}` : ''}`}>
              <Button className="bg-foreground text-background hover:bg-foreground/90 font-sans px-8">
                Browse Menu
              </Button>
            </Link>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen max-w-full overflow-x-hidden bg-background">
      <div className="mx-auto max-w-4xl px-4 py-6">
        {/* Header */}
        <div className="flex items-center gap-3 mb-8">
          <Button variant="ghost" size="icon" onClick={() => router.back()}>
            <ArrowLeft className="w-5 h-5 stroke-[1.5]" />
          </Button>
          <h1 className="text-2xl font-serif font-bold text-foreground">Your Order</h1>
        </div>

        <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
          {/* Cart Items */}
          <div className="space-y-4 lg:col-span-2">
            {items.map((item, index) => (
              <div
                key={index}
                className="max-w-full overflow-hidden bg-card border border-border p-4"
              >
                <div className="flex gap-4">
                  {/* Image */}
                  <div className="relative h-[76px] w-[76px] flex-shrink-0 overflow-hidden bg-muted">
                    {item.image_url ? (
                      <Image
                        src={item.image_url}
                        alt={item.name}
                        fill
                        loading="lazy"
                        className="object-cover"
                        unoptimized
                        onError={(e) => {
                          e.currentTarget.style.display = 'none'
                          const container = e.currentTarget.closest('.relative')
                          const placeholder = container?.querySelector('.image-placeholder')
                          if (placeholder) placeholder.classList.remove('hidden')
                        }}
                      />
                    ) : null}
                    <div className={`image-placeholder absolute inset-0 flex items-center justify-center bg-muted ${item.image_url ? 'hidden' : ''}`}>
                      <UtensilsCrossed className="w-8 h-8 text-muted-foreground" />
                    </div>
                  </div>
                  
                  {/* Content */}
                  <div className="min-w-0 flex-1">
                    <h3 className="mb-1 break-words font-sans text-base font-semibold text-foreground">{item.name}</h3>
                    {item.selected_size && (
                      <p className="font-sans text-sm text-muted-foreground">
                        Size: {item.selected_size.name}
                      </p>
                    )}
                    {item.selected_addons.length > 0 && (
                      <p className="break-words font-sans text-sm text-muted-foreground">
                        Add-ons: {item.selected_addons.map(a => a.name).join(', ')}
                      </p>
                    )}
                    {item.special_instructions && (
                      <p className="mt-1 break-words font-sans text-sm italic text-muted-foreground">
                        "{item.special_instructions}"
                      </p>
                    )}
                    
                    {/* Price + Actions */}
                    <div className="mt-3 border-t border-border pt-3">
                      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                        <p className="font-sans text-base font-bold text-foreground sm:text-lg">
                        <span className="mr-0.5 text-xs font-normal text-muted-foreground sm:text-sm">
                          {restaurant?.currency || 'N$'}
                        </span>
                        {item.subtotal.toFixed(2)}
                        <span className="ml-2 text-xs font-normal text-muted-foreground">
                          (×{item.quantity})
                        </span>
                        </p>
                        <div className="flex flex-wrap gap-2">
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => handleEdit(index)}
                            className="h-9 border-border px-3 font-sans text-sm"
                          >
                            <Edit className="mr-1 h-4 w-4 stroke-[1.5]" />
                            Edit
                          </Button>
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => removeItem(index)}
                            className="h-9 border-border px-3 font-sans text-sm text-destructive hover:text-destructive"
                          >
                            <Trash2 className="mr-1 h-4 w-4 stroke-[1.5]" />
                            Remove
                          </Button>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </div>

          {/* Order Summary */}
          <div className="w-full max-w-full lg:col-span-1">
            <div className="w-full max-w-full bg-card border border-border p-4 sm:p-6 lg:sticky lg:top-4">
              <h2 className="mb-6 font-serif text-xl font-bold text-foreground">Order Summary</h2>
              
              {/* Totals */}
              <div className="mb-6 space-y-3">
                <div className="flex justify-between font-sans text-sm">
                  <span className="text-muted-foreground">Subtotal</span>
                  <span className="text-foreground">{restaurant?.currency || 'N$'}{subtotal.toFixed(2)}</span>
                </div>
                <div className="flex justify-between font-sans text-sm">
                  <span className="text-muted-foreground">Tax ({Math.round(taxRate * 100)}%)</span>
                  <span className="text-foreground">{restaurant?.currency || 'N$'}{tax.toFixed(2)}</span>
                </div>
              </div>
              
              <div className="mb-6 border-t border-border pt-4">
                <div className="flex justify-between items-center">
                  <span className="font-sans text-lg font-semibold text-foreground">Total</span>
                  <span className="font-sans text-2xl font-bold text-foreground">
                    {restaurant?.currency || 'N$'}{total.toFixed(2)}
                  </span>
                </div>
              </div>

              {/* Order Instructions */}
              <div className="mb-6">
                <Label htmlFor="instructions" className="mb-2 block font-sans text-base text-foreground">
                  Order Instructions (Optional)
                </Label>
                <Textarea
                  id="instructions"
                  placeholder="Any special requests for your order?"
                  value={orderInstructions}
                  onChange={(e) => setOrderInstructions(e.target.value)}
                  rows={3}
                  className="w-full max-w-full font-sans border-border text-sm sm:text-base"
                />
              </div>

              {/* Checkout Button */}
              <Link
                href={`/menu/${restaurantId}/order-secure${tableNumber > 0 ? `?table=${tableNumber}` : ''}`}
                className="block"
              >
                <Button
                  className="w-full bg-foreground text-background hover:bg-foreground/90 font-sans font-semibold py-6 text-base"
                  size="lg"
                >
                  Proceed to Checkout
                </Button>
              </Link>
            </div>
          </div>
        </div>
      </div>

      {/* Edit Item Modal */}
      {editingItem && editingIndex !== null && (
        <ItemDetailModal
          item={editingItem}
          restaurant={restaurant}
          onClose={() => {
            setEditingItem(null)
            setEditingIndex(null)
          }}
          onAddToCart={handleUpdateItem}
        />
      )}
    </div>
  )
}
