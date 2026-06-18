'use client'

export const dynamic = "force-dynamic";

import { useEffect, useMemo, useRef, useState } from 'react'
import { useParams, useSearchParams, useRouter } from 'next/navigation'
import { getRestaurantByFirebaseId } from '@/lib/supabase/restaurants'
import { getSupabaseCategories } from '@/lib/supabase/menu'
import { useCart } from '@/contexts/cart-context'
import { useClearCartOnTableChange } from '@/hooks/useClearCartOnTableChange'
import { getOrCreateSession, getCurrentSession, getSessionInfo } from '@/lib/session'
import { restoreSessionFromTable } from '@/lib/session-recovery'
import { ActiveOrderBanner } from '@/components/ActiveOrderBanner'
import OrderStatusBanner from '@/components/OrderStatusBanner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ShoppingCart, Search, ArrowLeft, Receipt, CheckCircle2, Loader2 } from 'lucide-react'
import Image from 'next/image'
import Link from 'next/link'
import { restaurantLogoDisplayUrl } from '@/lib/restaurant-logo'
import { ItemDetailModal } from '@/components/menu/item-detail-modal'
import { FoodItemImage } from '@/components/menu/food-item-image'
import { useTab } from '@/contexts/tab-context'
import { useTabSessionEndedRedirect } from '@/hooks/useTabSessionEndedRedirect'
import { readStoredTabId } from '@/lib/tab-storage'

type ItemVariant = {
  size: string
  label: string
  price: number
}

type VariantGroup = {
  name: string
  required: boolean
  type: 'text' | 'price'
  options: Array<string | { label: string; price: number }>
}

type RawVariantGroup = {
  name?: unknown
  required?: unknown
  type?: unknown
  options?: unknown
}

type MenuCategory = {
  id: string
  name: string
  description?: string | null
}

type MenuItem = Record<string, any>
type SubCategory = Record<string, any>

