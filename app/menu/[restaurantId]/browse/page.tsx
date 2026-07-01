'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { useParams, useSearchParams, useRouter } from 'next/navigation'
import { useRestaurant } from '@/contexts/restaurant-context'
import { getSupabaseCategories } from '@/lib/supabase/menu'
import { useCart } from '@/contexts/cart-context'
import { useClearCartOnTableChange } from '@/hooks/useClearCartOnTableChange'
import { getOrCreateSession, getCurrentSession, getSessionInfo } from '@/lib/session'
import { restoreSessionFromTable } from '@/lib/session-recovery'
import OrderStatusBanner from '@/components/OrderStatusBanner'
import { MenuOrderStatusTracker } from '@/components/menu/menu-order-status-tracker'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Search, ArrowLeft, Receipt, CheckCircle2, Loader2, Plus, Shield, Zap, Smartphone } from 'lucide-react'
import Image from 'next/image'
import Link from 'next/link'
import { restaurantLogoDisplayUrl } from '@/lib/restaurant-logo'
import { ItemDetailModal } from '@/components/menu/item-detail-modal'
import { FoodItemImage } from '@/components/menu/food-item-image'
import { useTab } from '@/contexts/tab-context'
import { useTabSessionEndedRedirect } from '@/hooks/useTabSessionEndedRedirect'
import { readStoredTabId } from '@/lib/tab-storage'
import { fetchTabById } from '@/lib/tab-session'
import { getOrderingContext, isKioskChannel } from '@/lib/ordering/channel'

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

const ACCENT = '#C0392B'

function isPopularItem(item: MenuItem): boolean {
  return item.is_popular === true
}

function flattenGroupedItems(
  grouped: Record<string, { subcategory: SubCategory; items: MenuItem[] }>
): MenuItem[] {
  const seen = new Set<string>()
  const result: MenuItem[] = []
  for (const entry of Object.values(grouped)) {
    for (const item of entry.items || []) {
      if (!item?.id || seen.has(item.id)) continue
      seen.add(item.id)
      result.push(item)
    }
  }
  return result
}

