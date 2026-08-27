'use client'

import { useState } from 'react'
import { displayedAddonPrice } from '@/lib/cart/addon-display-price'
import { MenuItem } from '@/lib/supabase/menu'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { Checkbox } from '@/components/ui/checkbox'
import { X, Plus, Minus, ShoppingCart } from 'lucide-react'
import { CartItem } from '@/contexts/cart-context'
import { FoodItemImage } from '@/components/menu/food-item-image'
import { MENU_COPY } from '@/lib/customer-copy/menu-copy'
import {
  clampLineQuantity,
  MAX_LINE_QUANTITY,
  MIN_LINE_QUANTITY,
} from '@/lib/orders/quantity-limits'
import { MAX_INSTRUCTIONS_LENGTH } from '@/lib/orders/instruction-limits'
import {
  buildVariantDisplayName,
  getDefaultGroupSelection,
  getItemDisplayPrice,
  getVariantGroups,
  getVariantOptionLabel,
} from '@/lib/menu/variant-groups'

type MenuItemSize = { name: string; price_modifier: number }
type MenuItemAddon = { name: string; price: number }

interface ItemDetailModalProps {
  item: MenuItem
  restaurant: any
  /** The cart line being edited, or null/absent when adding a new one. */
  editingLine?: CartItem | null
  /**
   * Variant choices the customer already made OUTSIDE this modal -- the per-card chips on the
   * browse page. Seeds the chooser so opening the popup never silently discards a choice the
   * customer can still see behind it. Ignored when editing a line, which seeds from the line.
   */
  initialVariantSelection?: Record<string, string>
  onClose: () => void
  onAddToCart: (cartItem: CartItem) => void
}

