"use client"

import { useState } from "react"
import { ShoppingCart, Plus, Minus, X, ArrowLeft, Trash2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { Checkbox } from "@/components/ui/checkbox"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Separator } from "@/components/ui/separator"
import { Input } from "@/components/ui/input"

const categories = ["Starters", "Mains", "Drinks", "Desserts"]

const menuItems = [
  {
    id: 1,
    name: "Grilled Salmon",
    description: "Fresh Atlantic salmon with lemon butter sauce and seasonal vegetables",
    price: 145,
    category: "Mains",
    image: "/grilled-salmon-dish.jpg",
  },
  {
    id: 2,
    name: "Caesar Salad",
    description: "Crisp romaine lettuce with parmesan and croutons",
    price: 85,
    category: "Starters",
    image: "/caesar-salad.png",
  },
  {
    id: 3,
    name: "Beef Burger",
    description: "Premium beef patty with cheese, lettuce, tomato on brioche bun",
    price: 125,
    category: "Mains",
    image: "/beef-burger.png",
  },
  {
    id: 4,
    name: "Mango Smoothie",
    description: "Fresh mango blended with yogurt and honey",
    price: 55,
    category: "Drinks",
    image: "/mango-smoothie.png",
  },
  {
    id: 5,
    name: "Chocolate Lava Cake",
    description: "Warm chocolate cake with molten center, vanilla ice cream",
    price: 75,
    category: "Desserts",
    image: "/chocolate-lava-cake.png",
  },
  {
    id: 6,
    name: "Bruschetta",
    description: "Toasted bread with tomatoes, basil, garlic and olive oil",
    price: 65,
    category: "Starters",
    image: "/classic-bruschetta.png",
  },
]

const sizes = [
  { id: "small", name: "Small", price: 0 },
  { id: "regular", name: "Regular", price: 20 },
  { id: "large", name: "Large", price: 40 },
]

const addons = [
  { id: "sauce", name: "Extra Sauce", price: 15 },
  { id: "salad", name: "Side Salad", price: 35 },
]

type CartItem = {
  id: string
  menuItemId: number
  name: string
  price: number
  image: string
  size: string
  addons: string[]
  quantity: number
  specialInstructions: string
}

