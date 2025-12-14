'use client'

import { useState, useEffect } from 'react'
import { MenuItem, MenuItemSize, MenuItemAddon } from '@/lib/firebase/menu-items'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { Checkbox } from '@/components/ui/checkbox'
import { X, Plus, Minus, ShoppingCart } from 'lucide-react'
import Image from 'next/image'
import { CartItem } from '@/contexts/cart-context'

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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="bg-white rounded-lg max-w-2xl w-full max-h-[90vh] overflow-y-auto">
        {/* Header */}
        <div className="sticky top-0 bg-white border-b flex items-center justify-between p-4 z-10">
          <h2 className="text-xl font-bold">Customize Item</h2>
          <Button variant="ghost" size="icon" onClick={onClose}>
            <X className="w-5 h-5" />
          </Button>
        </div>

        {/* Content */}
        <div className="p-6 space-y-6">
          {/* Image */}
          {item.image_url && (
            <div className="relative w-full h-64 rounded-lg overflow-hidden bg-gray-50">
              <Image
                src={item.image_url}
                alt={item.name}
                fill
                style={{
                  objectFit: item.imageFit || 'contain',
                  objectPosition: item.imagePosition || 'center',
                }}
              />
            </div>
          )}

          {/* Item Name & Description */}
          <div>
            <h3 className="text-2xl font-bold mb-2">{item.name}</h3>
            {item.description && (
              <p className="text-gray-600">{item.description}</p>
            )}
          </div>

          {/* Size Selection */}
          {item.has_sizes && item.sizes.length > 0 && (
            <div>
              <Label className="text-base font-semibold mb-3 block">Size</Label>
              <RadioGroup
                value={selectedSize?.name || ''}
                onValueChange={(value) => {
                  const size = item.sizes.find(s => s.name === value)
                  if (size) setSelectedSize(size)
                }}
              >
                {item.sizes.map((size) => (
                  <div key={size.name} className="flex items-center space-x-2 py-2">
                    <RadioGroupItem value={size.name} id={size.name} />
                    <Label
                      htmlFor={size.name}
                      className="flex-1 cursor-pointer flex items-center justify-between"
                    >
                      <span>{size.name}</span>
                      <span className="text-sm text-gray-600">
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
              <Label className="text-base font-semibold mb-3 block">Add-ons</Label>
              <div className="space-y-2">
                {item.addons.map((addon) => (
                  <div key={addon.name} className="flex items-center space-x-2 py-2">
                    <Checkbox
                      id={addon.name}
                      checked={selectedAddons.some(a => a.name === addon.name)}
                      onCheckedChange={() => toggleAddon(addon)}
                    />
                    <Label
                      htmlFor={addon.name}
                      className="flex-1 cursor-pointer flex items-center justify-between"
                    >
                      <span>{addon.name}</span>
                      <span className="text-sm text-[#FF6B35]">
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
              <Label htmlFor="instructions" className="text-base font-semibold mb-2 block">
                Special Instructions
              </Label>
              <Textarea
                id="instructions"
                placeholder="Any special requests? (e.g., no onions, extra sauce)"
                value={specialInstructions}
                onChange={(e) => setSpecialInstructions(e.target.value)}
                rows={3}
              />
            </div>
          )}

          {/* Quantity */}
          <div>
            <Label className="text-base font-semibold mb-2 block">Quantity</Label>
            <div className="flex items-center gap-4">
              <Button
                variant="outline"
                size="icon"
                onClick={() => setQuantity(Math.max(1, quantity - 1))}
              >
                <Minus className="w-4 h-4" />
              </Button>
              <span className="text-lg font-semibold w-8 text-center">{quantity}</span>
              <Button
                variant="outline"
                size="icon"
                onClick={() => setQuantity(quantity + 1)}
              >
                <Plus className="w-4 h-4" />
              </Button>
            </div>
          </div>
        </div>

        {/* Footer with Price and Add Button */}
        <div className="sticky bottom-0 bg-white border-t p-4 flex items-center justify-between">
          <div>
            <p className="text-sm text-gray-600">Total</p>
            <p className="text-2xl font-bold text-[#FF6B35]">
              {restaurant?.currency || 'N$'}{calculatePrice().toFixed(2)}
            </p>
          </div>
          <Button
            onClick={handleAddToCart}
            className="bg-[#FF6B35] hover:bg-[#e55a28] text-white px-8"
            size="lg"
          >
            <ShoppingCart className="w-5 h-5 mr-2" />
            Add to Cart
          </Button>
        </div>
      </div>
    </div>
  )
}

