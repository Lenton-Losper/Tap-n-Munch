// @ts-nocheck
'use client'

import { useState } from 'react'
import { MenuItem } from '@/lib/supabase/menu'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { Checkbox } from '@/components/ui/checkbox'
import { X, Plus, Minus, ShoppingCart } from 'lucide-react'
import { CartItem } from '@/contexts/cart-context'
import { FoodItemImage } from '@/components/menu/food-item-image'

type MenuItemSize = { name: string; price_modifier: number }
type MenuItemAddon = { name: string; price: number }

interface ItemDetailModalProps {
  item: MenuItem
  restaurant: any
  onClose: () => void
  onAddToCart: (cartItem: CartItem) => void
}

export function ItemDetailModal({
  item,
  restaurant,
  onClose,
  onAddToCart,
}: ItemDetailModalProps) {
  const [quantity, setQuantity] = useState(1)
  const [selectedSize, setSelectedSize] = useState<MenuItemSize | null>(
    item.has_sizes && item.sizes.length > 0
      ? item.sizes.find(s => s.price_modifier === 0) || item.sizes[0]
      : null
  )
  const [selectedAddons, setSelectedAddons] = useState<MenuItemAddon[]>([])
  const [specialInstructions, setSpecialInstructions] = useState('')

  const calculatePrice = () => {
    let price = item.base_price
    if (selectedSize) {
      price += selectedSize.price_modifier
    }
    selectedAddons.forEach(addon => {
      price += addon.price
    })
    return price * quantity
  }

  const handleAddToCart = () => {
    const cartItem: CartItem = {
      menu_item_id: item.id,
      name: item.name,
      quantity,
      base_price: item.base_price,
      selected_size: selectedSize,
      selected_addons: selectedAddons,
      special_instructions: specialInstructions,
      subtotal: calculatePrice(),
      image_url: item.image_url,
    }
    onAddToCart(cartItem)
  }

  const toggleAddon = (addon: MenuItemAddon) => {
    if (selectedAddons.find(a => a.name === addon.name)) {
      setSelectedAddons(selectedAddons.filter(a => a.name !== addon.name))
    } else {
      setSelectedAddons([...selectedAddons, addon])
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 p-2 sm:items-center sm:p-4">
      <div className="max-h-[95vh] w-full max-w-2xl overflow-y-auto border border-border bg-card sm:max-h-[90vh]">
        {/* Header */}
        <div className="sticky top-0 z-10 flex items-center justify-between border-b border-border bg-card p-4">
          <h2 className="text-lg font-serif font-bold text-foreground sm:text-xl">Customize Item</h2>
          <Button variant="ghost" size="icon" onClick={onClose} className="h-11 w-11">
            <X className="w-5 h-5 stroke-[1.5]" />
          </Button>
        </div>

        {/* Content */}
        <div className="space-y-5 p-4 sm:space-y-6 sm:p-6">
          {/* Image */}
          <div className="relative w-full aspect-[4/3] overflow-hidden bg-muted">
            <FoodItemImage
              itemName={item.name}
              menuItemId={item.id}
              storedImageUrl={item.image_url}
              alt={item.name}
              className="h-full w-full object-cover"
              style={{
                objectFit: item.imageFit || 'cover',
                objectPosition: item.imagePosition || 'center',
              }}
            />
          </div>

          {/* Item Name & Description */}
          <div>
            <h3 className="mb-2 break-words font-serif text-xl font-bold text-foreground sm:text-2xl">{item.name}</h3>
            {item.description && (
              <p className="text-sm font-sans text-muted-foreground leading-relaxed">{item.description}</p>
            )}
          </div>

          {/* Size Selection */}
          {item.has_sizes && item.sizes.length > 0 && (
            <div>
              <Label className="text-base font-semibold mb-4 block font-sans text-foreground">Size</Label>
              <RadioGroup
                value={selectedSize?.name || ''}
                onValueChange={(value) => {
                  const size = item.sizes.find(s => s.name === value)
                  if (size) setSelectedSize(size)
                }}
              >
                {item.sizes.map((size) => (
                  <div key={size.name} className="flex min-h-[44px] items-center space-x-3 border-b border-border py-3 last:border-b-0">
                    <RadioGroupItem value={size.name} id={size.name} />
                    <Label
                      htmlFor={size.name}
                      className="flex-1 cursor-pointer flex items-center justify-between font-sans"
                    >
                      <span className="text-foreground">{size.name}</span>
                      <span className="text-muted-foreground text-sm">
                        {size.price_modifier > 0 && '+'}
                        {size.price_modifier === 0 ? 'Included' : `${restaurant?.currency || 'N$'}${size.price_modifier.toFixed(2)}`}
                      </span>
                    </Label>
                  </div>
                ))}
              </RadioGroup>
            </div>
          )}

          {/* Add-ons */}
          {item.has_addons && item.addons.length > 0 && (
            <div>
              <Label className="text-base font-semibold mb-4 block font-sans text-foreground">Add-ons</Label>
              <div className="space-y-0">
                {item.addons.map((addon) => (
                  <div key={addon.name} className="flex min-h-[44px] items-center space-x-3 border-b border-border py-3 last:border-b-0">
                    <Checkbox
                      id={addon.name}
                      checked={selectedAddons.some(a => a.name === addon.name)}
                      onCheckedChange={() => toggleAddon(addon)}
                    />
                    <Label
                      htmlFor={addon.name}
                      className="flex-1 cursor-pointer flex items-center justify-between font-sans"
                    >
                      <span className="text-foreground">{addon.name}</span>
                      <span className="text-muted-foreground text-sm">
                        +{restaurant?.currency || 'N$'}{addon.price.toFixed(2)}
                      </span>
                    </Label>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Special Instructions */}
          {item.allow_special_instructions && (
            <div>
              <Label htmlFor="instructions" className="text-base font-semibold mb-3 block font-sans text-foreground">
                Special Instructions
              </Label>
              <Textarea
                id="instructions"
                placeholder="Any special requests? (e.g., no onions, extra sauce)"
                value={specialInstructions}
                onChange={(e) => setSpecialInstructions(e.target.value)}
                rows={3}
                className="font-sans border-border"
              />
            </div>
          )}

          {/* Quantity */}
          <div>
            <Label className="text-base font-semibold mb-3 block font-sans text-foreground">Quantity</Label>
            <div className="flex items-center gap-4">
              <Button
                variant="outline"
                size="icon"
                onClick={() => setQuantity(Math.max(1, quantity - 1))}
                className="h-11 w-11 border-border"
              >
                <Minus className="w-4 h-4 stroke-[1.5]" />
              </Button>
              <span className="text-lg font-semibold w-8 text-center font-sans text-foreground">{quantity}</span>
              <Button
                variant="outline"
                size="icon"
                onClick={() => setQuantity(quantity + 1)}
                className="h-11 w-11 border-border"
              >
                <Plus className="w-4 h-4 stroke-[1.5]" />
              </Button>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="sticky bottom-0 border-t border-border bg-card p-4">
          <div className="mb-3">
            <p className="text-xs font-sans text-muted-foreground uppercase tracking-wide mb-1">Total</p>
            <p className="text-2xl font-sans font-bold text-foreground">
              <span className="text-sm font-normal text-muted-foreground mr-0.5">{restaurant?.currency || 'N$'}</span>
              {calculatePrice().toFixed(2)}
            </p>
          </div>
          <Button
            onClick={handleAddToCart}
            className="h-11 w-full bg-foreground px-4 font-sans text-sm font-semibold text-background hover:bg-foreground/90 sm:h-10 sm:px-8"
            size="lg"
          >
            <ShoppingCart className="w-5 h-5 mr-2 stroke-[1.5]" />
            Add to Cart
          </Button>
        </div>
      </div>
    </div>
  )
}