export function MenuScreen() {
  const [isPlacingOrder, setIsPlacingOrder] = useState(false)
  const [orderError, setOrderError] = useState<string | null>(null)

  const [activeCategory, setActiveCategory] = useState("Mains")
  const [selectedItem, setSelectedItem] = useState<(typeof menuItems)[0] | null>(null)
  const [selectedSize, setSelectedSize] = useState("regular")
  const [selectedAddons, setSelectedAddons] = useState<string[]>([])
  const [quantity, setQuantity] = useState(1)
  const [specialInstructions, setSpecialInstructions] = useState("")
  const [cart, setCart] = useState<CartItem[]>([
    {
      id: "1",
      menuItemId: 1,
      name: "Grilled Salmon",
      price: 145,
      image: "/grilled-salmon-dish.jpg",
      size: "regular",
      addons: ["sauce"],
      quantity: 1,
      specialInstructions: "",
    },
    {
      id: "2",
      menuItemId: 3,
      name: "Beef Burger",
      price: 125,
      image: "/beef-burger.png",
      size: "large",
      addons: ["sauce", "salad"],
      quantity: 2,
      specialInstructions: "No onions please",
    },
  ])
  const [showCart, setShowCart] = useState(false)

  const filteredItems = menuItems.filter((item) => item.category === activeCategory)

  const calculateTotal = () => {
    if (!selectedItem) return 0
    const basePrice = selectedItem.price
    const sizePrice = sizes.find((s) => s.id === selectedSize)?.price || 0
    const addonsPrice = selectedAddons.reduce((sum, addonId) => {
      const addon = addons.find((a) => a.id === addonId)
      return sum + (addon?.price || 0)
    }, 0)
    return (basePrice + sizePrice + addonsPrice) * quantity
  }

  const calculateCartItemTotal = (item: CartItem) => {
    const sizePrice = sizes.find((s) => s.id === item.size)?.price || 0
    const addonsPrice = item.addons.reduce((sum, addonId) => {
      const addon = addons.find((a) => a.id === addonId)
      return sum + (addon?.price || 0)
    }, 0)
    return (item.price + sizePrice + addonsPrice) * item.quantity
  }

  const calculateCartSubtotal = () => {
    return cart.reduce((sum, item) => sum + calculateCartItemTotal(item), 0)
  }

  const handleOpenModal = (item: (typeof menuItems)[0]) => {
    setSelectedItem(item)
    setSelectedSize("regular")
    setSelectedAddons([])
    setQuantity(1)
    setSpecialInstructions("")
  }

  const handleCloseModal = () => {
    setSelectedItem(null)
  }

  const handleAddToCart = () => {
    if (!selectedItem) return

    const newItem: CartItem = {
      id: Date.now().toString(),
      menuItemId: selectedItem.id,
      name: selectedItem.name,
      price: selectedItem.price,
      image: selectedItem.image,
      size: selectedSize,
      addons: selectedAddons,
      quantity: quantity,
      specialInstructions: specialInstructions,
    }

    setCart([...cart, newItem])
    handleCloseModal()
  }

  const updateCartItemQuantity = (itemId: string, newQuantity: number) => {
    if (newQuantity < 1) return
    setCart(cart.map((item) => (item.id === itemId ? { ...item, quantity: newQuantity } : item)))
  }

  const removeCartItem = (itemId: string) => {
    setCart(cart.filter((item) => item.id !== itemId))
  }

  const handlePlaceOrder = async () => {
    if (cart.length === 0 || isPlacingOrder) return

    setIsPlacingOrder(true)
    setOrderError(null)

    try {
      const itemsPayload = cart.map((item) => ({
        menuItemId: item.menuItemId,
        name: item.name,
        quantity: item.quantity,
        basePrice: item.price,
        size: item.size,
        addons: item.addons.map((id) => {
          const addon = addons.find((a) => a.id === id)
          return {
            name: addon?.name || id,
            price: addon?.price || 0,
          }
        }),
        specialInstructions: item.specialInstructions,
        subtotal: calculateCartItemTotal(item),
      }))

      const response = await fetch("/api/orders", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          restaurantId: "demo-restaurant",
          tableNumber: 7,
          items: itemsPayload,
          total: calculateCartSubtotal(),
          paymentMethod: "cash",
          notes: null,
        }),
      })

      if (!response.ok) {
        const data = await response.json().catch(() => ({}))
        throw new Error(data.error || "Failed to place order")
      }

      const data = await response.json()
      const orderId = data.orderId as string

      // Clear the in-memory cart for this demo screen
      setCart([])
      setShowCart(false)

      // Redirect to generic order confirmation page
      window.location.href = `/order-confirmation?orderId=${encodeURIComponent(orderId)}`
    } catch (error: any) {
      console.error("Failed to place order:", error)
      setOrderError(error?.message || "Failed to place order. Please try again.")
    } finally {
      setIsPlacingOrder(false)
    }
  }

  return (
    <div className="min-h-screen bg-background pb-20">
      {/* Sticky Header */}
      <header className="sticky top-0 z-50 bg-card border-b border-border shadow-sm">
        <div className="flex items-center justify-between px-4 py-4">
          <div className="flex items-center gap-3">
            <Button variant="ghost" size="icon" onClick={() => window.history.back()} className="h-11 w-11">
              <ArrowLeft className="h-5 w-5" />
            </Button>
            <div className="flex flex-col">
              <h1 className="text-xl font-bold">Tap n Munch</h1>
              <p className="text-xs text-muted-foreground">Table 7</p>
            </div>
          </div>
          <Button variant="ghost" size="icon" className="relative h-11 w-11" onClick={() => setShowCart(true)}>
            <ShoppingCart className="h-5 w-5" />
            {cart.length > 0 && (
              <Badge className="absolute -top-1 -right-1 h-5 w-5 flex items-center justify-center p-0 bg-primary text-primary-foreground">
                {cart.length}
              </Badge>
            )}
          </Button>
        </div>
      </header>

      {/* Category Tabs */}
      <div className="sticky top-[73px] z-40 bg-card border-b border-border">
        <div className="flex gap-6 px-4 overflow-x-auto scrollbar-hide">
          {categories.map((category) => (
            <button
              key={category}
              onClick={() => setActiveCategory(category)}
              className="relative py-4 px-2 text-sm font-medium whitespace-nowrap transition-colors hover:text-primary"
            >
              <span className={activeCategory === category ? "text-primary" : "text-muted-foreground"}>{category}</span>
              {activeCategory === category && <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-primary" />}
            </button>
          ))}
        </div>
      </div>

      {/* Menu Items */}
      <div className="p-4 space-y-4">
        {filteredItems.map((item) => (
          <button
            key={item.id}
            onClick={() => handleOpenModal(item)}
            className="w-full bg-card border border-border rounded-lg p-4 flex gap-4 hover:shadow-md transition-shadow text-left"
          >
            <img
              src={item.image_url || "/placeholder.svg"}
              alt={item.name}
              className="w-[100px] h-[100px] rounded-md object-cover flex-shrink-0"
              onError={(e) => {
                // Fallback to placeholder if image fails to load
                e.currentTarget.src = "/placeholder.svg"
              }}
            />
            <div className="flex-1 min-w-0">
              <h3 className="font-bold text-base mb-1 line-clamp-1">{item.name}</h3>
              <p className="text-sm text-muted-foreground line-clamp-2 mb-2">{item.description}</p>
              <p className="text-base font-semibold text-foreground">N${item.price}</p>
            </div>
            <Button size="sm" className="self-end flex-shrink-0 bg-primary hover:bg-primary/90 text-primary-foreground">
              Add
            </Button>
          </button>
        ))}
      </div>

      {/* Item Detail Modal */}
      <Dialog open={!!selectedItem} onOpenChange={(open) => !open && handleCloseModal()}>
        <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto p-0">
          <button
            onClick={handleCloseModal}
            className="absolute right-4 top-4 z-10 rounded-full bg-background/80 p-2 hover:bg-background transition-colors"
          >
            <X className="h-4 w-4" />
          </button>

          {selectedItem && (
            <div className="space-y-6">
              <img
                src={selectedItem.image.replace("100", "250") || "/placeholder.svg"}
                alt={selectedItem.name}
                className="w-full h-[250px] object-cover"
              />

              <div className="px-6 space-y-6">
                <DialogHeader>
                  <DialogTitle className="text-2xl font-bold">{selectedItem.name}</DialogTitle>
                </DialogHeader>
                <p className="text-muted-foreground leading-relaxed">{selectedItem.description}</p>

                <div className="space-y-3">
                  <Label className="text-base font-semibold">Size</Label>
                  <RadioGroup value={selectedSize} onValueChange={setSelectedSize}>
                    {sizes.map((size) => (
                      <div key={size.id} className="flex items-center space-x-3">
                        <RadioGroupItem value={size.id} id={size.id} />
                        <Label htmlFor={size.id} className="flex-1 cursor-pointer">
                          {size.name} {size.price > 0 && `+N$${size.price}`}
                        </Label>
                      </div>
                    ))}
                  </RadioGroup>
                </div>

                <div className="space-y-3">
                  <Label className="text-base font-semibold">Add-ons</Label>
                  {addons.map((addon) => (
                    <div key={addon.id} className="flex items-center space-x-3">
                      <Checkbox
                        id={addon.id}
                        checked={selectedAddons.includes(addon.id)}
                        onCheckedChange={(checked) => {
                          if (checked) {
                            setSelectedAddons([...selectedAddons, addon.id])
                          } else {
                            setSelectedAddons(selectedAddons.filter((id) => id !== addon.id))
                          }
                        }}
                      />
                      <Label htmlFor={addon.id} className="flex-1 cursor-pointer">
                        {addon.name} +N${addon.price}
                      </Label>
                    </div>
                  ))}
                </div>

                <div className="space-y-3">
                  <Label htmlFor="instructions" className="text-base font-semibold">
                    Special Instructions
                  </Label>
                  <Textarea
                    id="instructions"
                    placeholder="Any special requests?"
                    value={specialInstructions}
                    onChange={(e) => setSpecialInstructions(e.target.value)}
                    className="resize-none"
                  />
                </div>

                <div className="flex items-center justify-center gap-4">
                  <Button
                    variant="outline"
                    size="icon"
                    onClick={() => setQuantity(Math.max(1, quantity - 1))}
                    disabled={quantity <= 1}
                  >
                    <Minus className="h-4 w-4" />
                  </Button>
                  <span className="text-xl font-semibold w-12 text-center">{quantity}</span>
                  <Button variant="outline" size="icon" onClick={() => setQuantity(quantity + 1)}>
                    <Plus className="h-4 w-4" />
                  </Button>
                </div>
              </div>

              <div className="sticky bottom-0 p-6 bg-card border-t border-border">
                <Button
                  onClick={handleAddToCart}
                  className="w-full bg-primary hover:bg-primary/90 text-primary-foreground h-12 text-base font-semibold"
                >
                  Add to Cart - N${calculateTotal()}
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      <Dialog open={showCart} onOpenChange={setShowCart}>
        <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto p-0">
          <DialogHeader className="px-6 pt-6 pb-4">
            <DialogTitle className="text-2xl font-bold">Your Cart</DialogTitle>
          </DialogHeader>

          {cart.length === 0 ? (
            <div className="px-6 py-12 text-center">
              <ShoppingCart className="h-16 w-16 mx-auto mb-4 text-muted-foreground/50" />
              <p className="text-muted-foreground text-lg">Your cart is empty</p>
              <p className="text-sm text-muted-foreground mt-2">Add some delicious items to get started!</p>
            </div>
          ) : (
            <>
              <div className="px-6 space-y-4 max-h-[50vh] overflow-y-auto">
                {cart.map((item) => (
                  <div key={item.id} className="bg-muted/30 rounded-lg p-4 space-y-3">
                    <div className="flex gap-3">
                      <img
                        src={item.image || "/placeholder.svg"}
                        alt={item.name}
                        className="w-20 h-20 rounded-md object-cover flex-shrink-0"
                        onError={(e) => {
                          // Fallback to placeholder if image fails to load
                          e.currentTarget.src = "/placeholder.svg"
                        }}
                      />
                      <div className="flex-1 min-w-0">
                        <h3 className="font-semibold text-base mb-1">{item.name}</h3>
                        <div className="text-sm text-muted-foreground space-y-0.5">
                          <p>Size: {sizes.find((s) => s.id === item.size)?.name}</p>
                          {item.addons.length > 0 && (
                            <p>Add-ons: {item.addons.map((id) => addons.find((a) => a.id === id)?.name).join(", ")}</p>
                          )}
                          {item.specialInstructions && <p className="italic">Note: {item.specialInstructions}</p>}
                        </div>
                      </div>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8 text-destructive hover:text-destructive hover:bg-destructive/10"
                        onClick={() => removeCartItem(item.id)}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>

                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <Button
                          variant="outline"
                          size="icon"
                          className="h-8 w-8 bg-transparent"
                          onClick={() => updateCartItemQuantity(item.id, item.quantity - 1)}
                          disabled={item.quantity <= 1}
                        >
                          <Minus className="h-3 w-3" />
                        </Button>
                        <span className="text-base font-semibold w-8 text-center">{item.quantity}</span>
                        <Button
                          variant="outline"
                          size="icon"
                          className="h-8 w-8 bg-transparent"
                          onClick={() => updateCartItemQuantity(item.id, item.quantity + 1)}
                        >
                          <Plus className="h-3 w-3" />
                        </Button>
                      </div>
                      <p className="text-base font-bold">N${calculateCartItemTotal(item)}</p>
                    </div>
                  </div>
                ))}
              </div>

              <Separator />

              <div className="px-6 py-4 space-y-3">
                <div className="flex justify-between text-base">
                  <span className="text-muted-foreground">Subtotal</span>
                  <span className="font-semibold">N${calculateCartSubtotal()}</span>
                </div>
                {orderError && (
                  <p className="text-sm text-red-600">
                    {orderError}
                  </p>
                )}
                <div className="flex justify-between text-lg font-bold">
                  <span>Total</span>
                  <span className="text-primary">N${calculateCartSubtotal()}</span>
                </div>
              </div>

              <div className="sticky bottom-0 px-6 pb-6 bg-card border-t border-border pt-4">
                <Button
                  onClick={handlePlaceOrder}
                  disabled={isPlacingOrder || cart.length === 0}
                  className="w-full bg-primary hover:bg-primary/90 text-primary-foreground h-12 text-base font-semibold disabled:opacity-70"
                >
                  {isPlacingOrder ? "Placing Order..." : `Place Order - N$${calculateCartSubtotal()}`}
                </Button>
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>

    </div>
  )
}