export function ItemDetailModal({
  item,
  restaurant,
  editingLine,
  initialVariantSelection,
  onClose,
  onAddToCart,
}: ItemDetailModalProps) {
  // Editing a line seeds every control from that line. The modal is mounted fresh each time
  // it opens (both call sites render it conditionally), so lazy initialisers are enough --
  // no seeding effect, and nothing to re-sync mid-edit.
  const [quantity, setQuantity] = useState(() =>
    editingLine ? clampLineQuantity(editingLine.quantity) : 1
  )
  const [selectedSize, setSelectedSize] = useState<MenuItemSize | null>(() => {
    if (editingLine) {
      /*
       * AN UNCHANGED SIZE KEEPS THE MODIFIER THE LINE WAS ADDED AT (#189).
       *
       * This used to prefer the MENU's current definition of that size, deliberately, on the
       * grounds that "its modifier may have changed". That decision is reversed: a line already
       * in the cart is a quote, and that covers the size modifier exactly as it covers the base
       * price. A customer who opened Edit to change a quantity did not consent to a repricing,
       * and preferring the menu here reprices them by the whole modifier delta even though they
       * never touched the size control. If the modifier has changed, that is the next order's
       * price.
       *
       * Only the SEEDED value is preserved. Choosing a different size in the RadioGroup below
       * still takes that size's current modifier from the menu -- that is a new choice rather
       * than the agreed one, and how it should be priced is #189 Q2, which is not ruled.
       */
      return editingLine.selected_size ?? null
    }
    return item.has_sizes && item.sizes.length > 0
      ? item.sizes.find((s: MenuItemSize) => s.price_modifier === 0) || item.sizes[0]
      : null
  })
  const [selectedAddons, setSelectedAddons] = useState<MenuItemAddon[]>(
    () => editingLine?.selected_addons ?? []
  )
  const [specialInstructions, setSpecialInstructions] = useState(
    () => editingLine?.special_instructions ?? ''
  )

  const editedVariants = editingLine?.selected_variants

  /*
   * THE VARIANT CHOOSER IS FOR NEW LINES ONLY, AND THAT IS NOT AN OVERSIGHT.
   *
   * Every item now opens this modal, including the variant items that used to be added straight
   * from the browse card. Those items had their selection resolved by the page and never reached
   * here, so the modal rendering no variant control at all would have DROPPED it: no
   * selected_variants, no "- Large" suffix, and a price reverting to the unresolved base. Hence
   * the chooser below.
   *
   * It stays hidden while editing because a variant option REPLACES the base price rather than
   * modifying it, so re-resolving an edited line is exactly the repricing #189 forbids -- see the
   * docblock below, which records that turning a N$35 Large back into a N$20 Americano is what
   * that rule exists to stop. How a variant CHANGED during an edit should be priced is #189 Q2
   * and is not ruled, so this offers no way to change one; the line's own selection is
   * round-tripped untouched, exactly as before.
   */
  const variantGroups = getVariantGroups(item)
  const showVariantChooser = !editingLine && variantGroups.length > 0
  const [selectedVariants, setSelectedVariants] = useState<Record<string, string>>(() => ({
    ...getDefaultGroupSelection(item),
    ...(editingLine ? {} : initialVariantSelection || {}),
  }))

  /*
   * A LINE ALREADY IN THE CART IS A QUOTE, SO AN EDIT KEEPS THE PRICE IT WAS ADDED AT (#189).
   *
   * The cart page re-fetches the menu item to open this modal, so `item.base_price` is the
   * price on the menu RIGHT NOW. A customer who pressed Edit to change a quantity did not
   * consent to a repricing, so taking it would move the line to a price they were never shown.
   * If the menu price has changed, that is the NEXT order's price.
   *
   * This began as the variant-only carve-out from #126: a variant line ("Americano - Large")
   * carries an already variant-resolved base_price and this modal renders no variant UI to
   * re-resolve it, so recomputing turned a N$35 Large back into a N$20 Americano. The reason
   * generalises -- the stored price is the agreed one either way -- so it now covers every
   * edited line and the variant case is no longer special.
   *
   * The guard is about the STORE, not the menu: the cart is hydrated straight out of
   * localStorage with no validation (contexts/cart-context.tsx), so a line written by an older
   * build can arrive with no usable base_price. Only then is the current menu price used, and
   * only because a line with no price of its own has nothing to preserve.
   */
  const storedBasePrice = Number(editingLine?.base_price)
  const unitBasePrice = editingLine
    ? Number.isFinite(storedBasePrice)
      ? storedBasePrice
      : item.base_price
    : // A NEW line prices from the chosen variant. With no variant groups this returns
      // item.base_price unchanged, so nothing moves for an item that has none.
      getItemDisplayPrice(item, selectedVariants)

  const calculatePrice = () => {
    let price = unitBasePrice
    if (selectedSize) {
      price += selectedSize.price_modifier
    }
    selectedAddons.forEach(addon => {
      price += addon.price
    })
    return price * quantity
  }

  const handleAddToCart = () => {
    /*
     * The legacy `selected_size` shim, carried over from the quick-add path this replaced.
     * A variant "Size" group is not an `item.sizes` entry, but the cart, the ticket and line
     * identity all read selected_size, so a variant Size is mirrored into it at a zero
     * modifier -- the price is already carried by base_price. A real `has_sizes` radio wins
     * where an item somehow has both.
     */
    const variantSizeName = showVariantChooser ? selectedVariants.Size || null : null
    const effectiveSelectedSize =
      selectedSize ?? (variantSizeName ? { name: variantSizeName, price_modifier: 0 } : null)

    const cartItem: CartItem = {
      menu_item_id: item.id,
      name: item.name,
      quantity,
      base_price: unitBasePrice,
      selected_size: effectiveSelectedSize,
      selected_addons: selectedAddons,
      special_instructions: specialInstructions,
      subtotal: calculatePrice(),
      image_url: item.image_url,
    }
    // Round-trip what this modal cannot edit, so an edit never strips it from the line.
    if (editingLine?.display_name) {
      cartItem.display_name = editingLine.display_name
    }
    if (editedVariants) {
      cartItem.selected_variants = editedVariants
    }
    // A new variant line names and carries its own selection, exactly as the quick-add path
    // did -- without this the customer's choice reaches neither the kitchen nor the cart row.
    if (showVariantChooser) {
      cartItem.selected_variants = selectedVariants
      cartItem.display_name = buildVariantDisplayName(item.name, selectedVariants)
    }
    onAddToCart(cartItem)
  }

  const toggleAddon = (addon: MenuItemAddon) => {
    if (selectedAddons.find(a => a.name === addon.name)) {
      setSelectedAddons(selectedAddons.filter(a => a.name !== addon.name))
    } else {
      // The object pushed here comes from `item.addons`, i.e. the CURRENT menu. That is the
      // intended behaviour and the other half of the rule below: a newly ticked add-on is a new
      // choice and is priced today. Un-ticking a retained one and re-ticking it is therefore a
      // real change of price, not a no-op -- and now a visible one, because the displayed figure
      // moves with it instead of staying at the stored price while the total quietly changes.
      setSelectedAddons([...selectedAddons, addon])
    }
  }


  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 p-2 sm:items-center sm:p-4">
      {/* Named by the item's own heading below, which is now the only title this dialog has.
          Three tests used to detect "is the modal open?" by searching the tree for the literal
          string "Customize Item"; that made a copy edit able to silently blind them — the
          negative assertion in cart-per-item-instructions would have kept passing while
          checking nothing. They key on this role instead, which is what the modal IS rather
          than what it happens to say. */}
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={`item-detail-title-${item.id}`}
        className="max-h-[95vh] w-full max-w-2xl overflow-y-auto border border-border bg-card sm:max-h-[90vh]"
      >
        {/* Header — the close control only.

            THERE IS NO TITLE HERE ANY MORE. It read "Customize Item", which was true enough while
            only configurable items opened this modal. Every item opens it now, so a bottle of
            water was being announced as something to customize. The replacement is not a better
            title: the item's own name is already the first thing in the body below, and a header
            repeating it would say the same thing twice in the space a phone can least spare. */}
        <div className="sticky top-0 z-10 flex items-center justify-end border-b border-border bg-card p-4">
          <Button
            variant="ghost"
            size="icon"
            onClick={onClose}
            aria-label="Close"
            className="h-11 w-11"
          >
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
            <h3
              id={`item-detail-title-${item.id}`}
              className="mb-2 break-words font-serif text-xl font-bold text-foreground sm:text-2xl"
            >
              {item.name}
            </h3>
            {item.description && (
              <p className="text-sm font-sans text-muted-foreground leading-relaxed">{item.description}</p>
            )}
          </div>

          {/* Variant groups (Size / Milk / …) — new lines only, see the docblock above */}
          {showVariantChooser &&
            variantGroups.map((group) => (
              <div key={group.name}>
                <Label className="text-base font-semibold mb-4 block font-sans text-foreground">
                  {group.name}
                </Label>
                <RadioGroup
                  value={selectedVariants[group.name] || ''}
                  onValueChange={(value) =>
                    setSelectedVariants((prev) => ({ ...prev, [group.name]: value }))
                  }
                >
                  {group.options.map((option, optionIndex) => {
                    const optionLabel = getVariantOptionLabel(option)
                    const controlId = `variant-${group.name}-${optionIndex}`
                    return (
                      <div
                        key={controlId}
                        className="flex min-h-[44px] items-center space-x-3 border-b border-border py-3 last:border-b-0"
                      >
                        <RadioGroupItem value={optionLabel} id={controlId} />
                        <Label
                          htmlFor={controlId}
                          className="flex-1 cursor-pointer flex items-center justify-between font-sans"
                        >
                          <span className="text-foreground">{optionLabel}</span>
                          {group.type === 'price' && typeof option !== 'string' && (
                            <span className="text-muted-foreground text-sm">
                              {restaurant?.currency || 'N$'}
                              {Number(option.price).toFixed(2)}
                            </span>
                          )}
                        </Label>
                      </div>
                    )
                  })}
                </RadioGroup>
              </div>
            ))}

          {/* Size Selection */}
          {item.has_sizes && item.sizes.length > 0 && (
            <div>
              <Label className="text-base font-semibold mb-4 block font-sans text-foreground">Size</Label>
              <RadioGroup
                value={selectedSize?.name || ''}
                onValueChange={(value) => {
                  const size = item.sizes.find((s: MenuItemSize) => s.name === value)
                  if (size) setSelectedSize(size)
                }}
              >
                {item.sizes.map((size: MenuItemSize) => (
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
                {item.addons.map((addon: MenuItemAddon) => (
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
                        +{restaurant?.currency || 'N$'}{displayedAddonPrice(addon, selectedAddons).toFixed(2)}
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
                {MENU_COPY.itemSpecialInstructions}
              </Label>
              <Textarea
                id="instructions"
                placeholder={MENU_COPY.itemSpecialInstructionsPlaceholder}
                value={specialInstructions}
                onChange={(e) => setSpecialInstructions(e.target.value)}
                maxLength={MAX_INSTRUCTIONS_LENGTH}
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
                onClick={() => setQuantity(clampLineQuantity(quantity - 1))}
                disabled={quantity <= MIN_LINE_QUANTITY}
                className="h-11 w-11 border-border"
              >
                <Minus className="w-4 h-4 stroke-[1.5]" />
              </Button>
              <span className="text-lg font-semibold w-8 text-center font-sans text-foreground">{quantity}</span>
              <Button
                variant="outline"
                size="icon"
                // The server rejects anything above MAX_LINE_QUANTITY, so stop the customer
                // reaching a value it will refuse rather than letting them build a cart and
                // fail at submit.
                onClick={() => setQuantity(clampLineQuantity(quantity + 1))}
                disabled={quantity >= MAX_LINE_QUANTITY}
                aria-label={
                  quantity >= MAX_LINE_QUANTITY
                    ? `Maximum ${MAX_LINE_QUANTITY} per item`
                    : MENU_COPY.itemIncreaseQuantity
                }
                className="h-11 w-11 border-border"
              >
                <Plus className="w-4 h-4 stroke-[1.5]" />
              </Button>
            </div>
            {quantity >= MAX_LINE_QUANTITY && (
              <p className="mt-2 text-xs text-[#6B675F]">
                Up to {MAX_LINE_QUANTITY} per item. For a larger order, please ask a member of staff.
              </p>
            )}
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
            {MENU_COPY.itemAddToCart}
          </Button>
        </div>
      </div>
    </div>
  )
}
