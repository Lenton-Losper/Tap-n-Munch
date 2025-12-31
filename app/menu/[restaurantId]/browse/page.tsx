'use client'

export const dynamic = "force-dynamic";

import { useEffect, useState } from 'react'
import { useParams, useSearchParams, useRouter } from 'next/navigation'
import { getRestaurant } from '@/lib/firebase/restaurants'
import { getMenuCategories, MenuCategory } from '@/lib/firebase/menu-categories'
import { getMenuItemsByCategory, searchMenuItems, MenuItem } from '@/lib/firebase/menu-items'
import { SubCategory } from '@/lib/firebase/sub-categories'
import { useCart } from '@/contexts/cart-context'
import { getOrCreateSession, getCurrentSession } from '@/lib/session'
import { restoreSessionFromTable } from '@/lib/session-recovery'
import { ActiveOrderBanner } from '@/components/ActiveOrderBanner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ShoppingCart, Search, ArrowLeft } from 'lucide-react'
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
        
        // PART 1: Table-Based Session Recovery
        // Initialize or recover session if table number is provided
        if (tableNumber > 0) {
          const existingSession = getCurrentSession()
          if (!existingSession) {
            // Try to recover from active table orders
            const recoveredSession = await restoreSessionFromTable(restaurantId, tableNumber)
            if (!recoveredSession) {
              // No recovery possible - create new session
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
        console.log('Loading menu items for restaurant:', restaurantId, 'category:', selectedMenuCategory.id, selectedMenuCategory.name)
        const grouped = await getMenuItemsByCategory(restaurantId, selectedMenuCategory.id)
        console.log('Menu items loaded, grouped by', Object.keys(grouped).length, 'sub-categories')
        console.log('Grouped items:', Object.keys(grouped).map(key => ({
          subcategory: grouped[key].subcategory.name,
          itemCount: grouped[key].items.length
        })))
        setGroupedItems(grouped)
      } catch (err: any) {
        console.error('Failed to load menu items:', err)
        console.error('Error details:', {
          message: err.message,
          code: err.code,
          stack: err.stack
        })
        setGroupedItems({})
      }
    }
    
    loadMenuItems()
  }, [restaurantId, selectedMenuCategory, searchQuery])

  const handleAddToCart = (item: MenuItem) => {
    // If item has no customizations, add directly
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
      // Open detail modal for customization
      setSelectedItem(item)
    }
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-[#FF6B35]"></div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Sticky Active Order Banner */}
      <ActiveOrderBanner />
      
      {/* Sticky Header */}
      <div className="sticky top-0 z-40 bg-white border-b shadow-sm">
        <div className="max-w-4xl mx-auto px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Button
              variant="ghost"
              size="icon"
              onClick={() => router.back()}
            >
              <ArrowLeft className="w-5 h-5" />
            </Button>
            <div>
              <h1 className="font-semibold">{restaurant?.name || 'Menu'}</h1>
              {tableNumber > 0 && (
                <p className="text-sm text-gray-500">Table {tableNumber}</p>
              )}
            </div>
          </div>
          <div className="flex items-center gap-2">
            {tableNumber > 0 && (
              <Link href={`/menu/${restaurantId}/receipt?table=${tableNumber}`}>
                <Button variant="outline" className="text-orange-600 border-orange-600 hover:bg-orange-50">
                  📋 Receipt
                </Button>
              </Link>
            )}
            <Link href={`/menu/${restaurantId}/cart${tableNumber > 0 ? `?table=${tableNumber}` : ''}`}>
              <Button variant="outline" className="relative">
                <ShoppingCart className="w-5 h-5 mr-2" />
                Cart
                {getItemCount() > 0 && (
                  <span className="absolute -top-2 -right-2 bg-[#FF6B35] text-white text-xs rounded-full w-5 h-5 flex items-center justify-center">
                    {getItemCount()}
                  </span>
                )}
              </Button>
            </Link>
          </div>
        </div>
      </div>

      <div className="max-w-4xl mx-auto px-4 py-6">
        {/* Menu Category Tabs */}
        {menuCategories.length > 0 && (
          <div className="flex gap-2 overflow-x-auto pb-4 mb-4 scrollbar-hide">
            {menuCategories.map((category) => (
              <Button
                key={category.id}
                variant={selectedMenuCategory?.id === category.id ? 'default' : 'outline'}
                onClick={() => {
                  setSelectedMenuCategory(category)
                  setSearchQuery('')
                }}
                className={`whitespace-nowrap ${
                  selectedMenuCategory?.id === category.id
                    ? 'bg-[#FF6B35] hover:bg-[#e55a28]'
                    : ''
                }`}
              >
                {category.name}
              </Button>
            ))}
          </div>
        )}

        {/* Search Bar */}
        <div className="relative mb-6">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-400" />
          <Input
            type="text"
            placeholder="Search menu items..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-10"
          />
        </div>

        {/* Menu Items Grouped by Sub-category */}
        {Object.keys(groupedItems).length > 0 ? (
          <div className="space-y-8">
            {Object.values(groupedItems).map(({ subcategory, items }) => (
              <div key={subcategory.id} className="space-y-4">
                {/* Sub-category Header */}
                <div>
                  <h2 className="text-2xl font-semibold text-gray-900">{subcategory.name}</h2>
                  {subcategory.description && (
                    <p className="text-sm text-gray-600 mt-1">{subcategory.description}</p>
                  )}
                </div>
                
                {/* Items Grid */}
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {items.map((item) => (
                    <div
                      key={item.id}
                      className="bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden hover:shadow-md transition-shadow"
                    >
                      {item.image_url && (
                        <div className="relative w-full h-48 bg-gray-50">
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
                      <div className="p-4">
                        <h3 className="font-semibold text-lg mb-1">{item.name}</h3>
                        {item.description && (
                          <p className="text-sm text-gray-600 mb-3 line-clamp-2">
                            {item.description}
                          </p>
                        )}
                        <div className="flex items-center justify-between">
                          <div>
                            <p className="text-lg font-bold text-[#FF6B35]">
                              {restaurant?.currency || 'N$'}{item.base_price.toFixed(2)}
                            </p>
                            {item.status === 'out_of_stock' && (
                              <p className="text-xs text-red-600">Out of Stock</p>
                            )}
                          </div>
                          <Button
                            onClick={() => handleAddToCart(item)}
                            disabled={item.status === 'out_of_stock'}
                            className="bg-[#FF6B35] hover:bg-[#e55a28]"
                            size="sm"
                          >
                            {item.status === 'out_of_stock' ? 'Unavailable' : 'Add +'}
                          </Button>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        ) : (
          !loading && (
            <div className="text-center py-12 bg-white rounded-lg border border-gray-200">
              <div className="max-w-md mx-auto">
                <div className="text-6xl mb-4">🍽️</div>
                <h3 className="text-xl font-semibold text-gray-900 mb-2">
                  {searchQuery ? 'No items found' : 'Menu coming soon!'}
                </h3>
                <p className="text-gray-600 mb-2">
                  {searchQuery 
                    ? `No items match "${searchQuery}". Try a different search term.`
                    : selectedMenuCategory
                    ? `No items in "${selectedMenuCategory.name}" yet.`
                    : 'This restaurant hasn\'t added any menu items yet.'
                  }
                </p>
                {!searchQuery && (
                  <p className="text-sm text-gray-500 mt-2">
                    Please ask staff for assistance or check back later.
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

      {/* Floating "Receipt" Button */}
      {tableNumber > 0 && (
        <div className="fixed bottom-6 right-6 z-50">
          <Link href={`/menu/${restaurantId}/receipt?table=${tableNumber}`}>
            <button
              className="bg-orange-600 text-white w-16 h-16 rounded-full shadow-lg flex items-center justify-center text-2xl hover:bg-orange-700 transition-all hover:scale-110"
              title="View Receipt"
            >
              📋
            </button>
          </Link>
        </div>
      )}
    </div>
  )
}

