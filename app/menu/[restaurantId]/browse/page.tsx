'use client'

export const dynamic = "force-dynamic";

import { useEffect, useState } from 'react'
import { useParams, useSearchParams, useRouter } from 'next/navigation'
import { getRestaurant } from '@/lib/firebase/restaurants'
import { getMenuCategories, MenuCategory } from '@/lib/firebase/menu-categories'
import { getMenuItemsByCategory, MenuItem } from '@/lib/firebase/menu-items'
import { SubCategory } from '@/lib/firebase/sub-categories'
import { useCart } from '@/contexts/cart-context'
import { getOrCreateSession, getCurrentSession } from '@/lib/session'
import { restoreSessionFromTable } from '@/lib/session-recovery'
import { ActiveOrderBanner } from '@/components/ActiveOrderBanner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ShoppingCart, Search, ArrowLeft, UtensilsCrossed, Receipt } from 'lucide-react'
import Image from 'next/image'
import Link from 'next/link'
import { ItemDetailModal } from '@/components/menu/item-detail-modal'

export default function MenuBrowsePage() {
  const params = useParams()
  const searchParams = useSearchParams()
  const router = useRouter()
  const restaurantId = params.restaurantId as string
  const tableNumber = parseInt(searchParams.get('table') || '0')
  
  const { items: cartItems, getItemCount, addItem } = useCart()
  const [restaurant, setRestaurant] = useState<any>(null)
  const [menuCategories, setMenuCategories] = useState<MenuCategory[]>([])
  const [selectedMenuCategory, setSelectedMenuCategory] = useState<MenuCategory | null>(null)
  const [groupedItems, setGroupedItems] = useState<Record<string, { subcategory: SubCategory; items: MenuItem[] }>>({})
  const [searchQuery, setSearchQuery] = useState('')
  const [loading, setLoading] = useState(true)
  const [selectedItem, setSelectedItem] = useState<MenuItem | null>(null)

  useEffect(() => {
    const loadData = async () => {
      try {
        setLoading(true)
        const [restaurantData, categoriesData] = await Promise.all([
          getRestaurant(restaurantId),
          getMenuCategories(restaurantId),
        ])
        
        setRestaurant(restaurantData)
        setMenuCategories(categoriesData)
        
        if (categoriesData.length > 0) {
          setSelectedMenuCategory(categoriesData[0])
        }
        
        if (tableNumber > 0) {
          const existingSession = getCurrentSession()
          if (!existingSession) {
            const recoveredSession = await restoreSessionFromTable(restaurantId, tableNumber)
            if (!recoveredSession) {
              getOrCreateSession(restaurantId, String(tableNumber))
            }
          }
        }
        
        setLoading(false)
      } catch (err: any) {
        console.error('Failed to load data:', err)
        setLoading(false)
      }
    }
    
    if (restaurantId) {
      loadData()
    }
  }, [restaurantId, tableNumber])

  useEffect(() => {
    const loadMenuItems = async () => {
      if (!selectedMenuCategory || !restaurantId) {
        setGroupedItems({})
        return
      }
      
      try {
        const grouped = await getMenuItemsByCategory(restaurantId, selectedMenuCategory.id)
        setGroupedItems(grouped)
      } catch (err: any) {
        console.error('Failed to load menu items:', err)
        setGroupedItems({})
      }
    }
    
    loadMenuItems()
  }, [restaurantId, selectedMenuCategory, searchQuery])

  const handleAddToCart = (item: MenuItem) => {
    if (!item.has_sizes && !item.has_addons) {
      const cartItem = {
        menu_item_id: item.id,
        name: item.name,
        quantity: 1,
        base_price: item.base_price,
        selected_size: null,
        selected_addons: [],
        special_instructions: '',
        subtotal: item.base_price,
        image_url: item.image_url,
      }
      addItem(cartItem)
    } else {
      setSelectedItem(item)
    }
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="w-10 h-10 border-2 border-border border-t-foreground animate-spin" />
      </div>
    )
  }

  return (
    <div className="min-h-screen max-w-full overflow-x-hidden bg-background">
      {/* Active Order Banner */}
      <ActiveOrderBanner />
      
      {/* Sticky Header */}
      <header className="sticky top-0 z-40 border-b border-border bg-white">
        <div className="mx-auto max-w-4xl px-4 py-3 sm:py-4">
          <div className="flex items-center justify-between gap-2">
            {/* Left: Back + Restaurant Info */}
            <div className="flex min-w-0 items-center gap-2 sm:gap-3">
              <Button
                variant="ghost"
                size="icon"
                onClick={() => router.push(`/menu/${restaurantId}${tableNumber > 0 ? `?table=${tableNumber}` : ''}`)}
                className="h-11 w-11"
              >
                <ArrowLeft className="w-5 h-5 stroke-[1.5]" />
              </Button>
              
              <div className="flex min-w-0 items-center gap-2 sm:gap-3">
                {/* Logo */}
                {restaurant?.logo_url ? (
                  <div className="h-10 w-10 shrink-0 overflow-hidden border border-border">
                    <Image
                      src={restaurant.logo_url}
                      alt={restaurant.name || 'Restaurant'}
                      width={40}
                      height={40}
                      className="object-cover w-full h-full"
                      unoptimized
                    />
                  </div>
                ) : (
                  <div className="w-10 h-10 bg-foreground flex items-center justify-center text-background text-sm font-bold flex-shrink-0">
                    {restaurant?.name?.charAt(0) || 'M'}
                  </div>
                )}
                
                <div className="min-w-0">
                  <h1 className="truncate font-serif text-base font-bold leading-tight text-foreground sm:text-lg">
                    {restaurant?.name || 'Menu'}
                  </h1>
                  {tableNumber > 0 && (
                    <p className="truncate text-xs font-sans text-muted-foreground">
                      Table {tableNumber}
                    </p>
                  )}
                </div>
              </div>
            </div>
            
            {/* Right: Action Buttons */}
            <div className="flex shrink-0 items-center gap-1.5 sm:gap-2">
              {tableNumber > 0 && (
                <Link href={`/menu/${restaurantId}/receipt?table=${tableNumber}`}>
                  <Button variant="outline" size="sm" className="h-11 border-border px-3 font-sans text-xs sm:text-sm">
                    <Receipt className="w-4 h-4 mr-1.5 stroke-[1.5]" />
                    <span className="hidden sm:inline">Receipt</span>
                  </Button>
                </Link>
              )}
              <Link href={`/menu/${restaurantId}/cart${tableNumber > 0 ? `?table=${tableNumber}` : ''}`}>
                <Button variant="outline" size="sm" className="relative h-11 border-border px-3 font-sans text-xs sm:text-sm">
                  <ShoppingCart className="w-4 h-4 mr-1.5 stroke-[1.5]" />
                  <span className="hidden sm:inline">Cart</span>
                  {getItemCount() > 0 && (
                    <span className="absolute -top-2 -right-2 bg-foreground text-background text-xs w-5 h-5 flex items-center justify-center font-semibold">
                      {getItemCount()}
                    </span>
                  )}
                </Button>
              </Link>
            </div>
          </div>
        </div>
      </header>

      <div className="mx-auto max-w-4xl px-4 py-6">
        {/* Category Navigation - Horizontal Scroll */}
        {menuCategories.length > 0 && (
          <div className="flex gap-2 overflow-x-auto pb-4 mb-6 scrollbar-hide">
            {menuCategories.map((category) => (
              <button
                key={category.id}
                onClick={() => {
                  setSelectedMenuCategory(category)
                  setSearchQuery('')
                }}
                className={`whitespace-nowrap px-6 py-3 text-sm font-semibold font-sans transition-colors ${
                  selectedMenuCategory?.id === category.id
                    ? 'bg-foreground text-background'
                    : 'bg-transparent text-foreground border border-border hover:bg-muted'
                }`}
              >
                {category.name}
              </button>
            ))}
          </div>
        )}

        {/* Search Bar */}
        <div className="relative mb-6 sm:mb-8">
          <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-muted-foreground stroke-[1.5]" />
          <Input
            type="text"
            placeholder="Search menu items..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="h-11 border-border bg-muted pl-12 font-sans text-base sm:text-sm"
          />
        </div>

        {/* Menu Items */}
        {Object.keys(groupedItems).length > 0 ? (
          <div className="space-y-12">
            {Object.values(groupedItems).map(({ subcategory, items }) => (
              <section key={subcategory.id} className="space-y-6">
                {/* Sub-category Header */}
                <div className="border-b border-border pb-3">
                  <h2 className="text-2xl font-serif font-bold text-foreground">
                    {subcategory.name}
                  </h2>
                  {subcategory.description && (
                    <p className="text-sm font-sans text-muted-foreground mt-1">
                      {subcategory.description}
                    </p>
                  )}
                </div>
                
                {/* Items Grid */}
                <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                  {items.map((item) => (
                    <article
                      key={item.id}
                      className="bg-card border border-border overflow-hidden hover-lift"
                    >
                      {/* Image */}
                      <div className="relative w-full aspect-[4/3] bg-muted overflow-hidden">
                        {item.image_url ? (
                          <>
                            <Image
                              src={item.image_url}
                              alt={item.name}
                              fill
                              loading="lazy"
                              style={{
                                objectFit: item.imageFit || 'cover',
                                objectPosition: item.imagePosition || 'center',
                              }}
                              unoptimized
                              className="menu-image transition-opacity duration-300"
                              onLoad={(e) => {
                                e.currentTarget.style.opacity = '1'
                                const container = e.currentTarget.closest('.relative')
                                const shimmer = container?.querySelector('.image-shimmer')
                                if (shimmer) shimmer.classList.add('hidden')
                              }}
                              onError={(e) => {
                                e.currentTarget.style.display = 'none'
                                const container = e.currentTarget.closest('.relative')
                                const placeholder = container?.querySelector('.image-placeholder')
                                const shimmer = container?.querySelector('.image-shimmer')
                                if (placeholder) placeholder.classList.remove('hidden')
                                if (shimmer) shimmer.classList.add('hidden')
                              }}
                            />
                            <div className="image-shimmer absolute inset-0 bg-gradient-to-r from-transparent via-white/20 to-transparent animate-shimmer pointer-events-none" />
                          </>
                        ) : null}
                        <div className={`image-placeholder absolute inset-0 flex items-center justify-center bg-muted ${item.image_url ? 'hidden' : ''}`}>
                          <UtensilsCrossed className="w-12 h-12 text-muted-foreground" />
                        </div>
                      </div>
                      
                      {/* Content */}
                      <div className="p-4">
                        <h3 className="mb-1 line-clamp-2 font-sans text-base font-semibold text-foreground sm:text-lg">
                          {item.name}
                        </h3>
                        {item.description && (
                          <p className="text-sm font-sans text-muted-foreground mb-4 line-clamp-2 leading-relaxed">
                            {item.description}
                          </p>
                        )}
                        
                        {/* Price + Add Button */}
                        <div className="flex items-center justify-between border-t border-border pt-2">
                          <div>
                            <p className="text-lg font-sans font-bold text-foreground">
                              <span className="text-sm font-normal text-muted-foreground mr-0.5">
                                {restaurant?.currency || 'N$'}
                              </span>
                              {item.base_price.toFixed(2)}
                            </p>
                            {item.status === 'out_of_stock' && (
                              <p className="text-xs font-sans text-destructive mt-0.5">Out of Stock</p>
                            )}
                          </div>
                          <Button
                            onClick={() => handleAddToCart(item)}
                            disabled={item.status === 'out_of_stock'}
                            size="sm"
                            className="h-11 bg-foreground px-4 font-sans text-sm font-semibold text-background hover:bg-foreground/90"
                          >
                            {item.status === 'out_of_stock' ? 'Unavailable' : 'Add +'}
                          </Button>
                        </div>
                      </div>
                    </article>
                  ))}
                </div>
              </section>
            ))}
          </div>
        ) : (
          !loading && (
            <div className="text-center py-16 bg-card border border-border">
              <div className="max-w-md mx-auto px-6">
                <div className="text-6xl mb-6">🍽️</div>
                <h3 className="text-xl font-serif font-bold text-foreground mb-2">
                  {searchQuery ? 'No items found' : 'Menu coming soon!'}
                </h3>
                <p className="text-muted-foreground font-sans mb-2">
                  {searchQuery 
                    ? `No items match "${searchQuery}". Try a different search.`
                    : selectedMenuCategory
                    ? `No items in "${selectedMenuCategory.name}" yet.`
                    : 'This restaurant hasn\'t added menu items yet.'
                  }
                </p>
                {!searchQuery && (
                  <p className="text-sm text-muted-foreground font-sans">
                    Please ask staff for assistance.
                  </p>
                )}
              </div>
            </div>
          )
        )}
      </div>

      {/* Item Detail Modal */}
      {selectedItem && (
        <ItemDetailModal
          item={selectedItem}
          restaurant={restaurant}
          onClose={() => setSelectedItem(null)}
          onAddToCart={(cartItem) => {
            addItem(cartItem)
            setSelectedItem(null)
          }}
        />
      )}

      {/* Floating Receipt Button */}
      {tableNumber > 0 && (
        <div className="fixed bottom-5 right-4 z-50 sm:bottom-6 sm:right-6">
          <Link href={`/menu/${restaurantId}/receipt?table=${tableNumber}`}>
            <button
              className="bg-foreground text-background w-14 h-14 flex items-center justify-center text-xl hover:bg-foreground/90 transition-all shadow-lg"
              title="View Receipt"
            >
              <Receipt className="w-6 h-6 stroke-[1.5]" />
            </button>
          </Link>
        </div>
      )}
    </div>
  )
}