export default function MenuBrowsePage() {
  const params = useParams()
  const searchParams = useSearchParams()
  const router = useRouter()
  const restaurantId = params.restaurantId as string
  const tableNumber = Number(searchParams?.get('table') || searchParams?.get('tableNumber') || '1')
  const tabIdParam = searchParams.get('tabId')?.trim() || ''

  useEffect(() => {
    if (typeof window === 'undefined') return
    if (sessionStorage.getItem('flashtap_session_expired') === 'true') {
      window.location.replace(`/menu/${restaurantId}/session-ended`)
      return
    }
  }, [restaurantId])

  useClearCartOnTableChange(restaurantId, tableNumber)

  const { items: cartItems, getItemCount, addItem, clearCart } = useCart()
  const { isInTab, tabId, tabTotal, tabMembers, tabStatus } = useTab()

  const effectiveTabId = tabIdParam || tabId || readStoredTabId() || ''
  const { redirecting: tabSessionRedirecting } = useTabSessionEndedRedirect({
    restaurantId,
    tableNumber,
    tabId: effectiveTabId || null,
    enabled: Boolean(effectiveTabId),
    onSessionEnded: () => clearCart(),
  })

  const browseQuery = useMemo(() => {
    const q = new URLSearchParams()
    if (tableNumber > 0) q.set('table', String(tableNumber))
    if (tabIdParam || tabId) q.set('tabId', tabIdParam || tabId || '')
    const s = q.toString()
    return s ? `?${s}` : ''
  }, [tableNumber, tabIdParam, tabId])
  const [restaurant, setRestaurant] = useState<any>(null)
  const [menuCategories, setMenuCategories] = useState<MenuCategory[]>([])
  const [selectedMenuCategory, setSelectedMenuCategory] = useState<MenuCategory | null>(null)
  const [groupedItems, setGroupedItems] = useState<Record<string, { subcategory: SubCategory; items: MenuItem[] }>>({})
  const [allGroupedItems, setAllGroupedItems] = useState<
    Record<string, { subcategory: SubCategory; items: MenuItem[] }>
  >({})
  const [searchQuery, setSearchQuery] = useState('')
  const [loading, setLoading] = useState(true)
  const [selectedItem, setSelectedItem] = useState<MenuItem | null>(null)
  const [addingItemId, setAddingItemId] = useState<string | null>(null)
  const [toasts, setToasts] = useState<Array<{ id: number; name: string; leaving: boolean }>>([])
  const [selectedVariantGroupsByItem, setSelectedVariantGroupsByItem] = useState<
    Record<string, Record<string, string>>
  >({})
  const toastTimersRef = useRef<number[]>([])

  useEffect(() => {
    return () => {
      toastTimersRef.current.forEach((timerId) => window.clearTimeout(timerId))
      toastTimersRef.current = []
    }
  }, [])

  const pushCartToast = (name: string) => {
    const id = Date.now() + Math.floor(Math.random() * 1000)
    const safeName = String(name || 'Item')
    setToasts((prev) => [...prev, { id, name: safeName, leaving: false }])

    const fadeTimer = window.setTimeout(() => {
      setToasts((prev) => prev.map((toast) => (toast.id === id ? { ...toast, leaving: true } : toast)))
    }, 1800)
    const removeTimer = window.setTimeout(() => {
      setToasts((prev) => prev.filter((toast) => toast.id !== id))
    }, 2000)
    toastTimersRef.current.push(fadeTimer, removeTimer)
  }

  const getItemVariants = (item: MenuItem): ItemVariant[] =>
    Array.isArray((item as MenuItem & { variants?: ItemVariant[] }).variants)
      ? ((item as MenuItem & { variants?: ItemVariant[] }).variants || []).filter(
          (variant) =>
            variant &&
            typeof variant.size === 'string' &&
            typeof variant.label === 'string' &&
            Number.isFinite(Number(variant.price))
        )
      : []

  const normalizeVariantGroups = (groups: unknown): VariantGroup[] => {
    if (!Array.isArray(groups)) return []
    return groups
      .map((group) => {
        const raw = (group || {}) as RawVariantGroup
        const groupName = String(raw.name || '').trim()
        const groupType = raw.type === 'price' ? 'price' : raw.type === 'text' ? 'text' : null
        const rawOptions = Array.isArray(raw.options) ? raw.options : []
        if (!groupName || !groupType || rawOptions.length === 0) return null

        const options = rawOptions
          .map((opt) => {
            if (typeof opt === 'string') return opt
            if (!opt || typeof opt !== 'object') return null
            const optionLabel = String((opt as { label?: unknown; name?: unknown }).label || (opt as { name?: unknown }).name || '').trim()
            if (!optionLabel) return null
            if (groupType === 'text') return optionLabel
            const priceValue = Number((opt as { price?: unknown }).price)
            if (!Number.isFinite(priceValue)) return null
            return { label: optionLabel, price: priceValue }
          })
          .filter(Boolean) as Array<string | { label: string; price: number }>

        if (options.length === 0) return null
        return {
          name: groupName,
          required: Boolean(raw.required),
          type: groupType,
          options,
        } as VariantGroup
      })
      .filter(Boolean) as VariantGroup[]
  }

  const getVariantGroups = (item: MenuItem): VariantGroup[] => {
    const itemWithVariants = item as MenuItem & { variantGroups?: unknown; variant_groups?: unknown }
    const groups = normalizeVariantGroups(itemWithVariants.variantGroups)
    if (groups.length > 0) return groups
    const snakeCaseGroups = normalizeVariantGroups(itemWithVariants.variant_groups)
    if (snakeCaseGroups.length > 0) return snakeCaseGroups

    const legacyVariants = getItemVariants(item)
    if (legacyVariants.length > 0) {
      return [
        {
          name: 'Size',
          required: true,
          type: 'price',
          options: legacyVariants.map((v) => ({ label: v.label, price: Number(v.price) })),
        },
      ]
    }
    return []
  }

  const getDefaultGroupSelection = (item: MenuItem) => {
    const result = {} as Record<string, any>
    for (const group of getVariantGroups(item)) {
      const first = group.options[0]
      if (typeof first === 'string') {
        result[group.name] = first
      } else if (first && typeof first === 'object') {
        result[group.name] = String(first.label || '')
      }
    }
    return result
  }

  const getSelectedVariantLabel = (option: string | { label: string; price: number }) =>
    typeof option === 'string' ? option : String(option.label || '')

  const getResolvedVariantSelection = (item: MenuItem) => ({
    ...getDefaultGroupSelection(item),
    ...(selectedVariantGroupsByItem[item.id] || {}),
  })

  const getItemDisplayPrice = (item: MenuItem, selection: Record<string, string>) => {
    const variantGroups = getVariantGroups(item)
    for (const group of variantGroups) {
      if (group.type !== 'price') continue
      for (const option of group.options) {
        if (typeof option === 'string') continue
        if (String(option.label || '') === String(selection[group.name] || '')) {
          return Number(option.price)
        }
      }
    }
    return item.base_price
  }

  const isRequiredVariantMissing = (item: MenuItem, selection: Record<string, string>) =>
    getVariantGroups(item).some((group) => {
      if (!group.required) return false
      const selected = String(selection[group.name] || '').trim()
      return !selected
    })

  useEffect(() => {
    const loadData = async () => {
      try {
        setLoading(true)
        const [restaurantData, categoriesData] = await Promise.all([
          getRestaurantByFirebaseId(restaurantId),
          getSupabaseCategories(restaurantId, true),
        ])
        
        setRestaurant(restaurantData)
        setMenuCategories(categoriesData)
        
        if (categoriesData.length > 0) {
          setSelectedMenuCategory(categoriesData[0])
        }
        
        if (tableNumber > 0) {
          const existingSession = getCurrentSession()
          const sessionInfo = getSessionInfo()
          const sessionMatches =
            existingSession &&
            sessionInfo.table === String(tableNumber) &&
            sessionInfo.restaurant === restaurantId

          if (!sessionMatches) {
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
        const response = await fetch(
          `/api/menu/${encodeURIComponent(restaurantId)}/category/${encodeURIComponent(selectedMenuCategory.id)}`,
          { cache: 'no-store' }
        )
        if (!response.ok) {
          throw new Error(`Menu API returned ${response.status}`)
        }
        const grouped = (await response.json()) as Record<
          string,
          { subcategory: SubCategory; items: MenuItem[] }
        >
        setGroupedItems(grouped)
      } catch (err: any) {
        console.error('Failed to load menu items:', err)
        setGroupedItems({})
      }
    }
    
    loadMenuItems()
  }, [restaurantId, selectedMenuCategory])

  useEffect(() => {
    const loadAllMenuItems = async () => {
      if (!restaurantId || menuCategories.length === 0) {
        setAllGroupedItems({})
        return
      }

      try {
        const categoryPayloads = await Promise.all(
          menuCategories.map(async (category) => {
            const response = await fetch(
              `/api/menu/${encodeURIComponent(restaurantId)}/category/${encodeURIComponent(category.id)}`,
              { cache: 'no-store' }
            )
            if (!response.ok) {
              throw new Error(`Menu API returned ${response.status}`)
            }
            return (await response.json()) as Record<
              string,
              { subcategory: SubCategory; items: MenuItem[] }
            >
          })
        )

        const merged: Record<string, { subcategory: SubCategory; items: MenuItem[] }> = {}
        for (const grouped of categoryPayloads) {
          for (const [key, entry] of Object.entries(grouped)) {
            const existing = merged[key]
            if (!existing) {
              merged[key] = {
                subcategory: entry.subcategory,
                items: [...(entry.items || [])],
              }
              continue
            }
            existing.items.push(...(entry.items || []))
          }
        }

        setAllGroupedItems(merged)
      } catch (err) {
        console.error('Failed to load full menu for search:', err)
        setAllGroupedItems({})
      }
    }

    void loadAllMenuItems()
  }, [restaurantId, menuCategories])

  const normalizedSearchQuery = searchQuery.trim().toLowerCase()
  const menuItemsSource = normalizedSearchQuery ? allGroupedItems : groupedItems
  const filteredGroupedEntries = Object.values(menuItemsSource)
    .map(({ subcategory, items }) => {
      if (!normalizedSearchQuery) return { subcategory, items }
      const filteredItems = items.filter((item) => {
        const name = String(item.name || '').toLowerCase()
        const description = String(item.description || '').toLowerCase()
        return name.includes(normalizedSearchQuery) || description.includes(normalizedSearchQuery)
      })
      return { subcategory, items: filteredItems }
    })
    .filter(({ items }) => items.length > 0)

  useEffect(() => {
    const allItems = Object.values(groupedItems).flatMap((entry) => entry.items || [])
    for (const item of allItems) {
      const name = String(item?.name || '')
      if (name === 'Tea' || name === 'Tea (Rooibos / Five Roses / Green Tea)' || name === 'Americano') {
        console.log('[browse][variantGroups-debug] item=', name, item)
      }
    }
  }, [groupedItems])

  const handleAddToCart = async (item: MenuItem) => {
    if (!isInTab) return
    const hasInlineVariantGroups = getVariantGroups(item).length > 0
    if ((!item.has_sizes && !item.has_addons) || (hasInlineVariantGroups && !item.has_addons)) {
      setAddingItemId(item.id)
      try {
        const resolvedSelection = getResolvedVariantSelection(item)
        const effectivePrice = getItemDisplayPrice(item, resolvedSelection)
        const variantParts = Object.values(resolvedSelection).filter(Boolean)
        const effectiveDisplayName =
          variantParts.length > 0 ? `${item.name} - ${variantParts.join(' / ')}` : item.name
        const selectedSizeName = resolvedSelection.Size || null

        const cartItem = {
          menu_item_id: item.id,
          name: item.name,
          display_name: effectiveDisplayName,
          quantity: 1,
          base_price: effectivePrice,
          selected_size: selectedSizeName
            ? { name: selectedSizeName, price_modifier: 0 }
            : null,
          selected_addons: [],
          selected_variants: resolvedSelection,
          special_instructions: '',
          subtotal: effectivePrice,
          image_url: item.image_url,
        }
        await new Promise((resolve) => setTimeout(resolve, 1000))
        addItem(cartItem)
        pushCartToast(effectiveDisplayName)
      } finally {
        setAddingItemId(null)
      }
    } else {
      setSelectedItem(item)
    }
  }

  if (tabSessionRedirecting) {
    return (
      <div className="min-h-screen bg-background flex flex-col items-center justify-center gap-3 px-6 text-center">
        <div className="w-10 h-10 border-2 border-border border-t-foreground animate-spin" />
        <p className="text-sm text-muted-foreground max-w-xs">
          Your session has ended. Scan the QR code to start a new order.
        </p>
      </div>
    )
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="w-10 h-10 border-2 border-border border-t-foreground animate-spin" />
      </div>
    )
  }

  return (
    <div className="min-h-screen max-w-full bg-background">
      <OrderStatusBanner restaurantId={restaurantId} tableNumber={tableNumber} />
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
                onClick={() => router.replace(`/menu/${restaurantId}${tableNumber > 0 ? `?table=${tableNumber}` : ''}`)}
                className="h-11 w-11"
              >
                <ArrowLeft className="w-5 h-5 stroke-[1.5]" />
              </Button>
              
              <div className="flex min-w-0 items-center gap-2 sm:gap-3">
                {/* Logo */}
                {restaurantLogoDisplayUrl(restaurantId, restaurant?.logo_url) ? (
                  <div className="h-10 w-10 shrink-0 overflow-hidden border border-border">
                    <Image
                      src={restaurantLogoDisplayUrl(restaurantId, restaurant?.logo_url)!}
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
                <Link href={`/menu/${restaurantId}/receipt?table=${tableNumber}${tabId || tabIdParam ? `&tabId=${encodeURIComponent(tabId || tabIdParam)}` : ''}`}>
                  <Button variant="outline" size="sm" className="h-11 border-border px-3 font-sans text-xs sm:text-sm">
                    <Receipt className="w-4 h-4 mr-1.5 stroke-[1.5]" />
                    <span className="hidden sm:inline">Receipt</span>
                  </Button>
                </Link>
              )}
              <Link href={`/menu/${restaurantId}/cart${browseQuery}`}>
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

      {isInTab && (
        <div className="border-b border-border bg-foreground text-background">
          <Link href={`/menu/${restaurantId}/tab${browseQuery}`}>
            <div className="mx-auto max-w-4xl px-4 py-2 text-center text-sm sm:text-left">
              {tabStatus === 'ready_to_pay'
                ? `Ready to pay • ${(restaurant?.currency || 'N$')}${(Number(tabTotal) || 0).toFixed(2)} — waiter notified`
                : tabStatus === 'closed'
                  ? `Tab closed • ${(restaurant?.currency || 'N$')}${(0).toFixed(2)} • 0 people`
                  : `Tab open • ${(restaurant?.currency || 'N$')}${(Number(tabTotal) || 0).toFixed(2)} • ${
                      tabMembers.length
                    } ${tabMembers.length === 1 ? 'person' : 'people'} — Tap to settle →`}
            </div>
          </Link>
        </div>
      )}

      <div className="mx-auto max-w-4xl px-4 pt-6 pb-28 sm:pb-32">
        {/* Category Navigation - Horizontal Scroll */}
        {menuCategories.length > 0 && (
          <div
            className="flex overflow-x-auto gap-2 pb-2 categories-scroll mb-6"
            style={{
              scrollbarWidth: 'none',
              msOverflowStyle: 'none',
              WebkitOverflowScrolling: 'touch',
            }}
          >
            {menuCategories.map((category) => (
              <button
                key={category.id}
                type="button"
                onClick={() => {
                  setSelectedMenuCategory(category)
                  setSearchQuery('')
                }}
                className={`shrink-0 whitespace-nowrap px-6 py-3 text-sm font-semibold font-sans transition-colors ${
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
        {filteredGroupedEntries.length > 0 ? (
          <div className="space-y-12">
            {filteredGroupedEntries.map(({ subcategory, items }) => (
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
                        <FoodItemImage
                          itemName={item.name}
                          menuItemId={item.id}
                          storedImageUrl={item.image_url}
                          alt={item.name}
                          className="h-full w-full object-cover rounded-t-lg"
                          style={{
                            objectFit: item.imageFit || 'cover',
                            objectPosition: item.imagePosition || 'center',
                          }}
                        />
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
                        {getVariantGroups(item).length > 0 && (
                          <div className="mb-3 space-y-2">
                            {getVariantGroups(item).map((group) => {
                              const resolvedSelection = getResolvedVariantSelection(item)
                              return (
                                <div key={`${item.id}-${group.name}`}>
                                  <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                                    {group.name}
                                  </p>
                                  <div className="flex flex-wrap gap-2">
                                    {group.options.map((option, optionIndex) => {
                                      const optionLabel = getSelectedVariantLabel(option)
                                      const isSelected = resolvedSelection[group.name] === optionLabel
                                      return (
                                        <button
                                          key={`${item.id}-${group.name}-${optionLabel}-${optionIndex}`}
                                          type="button"
                                          onClick={() =>
                                            setSelectedVariantGroupsByItem((prev) => ({
                                              ...prev,
                                              [item.id]: {
                                                ...getDefaultGroupSelection(item),
                                                ...(prev[item.id] || {}),
                                                [group.name]: optionLabel,
                                              },
                                            }))
                                          }
                                          className={`rounded-full border px-2.5 py-1 text-xs font-semibold transition-colors ${
                                            isSelected
                                              ? 'border-foreground bg-foreground text-background'
                                              : 'border-border bg-transparent text-foreground'
                                          }`}
                                        >
                                          {group.type === 'price' && typeof option !== 'string'
                                            ? `${optionLabel} (${restaurant?.currency || 'N$'}${Number(option.price).toFixed(0)})`
                                            : optionLabel}
                                        </button>
                                      )
                                    })}
                                  </div>
                                </div>
                              )
                            })}
                          </div>
                        )}
                        
                        {/* Price + Add Button */}
                        <div className="flex items-center justify-between border-t border-border pt-2">
                          <div>
                            {(() => {
                              const resolvedSelection = getResolvedVariantSelection(item)
                              const displayPrice = getItemDisplayPrice(item, resolvedSelection)
                              return (
                            <p className="text-lg font-sans font-bold text-foreground">
                              <span className="text-sm font-normal text-muted-foreground mr-0.5">
                                {restaurant?.currency || 'N$'}
                              </span>
                              {displayPrice.toFixed(2)}
                            </p>
                              )
                            })()}
                            {item.status === 'out_of_stock' && (
                              <p className="text-xs font-sans text-destructive mt-0.5">Out of Stock</p>
                            )}
                          </div>
                          <Button
                            onClick={() => handleAddToCart(item)}
                            disabled={
                              !isInTab ||
                              item.status === 'out_of_stock' ||
                              addingItemId === item.id ||
                              isRequiredVariantMissing(item, getResolvedVariantSelection(item)) ||
                              ['settled', 'closed', 'completed', 'cancelled'].includes(
                                String(tabStatus ?? '').toLowerCase()
                              )
                            }
                            size="sm"
                            className="h-11 bg-foreground px-4 font-sans text-sm font-semibold text-background hover:bg-foreground/90"
                          >
                            {!isInTab ? (
                              'Create Tab to Order'
                            ) : item.status === 'out_of_stock' ? (
                              'Unavailable'
                            ) : addingItemId === item.id ? (
                              <span className="inline-flex items-center gap-2">
                                <Loader2 className="h-4 w-4 animate-spin stroke-[1.5]" />
                                Adding...
                              </span>
                            ) : (
                              'Add +'
                            )}
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
                    ? `No items found for "${searchQuery}"`
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
            if (!isInTab) return
            addItem(cartItem)
            pushCartToast(cartItem.display_name || cartItem.name)
            setSelectedItem(null)
          }}
        />
      )}

      {!isInTab && (
        <div className="fixed bottom-0 left-0 right-0 bg-foreground text-background px-4 py-3 text-center font-sans text-sm font-medium z-50">
          <button
            onClick={() =>
              router.replace(
                `/menu/${restaurantId}${tableNumber > 0 ? `?table=${tableNumber}` : ''}`
              )
            }
            className="underline"
          >
            Create a tab to start ordering
          </button>
        </div>
      )}

      <div className="pointer-events-none fixed inset-x-0 top-3 z-[60] flex flex-col items-center gap-2 px-4 sm:top-4">
        {toasts.map((toast) => (
          <div
            key={toast.id}
            className={`transition-all duration-300 ${
              toast.leaving ? 'translate-y-[-8px] opacity-0' : 'translate-y-0 opacity-100'
            }`}
          >
            <div className="inline-flex items-center gap-2 rounded-md bg-foreground px-4 py-2 text-sm font-medium text-background shadow-lg">
              <CheckCircle2 className="h-4 w-4 text-green-400 stroke-[2]" />
              <span>{toast.name} added to cart</span>
            </div>
          </div>
        ))}
      </div>

    </div>
  )
}