export default function MenuBrowsePage() {
  const params = useParams()
  const searchParams = useSearchParams()
  const orderingCtx = getOrderingContext(searchParams)
  const isKiosk = isKioskChannel(orderingCtx)
  const router = useRouter()
  const restaurantId = params.restaurantId as string
  const tableNumber = Number(searchParams?.get('table') || searchParams?.get('tableNumber') || '1')
  const tabIdParam = searchParams.get('tabId')?.trim() || ''
  const kioskSessionId = isKiosk ? getCurrentSession() : null

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
  const { restaurant, currency } = useRestaurant()

  const effectiveTabId = tabIdParam || tabId || readStoredTabId() || ''
  const { redirecting: tabSessionRedirecting } = useTabSessionEndedRedirect({
    restaurantId,
    tableNumber,
    tabId: effectiveTabId || null,
    tabStatus,
    enabled: Boolean(effectiveTabId),
    onSessionEnded: () => clearCart(),
  })

  const browseQuery = useMemo(() => {
    if (!(tableNumber > 0)) return ''
    const activeTabId = tabId || tabIdParam
    if (activeTabId) {
      return `?table=${tableNumber}&tabId=${encodeURIComponent(activeTabId)}`
    }
    return `?table=${tableNumber}`
  }, [tableNumber, tabIdParam, tabId])

  const myOrdersHref = useMemo(() => {
    const params = new URLSearchParams()
    if (tableNumber > 0) params.set('table', String(tableNumber))
    if (tabId || tabIdParam) params.set('tabId', tabId || tabIdParam)
    if (isKiosk) {
      params.set('kiosk', 'true')
      params.set('name', orderingCtx.customerName)
    } else {
      params.set('name', restaurant?.name || '')
      params.set('currency', currency)
    }
    return `/menu/${restaurantId}/cart?${params.toString()}`
  }, [restaurantId, tableNumber, tabId, tabIdParam, restaurant?.name, currency, isKiosk, orderingCtx.customerName])

  const [myOrdersLoading, setMyOrdersLoading] = useState(false)

  const creatorTabPin = useMemo(() => {
    if (typeof window === 'undefined') return null
    const activeTabId = tabIdParam || tabId || readStoredTabId() || ''
    if (!activeTabId) return null
    const storedTabId = sessionStorage.getItem('flashtap_creator_tab_id')
    const pin = sessionStorage.getItem('flashtap_creator_tab_pin')
    if (storedTabId === activeTabId && pin) return pin
    return null
  }, [tabIdParam, tabId])
  const [tabPinRequired, setTabPinRequired] = useState(true)
  const [menuCategories, setMenuCategories] = useState<MenuCategory[]>([])
  const [categoryFilter, setCategoryFilter] = useState<'all' | string>('all')
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

  useEffect(() => {
    if (!isInTab || !effectiveTabId || !restaurantId) return

    let cancelled = false
    void fetchTabById(effectiveTabId, restaurantId).then((tab) => {
      if (cancelled) return
      setTabPinRequired(tab?.pin_required !== false)
    })

    return () => {
      cancelled = true
    }
  }, [isInTab, effectiveTabId, restaurantId])

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
        const categoriesData = await getSupabaseCategories(restaurantId, true)
        setMenuCategories(categoriesData)

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
  const useAllMenu = normalizedSearchQuery.length > 0 || categoryFilter === 'all'
  const menuItemsSource = useAllMenu ? allGroupedItems : groupedItems
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

  const displayItems = useMemo(
    () => flattenGroupedItems(
      Object.fromEntries(filteredGroupedEntries.map(({ subcategory, items }) => [subcategory.id, { subcategory, items }]))
    ),
    [filteredGroupedEntries]
  )

  const popularItems = useMemo(
    () => flattenGroupedItems(allGroupedItems).filter(isPopularItem),
    [allGroupedItems]
  )

  const renderVariantSelectors = (item: MenuItem) => {
    if (getVariantGroups(item).length === 0) return null
    const resolvedSelection = getResolvedVariantSelection(item)
    return (
      <div className="mb-2 space-y-2">
        {getVariantGroups(item).map((group) => (
          <div key={`${item.id}-${group.name}`}>
            <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-gray-400">
              {group.name}
            </p>
            <div className="flex flex-wrap gap-1.5">
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
                    className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold transition-colors ${
                      isSelected
                        ? 'border-black bg-black text-white'
                        : 'border-gray-200 bg-white text-black'
                    }`}
                  >
                    {group.type === 'price' && typeof option !== 'string'
                      ? `${optionLabel} (${currency}${Number(option.price).toFixed(0)})`
                      : optionLabel}
                  </button>
                )
              })}
            </div>
          </div>
        ))}
      </div>
    )
  }

  const renderAddButton = (item: MenuItem, compact = false) => (
    <button
      type="button"
      onClick={() => handleAddToCart(item)}
      disabled={
        (!isInTab && !isKiosk) ||
        item.status === 'out_of_stock' ||
        addingItemId === item.id ||
        isRequiredVariantMissing(item, getResolvedVariantSelection(item)) ||
        ['settled', 'closed', 'completed', 'cancelled'].includes(String(tabStatus ?? '').toLowerCase())
      }
      className={`flex shrink-0 items-center justify-center rounded-full font-bold text-white transition-opacity hover:opacity-90 disabled:opacity-40 ${
        compact ? 'h-8 w-8' : 'h-9 w-9'
      }`}
      style={{ backgroundColor: ACCENT }}
      aria-label={`Add ${item.name} to cart`}
    >
      {addingItemId === item.id ? (
        <Loader2 className="h-4 w-4 animate-spin" />
      ) : (
        <Plus className="h-4 w-4" strokeWidth={2.5} />
      )}
    </button>
  )

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
    if (!isInTab && !isKiosk) return
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
      setSelectedItem(item as any)
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
    <div className="min-h-screen max-w-full bg-white text-black">
      <OrderStatusBanner restaurantId={restaurantId} tableNumber={tableNumber} />

      {/* Sticky Header — unchanged */}
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
                      alt={restaurant?.name || 'Restaurant'}
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
              <Button
                size="sm"
                disabled={myOrdersLoading}
                onClick={() => {
                  if (myOrdersLoading) return
                  setMyOrdersLoading(true)
                  router.push(myOrdersHref)
                }}
                className="relative h-11 cursor-pointer rounded-full bg-black px-4 font-sans text-xs font-semibold text-white hover:bg-black/90 disabled:opacity-70 disabled:cursor-not-allowed sm:text-sm"
              >
                {myOrdersLoading ? (
                  <>
                    <Loader2 className="mr-1.5 h-4 w-4 animate-spin" aria-hidden />
                    Loading...
                  </>
                ) : (
                  'My Orders'
                )}
                {!myOrdersLoading && getItemCount() > 0 ? (
                  <span
                    className="absolute -right-1 -top-1 flex h-5 min-w-5 items-center justify-center rounded-full px-1 text-[10px] font-bold text-white"
                    style={{ backgroundColor: ACCENT }}
                  >
                    {getItemCount()}
                  </span>
                ) : null}
              </Button>
            </div>
          </div>
        </div>
      </header>

      {isInTab && (
        <div className="border-b border-border bg-foreground text-background">
          <Link href={`/menu/${restaurantId}/tab${browseQuery}`}>
            <div className="mx-auto max-w-4xl px-4 py-2 text-center text-sm sm:text-left">
              {tabStatus === 'ready_to_pay'
                ? `Ready to pay • ${currency}${(Number(tabTotal) || 0).toFixed(2)} — waiter notified`
                : tabStatus === 'closed'
                  ? `Tab closed • ${currency}${(0).toFixed(2)} • 0 people`
                  : creatorTabPin && tabPinRequired ? (
                      <>
                        Tab open • {currency}
                        {(Number(tabTotal) || 0).toFixed(2)} • {tabMembers.length}{' '}
                        {tabMembers.length === 1 ? 'person' : 'people'} • PIN:{' '}
                        <span className="font-bold text-emerald-400">{creatorTabPin}</span> — Tap to settle →
                      </>
                    ) : (
                      `Tab open • ${currency}${(Number(tabTotal) || 0).toFixed(2)} • ${
                        tabMembers.length
                      } ${tabMembers.length === 1 ? 'person' : 'people'} — Tap to settle →`
                    )}
            </div>
          </Link>
        </div>
      )}

      <MenuOrderStatusTracker
        restaurantId={restaurantId}
        tableNumber={tableNumber}
        currency={currency}
        tabId={effectiveTabId || undefined}
        isKiosk={isKiosk}
        customerName={isKiosk ? orderingCtx.customerName : undefined}
        sessionId={isKiosk ? kioskSessionId ?? undefined : undefined}
      />

      <div className="mx-auto max-w-4xl px-4 pt-4 pb-28 sm:pb-32">
        {/* Search */}
        <div className="relative mb-4">
          <Search className="absolute left-4 top-1/2 h-5 w-5 -translate-y-1/2 text-gray-400 stroke-[1.5]" />
          <Input
            type="text"
            placeholder="Search menu items..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="h-11 rounded-xl border-gray-200 bg-white pl-12 font-sans text-base text-black sm:text-sm"
          />
        </div>

        {/* Category tabs */}
        {menuCategories.length > 0 ? (
          <div
            className="mb-6 flex gap-2 overflow-x-auto pb-1"
            style={{ scrollbarWidth: 'none', msOverflowStyle: 'none', WebkitOverflowScrolling: 'touch' }}
          >
            <button
              type="button"
              onClick={() => {
                setCategoryFilter('all')
                setSelectedMenuCategory(null)
                setSearchQuery('')
              }}
              className={`shrink-0 whitespace-nowrap rounded-full px-5 py-2 text-sm font-semibold transition-colors ${
                categoryFilter === 'all'
                  ? 'bg-black text-white'
                  : 'border border-gray-300 bg-white text-black hover:bg-gray-50'
              }`}
            >
              All
            </button>
            {menuCategories.map((category) => (
              <button
                key={category.id}
                type="button"
                onClick={() => {
                  setCategoryFilter(category.id)
                  setSelectedMenuCategory(category)
                  setSearchQuery('')
                }}
                className={`shrink-0 whitespace-nowrap rounded-full px-5 py-2 text-sm font-semibold transition-colors ${
                  categoryFilter === category.id
                    ? 'bg-black text-white'
                    : 'border border-gray-300 bg-white text-black hover:bg-gray-50'
                }`}
              >
                {category.name}
              </button>
            ))}
          </div>
        ) : null}

        {/* Popular Picks */}
        {popularItems.length > 0 ? (
          <section className="mb-8">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-lg font-bold text-black">Popular Picks ⭐</h2>
              <button
                type="button"
                onClick={() => {
                  setCategoryFilter('all')
                  setSelectedMenuCategory(null)
                  setSearchQuery('')
                  document.getElementById('all-menu')?.scrollIntoView({ behavior: 'smooth' })
                }}
                className="text-sm font-medium"
                style={{ color: ACCENT }}
              >
                View All →
              </button>
            </div>
            <div className="flex gap-4 overflow-x-auto pb-2" style={{ scrollbarWidth: 'none' }}>
              {popularItems.map((item) => {
                const resolvedSelection = getResolvedVariantSelection(item)
                const displayPrice = getItemDisplayPrice(item, resolvedSelection)
                return (
                  <article
                    key={`popular-${item.id}`}
                    className="relative w-40 shrink-0 overflow-hidden rounded-2xl border border-gray-100 bg-white shadow-sm sm:w-44"
                  >
                    <div className="relative aspect-square w-full overflow-hidden bg-gray-100">
                      <span
                        className="absolute left-2 top-2 z-10 rounded-full px-2 py-0.5 text-[10px] font-bold text-white"
                        style={{ backgroundColor: ACCENT }}
                      >
                        Popular
                      </span>
                      <FoodItemImage
                        itemName={item.name}
                        menuItemId={item.id}
                        storedImageUrl={item.image_url}
                        alt={item.name}
                        className="h-full w-full object-cover"
                      />
                    </div>
                    <div className="p-3">
                      <div className="flex items-end justify-between gap-2">
                        <div className="min-w-0">
                          <h3 className="truncate text-sm font-semibold text-black">{item.name}</h3>
                          <p className="text-sm font-bold" style={{ color: ACCENT }}>
                            {currency}
                            {displayPrice.toFixed(2)}
                          </p>
                        </div>
                        {renderAddButton(item, true)}
                      </div>
                    </div>
                  </article>
                )
              })}
            </div>
          </section>
        ) : null}

        {/* All Menu */}
        <section id="all-menu">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-lg font-bold text-black">All Menu</h2>
            <button
              type="button"
              onClick={() => {
                setCategoryFilter('all')
                setSelectedMenuCategory(null)
                setSearchQuery('')
              }}
              className="text-sm font-medium"
              style={{ color: ACCENT }}
            >
              View All Items →
            </button>
          </div>

          {displayItems.length > 0 ? (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {displayItems.map((item) => {
                const resolvedSelection = getResolvedVariantSelection(item)
                const displayPrice = getItemDisplayPrice(item, resolvedSelection)
                return (
                  <article
                    key={item.id}
                    className="flex gap-3 rounded-2xl border border-gray-100 bg-white p-3 shadow-sm"
                  >
                    <div className="relative h-20 w-20 shrink-0 overflow-hidden rounded-xl bg-gray-100">
                      <FoodItemImage
                        itemName={item.name}
                        menuItemId={item.id}
                        storedImageUrl={item.image_url}
                        alt={item.name}
                        className="h-full w-full object-cover"
                      />
                    </div>
                    <div className="flex min-w-0 flex-1 flex-col">
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0 flex-1">
                          <h3 className="font-bold leading-tight text-black">{item.name}</h3>
                          {item.description ? (
                            <p className="mt-0.5 line-clamp-2 text-xs text-gray-500">{item.description}</p>
                          ) : null}
                        </div>
                        {renderAddButton(item)}
                      </div>
                      {renderVariantSelectors(item)}
                      <div className="mt-auto flex items-center justify-between pt-1">
                        <p className="text-sm font-bold" style={{ color: ACCENT }}>
                          {currency}
                          {displayPrice.toFixed(2)}
                        </p>
                        {item.status === 'out_of_stock' ? (
                          <span className="text-xs text-red-600">Out of stock</span>
                        ) : (!isInTab && !isKiosk) ? (
                          <span className="text-[10px] text-gray-400">Create tab to order</span>
                        ) : null}
                      </div>
                    </div>
                  </article>
                )
              })}
            </div>
          ) : (
            !loading && (
              <div className="rounded-2xl border border-gray-100 bg-white py-16 text-center">
                <div className="mx-auto max-w-md px-6">
                  <div className="mb-6 text-6xl">🍽️</div>
                  <h3 className="mb-2 text-xl font-bold text-black">
                    {searchQuery ? 'No items found' : 'Menu coming soon!'}
                  </h3>
                  <p className="mb-2 text-gray-500">
                    {searchQuery
                      ? `No items found for "${searchQuery}"`
                      : selectedMenuCategory
                        ? `No items in "${selectedMenuCategory.name}" yet.`
                        : "This restaurant hasn't added menu items yet."}
                  </p>
                  {!searchQuery ? (
                    <p className="text-sm text-gray-400">Please ask staff for assistance.</p>
                  ) : null}
                </div>
              </div>
            )
          )}
        </section>
      </div>

      {/* Footer */}
      <footer className="border-t border-gray-200 bg-white py-10">
        <div className="mx-auto grid max-w-4xl grid-cols-1 gap-8 px-4 sm:grid-cols-3">
          <div className="text-center sm:text-left">
            <Shield className="mx-auto mb-2 h-6 w-6 text-black sm:mx-0" strokeWidth={1.5} />
            <p className="font-bold text-black">Secure &amp; Safe</p>
            <p className="mt-1 text-sm text-gray-500">Encrypted payments &amp; data protection</p>
          </div>
          <div className="text-center sm:text-left">
            <Zap className="mx-auto mb-2 h-6 w-6 text-black sm:mx-0" strokeWidth={1.5} />
            <p className="font-bold text-black">Fast &amp; Easy</p>
            <p className="mt-1 text-sm text-gray-500">Order in seconds from your table</p>
          </div>
          <div className="text-center sm:text-left">
            <Smartphone className="mx-auto mb-2 h-6 w-6 text-black sm:mx-0" strokeWidth={1.5} />
            <p className="font-bold text-black">Contactless</p>
            <p className="mt-1 text-sm text-gray-500">No app download required</p>
          </div>
        </div>
      </footer>

      {/* Item Detail Modal */}
      {selectedItem && (
        <ItemDetailModal
          item={selectedItem as any}
          restaurant={restaurant ? { ...restaurant, currency } : { currency }}
          onClose={() => setSelectedItem(null)}
          onAddToCart={(cartItem) => {
            if (!isInTab && !isKiosk) return
            addItem(cartItem)
            pushCartToast(cartItem.display_name || cartItem.name)
            setSelectedItem(null)
          }}
        />
      )}

      {!isInTab && !isKiosk && (
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
