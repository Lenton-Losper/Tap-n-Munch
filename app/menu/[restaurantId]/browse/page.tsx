'use client'

import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { useParams, useSearchParams, useRouter } from 'next/navigation'
import { useRestaurant } from '@/contexts/restaurant-context'
import { getSupabaseCategories } from '@/lib/supabase/menu'
import { isChargeableMenuStatus } from '@/lib/menu/menu-item-status'
import { useCart } from '@/contexts/cart-context'
import { useClearCartOnTableChange } from '@/hooks/useClearCartOnTableChange'
import { getOrCreateSession, getCurrentSession, getSessionInfo } from '@/lib/session'
import { getSessionToken } from '@/lib/fetch-with-session'
import { restoreSessionFromTable } from '@/lib/session-recovery'
import OrderStatusBanner from '@/components/OrderStatusBanner'
// MenuOrderStatusTracker is no longer rendered here (spec section 8). The component file is kept
// -- see the note at its former render site for why deleting it would be a different change.
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Search, ArrowLeft, Users, ListChecks, CheckCircle2, Loader2, Plus, Shield, Zap, Smartphone, AlertTriangle } from 'lucide-react'
import Image from 'next/image'
import Link from 'next/link'
import { restaurantLogoDisplayUrl } from '@/lib/restaurant-logo'
import { ItemDetailModal } from '@/components/menu/item-detail-modal'
import { CUSTOMER_NAV_COPY } from '@/lib/customer-nav-copy'
import { FoodItemImage } from '@/components/menu/food-item-image'
import { useTab } from '@/contexts/tab-context'
import { useTabSessionEndedRedirect } from '@/hooks/useTabSessionEndedRedirect'
import { readStoredTabId } from '@/lib/tab-storage'
import { buildBrowseTabStrip } from '@/lib/tabs/browse-tab-strip'
import {
  EDIT_PICK_PARAM,
  appendPendingAddition,
  toPendingAddition,
} from '@/lib/orders/edit-pending-additions'
import { QR_REDESIGN_PENDING_COPY } from '@/lib/customer-copy/qr-redesign-copy'
import { fetchTabById } from '@/lib/tab-session'
import { getOrderingContext, isKioskChannel } from '@/lib/ordering/channel'
import { getSupabaseTableByNumber } from '@/lib/supabase/tables'
import {
  fetchCategoryMenu,
  loadAllMenuCategories,
  menuLoadNotice,
  type MenuLoadFailure,
} from '@/lib/menu/load-menu-categories'
import { menuBodyState } from '@/lib/menu/menu-body-state'
import { canOpenItemSheet } from '@/lib/menu/item-sheet-availability'
import {
  getDefaultGroupSelection,
  getItemDisplayPrice,
  getVariantGroups,
  getVariantOptionLabel,
  isRequiredVariantMissing,
} from '@/lib/menu/variant-groups'

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
  /**
   * PICKER MODE. Set when the customer arrived here from the ORDER EDITOR via "+ Add something".
   * The menu behaves identically except at the moment of adding: the item goes to that order's
   * pending edit instead of to the cart, and the customer is returned to it.
   */
  const pickForOrderId = searchParams.get(EDIT_PICK_PARAM)?.trim() || ''

  useEffect(() => {
    if (typeof window === 'undefined') return
    if (sessionStorage.getItem('flashtap_session_expired') === 'true') {
      window.location.replace(`/menu/${restaurantId}/session-ended`)
      return
    }
  }, [restaurantId])

  useClearCartOnTableChange(restaurantId, tableNumber)

  const { items: cartItems, getItemCount, addItem, clearCart } = useCart()
  const { isInTab, tabId, tabTotal, tabPending, tabMembers, tabStatus, clearTab } = useTab()
  const { restaurant, currency } = useRestaurant()
  /**
   * The strip DISPLAYS, so it shows both figures: `tabTotal` is payable + pending, and the
   * pending part is named whenever it exists. Showing payable alone is what told a customer who
   * had just ordered N$132 that they owed NAD0.00 — every QR submission is an order_request
   * until staff Accept, and payable counts orders only.
   */
  // Built in lib/tabs/browse-tab-strip.ts. See the note at the render site for why it is not
  // assembled here: one arm of the old inline ternary dropped the pending figure entirely.

  // Authoritative view-only check: looked up from the real restaurant_tables row for this
  // table_number, never trusted from a URL flag. Until it resolves, isViewOnly stays false
  // and the page shows a loading state (see the `loading || !viewOnlyChecked` guard below)
  // rather than briefly rendering the ordering UI and then yanking it away.
  const [isViewOnly, setIsViewOnly] = useState(false)
  const [viewOnlyChecked, setViewOnlyChecked] = useState(false)

  /* eslint-disable react-hooks/set-state-in-effect -- intentional deps-triggered data fetch, same pattern used elsewhere in the menu app */
  useEffect(() => {
    let cancelled = false
    if (!(tableNumber > 0) || !restaurantId) {
      setIsViewOnly(false)
      setViewOnlyChecked(true)
      return
    }
    getSupabaseTableByNumber(restaurantId, tableNumber, false)
      .then((tableRow) => {
        if (cancelled) return
        setIsViewOnly(Boolean((tableRow as { is_view_only?: boolean } | null)?.is_view_only))
        setViewOnlyChecked(true)
      })
      .catch(() => {
        if (cancelled) return
        setIsViewOnly(false)
        setViewOnlyChecked(true)
      })
    return () => {
      cancelled = true
    }
  }, [restaurantId, tableNumber])
  /* eslint-enable react-hooks/set-state-in-effect */

  // Never honor a tab the customer's browser happens to be carrying (URL tabId or stale
  // localStorage) once we know this ordering point is view-only -- scrub it, don't just
  // hide it, so it can't resurface on a later navigation either.
  useEffect(() => {
    if (isViewOnly) {
      clearTab()
      clearCart()
    }
    // clearTab/clearCart are not memoized by their providers; run only when the
    // authoritative view-only flag actually changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isViewOnly])

  const effectiveIsInTab = isViewOnly ? false : isInTab
  const effectiveTabId = isViewOnly ? '' : tabIdParam || tabId || readStoredTabId() || ''
  const { redirecting: tabSessionRedirecting } = useTabSessionEndedRedirect({
    restaurantId,
    tableNumber,
    tabId: effectiveTabId || null,
    tabStatus,
    // viewOnlyChecked gates this, not just Boolean(effectiveTabId): the view-only lookup
    // is async, so on first mount effectiveTabId can still briefly reflect a stale tab id
    // from a different table before isViewOnly resolves. Without this gate, this hook
    // would race ahead, find that stale tab id doesn't exist, and fire a hard
    // window.location redirect to /session-ended before the view-only override ever
    // takes effect -- exactly the "honoring stale localStorage" bug this page must avoid.
    enabled: viewOnlyChecked && Boolean(effectiveTabId),
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

  /**
 * THE CART. This was called `myOrdersHref` and the button above it read "My Orders", but it has
 * always pointed at /cart — and nothing in the app navigated to /menu/[id]/my-orders at all, so
 * the order list was unreachable except by typing the URL. A customer who had just placed an
 * order tapped "My Orders", landed on an emptied cart, and was told "Your cart is empty".
 *
 * The destination was right and the label was wrong: the cart is where an order is submitted, so
 * the button is the Cart. A separate My Orders entry sits beside it.
 */
  const cartHref = useMemo(() => {
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

  /** The order list — the page `cartHref` was mislabelled as. Carries the table so the list can
   * scope itself, and nothing else: it reads orders by session, not by tab. */
  const myOrdersHref = useMemo(() => {
    const params = new URLSearchParams()
    if (tableNumber > 0) params.set('table', String(tableNumber))
    return `/menu/${restaurantId}/my-orders${params.toString() ? `?${params.toString()}` : ''}`
  }, [restaurantId, tableNumber])

  const [myOrdersLoading, setMyOrdersLoading] = useState(false)

  /**
   * The creator's own device remembering its own PIN, written once at creation.
   *
   * This is NOT a check of anything — it is sessionStorage, which the client wrote itself — so
   * it can only ever show the PIN to the one person who created the tab, and it dies when the
   * browser tab closes. Everyone who JOINED the tab had no way to see the PIN they had just
   * typed, which is most of why #265 (staff-driven PIN recovery) exists at all.
   *
   * Demoted to a pre-fetch fallback below. Kept rather than deleted because it costs nothing and
   * is not a disclosure: it is this device showing this device's own PIN, exactly as today. It
   * is never treated as proof of membership — `fetchedTabPin` is the real source.
   */
  const creatorTabPin = useMemo(() => {
    if (typeof window === 'undefined') return null
    const activeTabId = tabIdParam || tabId || readStoredTabId() || ''
    if (!activeTabId) return null
    const storedTabId = sessionStorage.getItem('flashtap_creator_tab_id')
    const pin = sessionStorage.getItem('flashtap_creator_tab_pin')
    if (storedTabId === activeTabId && pin) return pin
    return null
  }, [tabIdParam, tabId])

  /** The PIN as returned by the session-token-guarded read. Null until it resolves, and on any
   *  failure — so the display falls back to `creatorTabPin` rather than to nothing. */
  const [fetchedTabPin, setFetchedTabPin] = useState<string | null>(null)

  /** What the header and the tab strip actually render. */
  const tabPin = fetchedTabPin ?? creatorTabPin

  const [tabPinRequired, setTabPinRequired] = useState(true)

  /** Spec section 9. One call, so no branch can render an amount without its pending note. */
  const tabStrip = buildBrowseTabStrip({
    tabStatus,
    currency,
    total: Number(tabTotal) || 0,
    pending: Number(tabPending) || 0,
    memberCount: tabMembers.length,
    tabPin,
    tabPinRequired,
  })

  const [menuCategories, setMenuCategories] = useState<MenuCategory[]>([])
  const [categoryFilter, setCategoryFilter] = useState<'all' | string>('all')
  const [selectedMenuCategory, setSelectedMenuCategory] = useState<MenuCategory | null>(null)
  const [groupedItems, setGroupedItems] = useState<Record<string, { subcategory: SubCategory; items: MenuItem[] }>>({})
  const [allGroupedItems, setAllGroupedItems] = useState<
    Record<string, { subcategory: SubCategory; items: MenuItem[] }>
  >({})
  const [searchQuery, setSearchQuery] = useState('')
  // Why the menu is empty, when it is empty. Without this a total outage and a restaurant with
  // no items render identically, and the page then affirmatively tells the customer the wrong one.
  const [allMenuLoadFailure, setAllMenuLoadFailure] = useState<MenuLoadFailure | null>(null)
  const [categoryLoadFailure, setCategoryLoadFailure] = useState<MenuLoadFailure | null>(null)
  const [menuReloadKey, setMenuReloadKey] = useState(0)
  // `loading` below covers the CATEGORY LIST and the table session only. The menu ITEMS are
  // fetched by two later effects, and until #214 neither had a loading state — so the page went
  // straight from the spinner to "Menu coming soon!" while the items were still on the wire.
  // These four track the item fetches. `loadedOnce` is not `!loading`: before the first fetch is
  // dispatched nothing is in flight either, and that window is where the false claim appeared.
  const [categoryMenuLoading, setCategoryMenuLoading] = useState(false)
  const [categoryMenuLoadedOnce, setCategoryMenuLoadedOnce] = useState(false)
  const [allMenuLoading, setAllMenuLoading] = useState(false)
  const [allMenuLoadedOnce, setAllMenuLoadedOnce] = useState(false)
  const [loading, setLoading] = useState(true)
  const [selectedItem, setSelectedItem] = useState<MenuItem | null>(null)
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
    if (!effectiveIsInTab || !effectiveTabId || !restaurantId) return

    let cancelled = false
    void fetchTabById(effectiveTabId, restaurantId).then((tab) => {
      if (cancelled) return
      setTabPinRequired(tab?.pin_required !== false)
    })

    return () => {
      cancelled = true
    }
  }, [effectiveIsInTab, effectiveTabId, restaurantId])

  /**
   * The tab PIN, for EVERY member of the tab rather than only its creator.
   *
   * GET /api/tabs/[tabId] is the session-token-guarded read (the same guard that lets this
   * customer add orders to the tab), and it returns `tab_pin` only to a holder of a token for
   * THIS tab. See that route for why that is a downgrade of a credential the caller already
   * holds and not new exposure — and for why the PIN is deliberately NOT on the unauthenticated
   * /view read that `fetchTabById` above uses.
   *
   * Plain `fetch`, deliberately NOT `fetchWithSession`: that helper treats any 410 as "your
   * dining session is over" and calls handleSessionExpired, which wipes the token, the tab id
   * and the cart and hard-redirects to /session-ended. A cosmetic PIN readout must never be able
   * to eject someone from their meal. Here a missing or rejected token means "no PIN to show", and
   * nothing else — the state falls back to `creatorTabPin`.
   */
  useEffect(() => {
    if (!effectiveIsInTab || !effectiveTabId) return

    const token = getSessionToken()
    if (!token) return

    let cancelled = false
    void fetch(`/api/tabs/${encodeURIComponent(effectiveTabId)}`, {
      headers: { 'x-session-token': token },
    })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (cancelled) return
        const pin = data?.tab?.tab_pin
        setFetchedTabPin(pin ? String(pin) : null)
      })
      .catch(() => {
        if (cancelled) return
        setFetchedTabPin(null)
      })

    return () => {
      cancelled = true
    }
  }, [effectiveIsInTab, effectiveTabId])

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

  /**
   * The selection this card is showing: the shared defaults, overridden by whatever the customer
   * tapped on the card itself. Stays here rather than in lib/menu/variant-groups because it is
   * the only part that depends on this page state -- the rules it wraps are shared with
   * ItemDetailModal, which now originates a selection too.
   */
  const getResolvedVariantSelection = (item: MenuItem): Record<string, string> => ({
    ...getDefaultGroupSelection(item),
    ...(selectedVariantGroupsByItem[item.id] || {}),
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
    // #225: the customer can tap another category before this one answers. Without this flag the
    // LATE response wins, and the abandoned category's items render under the current category's
    // heading — along with its failure notice, or its success clearing a notice that belongs to
    // the category actually on screen. Same idiom as the view-only and tab-pin effects above.
    let cancelled = false

    const loadMenuItems = async () => {
      if (!selectedMenuCategory || !restaurantId) {
        setGroupedItems({})
        setCategoryLoadFailure(null)
        // No category is selected, so nothing has been asked for and nothing has come back. The
        // "All" source is what is on screen in that state, and it carries its own flags.
        setCategoryMenuLoading(false)
        setCategoryMenuLoadedOnce(false)
        return
      }

      try {
        setCategoryMenuLoading(true)
        // Reset before asking, not after answering. Nothing here is known about the category the
        // customer just switched TO, and leaving the previous category's items in place renders
        // them under the new heading for the whole of the fetch — the same wrong-items-wrong-name
        // symptom as the stale-response race, but unconditional: it needs only a switch and a slow
        // response, not two requests in flight.
        setGroupedItems({})
        setCategoryLoadFailure(null)
        setCategoryMenuLoadedOnce(false)

        const grouped = await fetchCategoryMenu(restaurantId, selectedMenuCategory.id)
        if (cancelled) return
        setGroupedItems(grouped)
        setCategoryLoadFailure(null)
        setCategoryMenuLoadedOnce(true)
      } catch (err: any) {
        if (cancelled) return
        console.error('Failed to load menu items:', err)
        setGroupedItems({})
        setCategoryLoadFailure({
          failedCategoryNames: [selectedMenuCategory.name || ''],
          requestedCount: 1,
        })
      } finally {
        // Guarded so a superseded run cannot report "not loading" while the category the customer
        // is actually on is still in flight. Measured honestly: with the reset above in place this
        // guard is NOT load-bearing — removing it leaves all 8 tests in
        // browse-menu-stale-response green, because the reset clears `loadedOnce` and
        // menuBodyState then answers `loading` regardless. It is kept for consistency with the two
        // sibling effects above, which guard every setState they own, and as the second line if
        // the reset is ever removed. Do not read it as covered by test; it is not.
        if (!cancelled) setCategoryMenuLoading(false)
      }
    }

    loadMenuItems()

    return () => {
      cancelled = true
    }
  }, [restaurantId, selectedMenuCategory, menuReloadKey])

  useEffect(() => {
    // #225, same reasoning as the per-category effect above. This one re-runs when the category
    // LIST changes or on retry, so a superseded fan-out can otherwise land its merged result — and
    // its failure notice — over a newer one.
    let cancelled = false

    const loadAllMenuItems = async () => {
      if (!restaurantId || menuCategories.length === 0) {
        setAllGroupedItems({})
        setAllMenuLoadFailure(null)
        setAllMenuLoading(false)
        // A restaurant whose category list came back with nothing in it genuinely has no menu.
        // That is a COMPLETED determination, not a load still in flight, so it must resolve to
        // the empty state and not to a spinner that never stops.
        setAllMenuLoadedOnce(Boolean(restaurantId) && menuCategories.length === 0)
        return
      }

      try {
        setAllMenuLoading(true)
        const load = await loadAllMenuCategories(restaurantId, menuCategories)
        if (cancelled) return
        setAllGroupedItems(load.merged)
        setAllMenuLoadFailure(
          load.failedCategoryNames.length > 0
            ? {
                failedCategoryNames: load.failedCategoryNames,
                requestedCount: load.requestedCount,
              }
            : null
        )
        // `loadAllMenuCategories` uses allSettled, so it always COMPLETES; a total failure is
        // reported through the notice above, which the state rule reads before this flag. Marking
        // completion rather than success keeps the existing search-with-no-results wording
        // reachable instead of replacing it with a spinner for a load that is not running.
        setAllMenuLoadedOnce(true)
      } finally {
        if (!cancelled) setAllMenuLoading(false)
      }
    }

    void loadAllMenuItems()

    return () => {
      cancelled = true
    }
  }, [restaurantId, menuCategories, menuReloadKey])

  const normalizedSearchQuery = searchQuery.trim().toLowerCase()
  const useAllMenu = normalizedSearchQuery.length > 0 || categoryFilter === 'all'
  const menuItemsSource = useAllMenu ? allGroupedItems : groupedItems
  // The notice has to follow whichever source is on screen, or the customer gets told about a
  // failure in a view they are not looking at.
  const menuNotice = menuLoadNotice(useAllMenu ? allMenuLoadFailure : categoryLoadFailure)
  // Follows the same source as the notice — the flags of the view the customer is looking at.
  const menuSourceLoading = useAllMenu ? allMenuLoading : categoryMenuLoading
  const menuSourceLoadedOnce = useAllMenu ? allMenuLoadedOnce : categoryMenuLoadedOnce
  const retryMenuLoad = () => setMenuReloadKey((key) => key + 1)
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
    .sort((a, b) => {
      const catA = Number(a.subcategory?.categoryOrder ?? 0)
      const catB = Number(b.subcategory?.categoryOrder ?? 0)
      if (catA !== catB) return catA - catB
      const orderA = Number(a.subcategory?.display_order ?? 999)
      const orderB = Number(b.subcategory?.display_order ?? 999)
      if (orderA !== orderB) return orderA - orderB
      return String(a.subcategory?.name || '').localeCompare(String(b.subcategory?.name || ''))
    })

  // Three states, not two. See lib/menu/menu-body-state.ts for why "not loading" is not the same
  // question as "a load has finished".
  const bodyState = menuBodyState({
    hasEntries: filteredGroupedEntries.length > 0,
    notice: menuNotice,
    loading: menuSourceLoading,
    loadedOnce: menuSourceLoadedOnce,
    searchQuery,
  })

  const menuSectionTitle = selectedMenuCategory?.name
    ? selectedMenuCategory.name
    : normalizedSearchQuery
      ? 'Search results'
      : 'All Menu'

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
                const optionLabel = getVariantOptionLabel(option)
                const isSelected = resolvedSelection[group.name] === optionLabel
                return (
                  <button
                    key={`${item.id}-${group.name}-${optionLabel}-${optionIndex}`}
                    type="button"
                    onClick={(event) => {
                      // The card opens the item sheet; a chip must change the selection only.
                      event.stopPropagation()
                      setSelectedVariantGroupsByItem((prev) => ({
                        ...prev,
                        [item.id]: {
                          ...getDefaultGroupSelection(item),
                          ...(prev[item.id] || {}),
                          [group.name]: optionLabel,
                        },
                      }))
                    }}
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

  /**
   * The single availability rule, shared by the `+` button and the tappable card.
   * Two entry points that each compute their own version of this drift apart -- see
   * lib/menu/item-sheet-availability.ts for the incident that shape produced (#272).
   */
  const itemSheetAvailable = (item: MenuItem) =>
    canOpenItemSheet({
      isInTab: effectiveIsInTab,
      isKiosk,
      itemStatus: item.status,
      requiredVariantMissing: isRequiredVariantMissing(item, getResolvedVariantSelection(item)),
      tabStatus,
    })

  const renderAddButton = (item: MenuItem, compact = false) => (
    <button
      type="button"
      onClick={(event) => {
        // The card is tappable too; without this the card's handler fires as well.
        event.stopPropagation()
        handleAddToCart(item)
      }}
      disabled={!itemSheetAvailable(item)}
      className={`flex shrink-0 items-center justify-center rounded-full font-bold text-white transition-opacity hover:opacity-90 disabled:opacity-40 ${
        compact ? 'h-8 w-8' : 'h-9 w-9'
      }`}
      style={{ backgroundColor: ACCENT }}
      aria-label={`Add ${item.name} to cart`}
    >
      <Plus className="h-4 w-4" strokeWidth={2.5} />
    </button>
  )

  /**
   * Props that make a whole card open the item sheet.
   *
   * Spec section 11: every item uses the same interaction, and the customer should not have to
   * find a 9x9 target to reach it. When the item is unavailable the card carries no handler and
   * no button role at all, so it is inert rather than a control that silently does nothing.
   */
  const cardOpensSheetProps = (item: MenuItem) => {
    if (!itemSheetAvailable(item)) return {}
    return {
      role: 'button' as const,
      tabIndex: 0,
      onClick: () => handleAddToCart(item),
      onKeyDown: (event: ReactKeyboardEvent<HTMLElement>) => {
        if (event.key !== 'Enter' && event.key !== ' ') return
        event.preventDefault()
        handleAddToCart(item)
      },
      'aria-label': `Open ${item.name}`,
    }
  }

  const renderMenuItemCard = (item: MenuItem) => {
    const resolvedSelection = getResolvedVariantSelection(item)
    const displayPrice = getItemDisplayPrice(item, resolvedSelection)
    return (
      <article
        key={item.id}
        {...cardOpensSheetProps(item)}
        className={`flex gap-3 rounded-2xl border border-gray-100 bg-white p-3 shadow-sm ${
          itemSheetAvailable(item) ? 'cursor-pointer transition-shadow hover:shadow-md' : ''
        }`}
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
            ) : !effectiveIsInTab && !isKiosk && !isViewOnly ? (
              <span className="text-[10px] text-gray-400">Create tab to order</span>
            ) : null}
          </div>
        </div>
      </article>
    )
  }

  const subcategorySectionTitle = (subcategory: SubCategory) => {
    const name = String(subcategory?.name || 'Menu')
    // Synthetic bucket for items with no subcategory — no extra heading needed if alone.
    if (subcategory?.id === '__category_items__') return name
    if (categoryFilter === 'all' && subcategory?.categoryName) {
      return `${subcategory.categoryName} · ${name}`
    }
    return name
  }

  useEffect(() => {
    const allItems = Object.values(groupedItems).flatMap((entry) => entry.items || [])
    for (const item of allItems) {
      const name = String(item?.name || '')
      if (name === 'Tea' || name === 'Tea (Rooibos / Five Roses / Green Tea)' || name === 'Americano') {
        console.log('[browse][variantGroups-debug] item=', name, item)
      }
    }
  }, [groupedItems])

  /**
   * EVERY item opens the popup, including one with nothing to choose.
   *
   * An item with no options used to be added straight from the card. The add itself worked, but
   * it was silent: nothing on screen confirmed it, so a customer who was not watching the cart
   * badge tapped again, and again. A popup they have to dismiss is the confirmation -- and for a
   * zero-option item it is simply the same component with nothing to configure, showing the item,
   * its price, a quantity control and Add to Cart.
   *
   * The 1000ms artificial delay that used to sit in the silent path went with it. It existed to
   * make a spinner visible; there is no spinner now, and nothing else was waiting on it.
   */
  const handleAddToCart = (item: MenuItem) => {
    if (!effectiveIsInTab && !isKiosk) return
    // #272. Nothing the checkout would refuse may enter a cart. Two paths reach this
    // function and only one was guarded: the inline Add button is disabled for
    // 'out_of_stock' (renderAddButton), but an item with sizes/addons routes to
    // ItemDetailModal instead, whose own Add button has no status check at all. This is the
    // single funnel both paths pass through, so the guard belongs here.
    //
    // Deliberately `!isChargeable` rather than "is display-only": for the TTL.MENU window
    // after a menu edit, a cached payload can still contain an item that is no longer
    // visible, and that item must not be addable either.
    if (!isChargeableMenuStatus(item.status)) return
    setSelectedItem(item as any)
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

  if (loading || !viewOnlyChecked) {
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
            <div className="flex min-w-0 flex-1 items-center gap-2 sm:gap-3">
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
            
            {/* Right: Action Buttons -- none of these apply to a view-only menu (no
                receipt, no order to track), so the whole block is hidden there. */}
            {!isViewOnly && (
            <div className="flex shrink-0 items-center gap-1.5 sm:gap-2">
              {/* TAB — the shared table bill.
                  This slot used to hold **Receipt**. Spec sections 33 and 37: Receipt was a
                  primary navigation concept offered before anything receipt-like existed —
                  `/menu/[id]/receipt` is a running-bill screen, not a paid receipt, so the label
                  described neither what it opened nor when it was useful. The route is NOT
                  removed; it is still linked from the landing, `/menu`, the gateway-return
                  confirmation and ActiveOrderBanner. It is demoted out of the browse header.

                  What replaces it is the destination the redesign actually needs a header entry
                  for (spec section 7): the Tab was previously reachable ONLY by tapping the strip
                  below, which is not a control a first-time customer knows is a control. */}
              {effectiveIsInTab && (
                <Link href={`/menu/${restaurantId}/tab${browseQuery}`}>
                  <Button
                    variant="outline"
                    size="sm"
                    aria-label={QR_REDESIGN_PENDING_COPY.navTab}
                    className="h-11 border-border px-3 font-sans text-xs sm:text-sm"
                  >
                    <Users className="w-4 h-4 stroke-[1.5] sm:mr-1.5" />
                    <span className="hidden sm:inline">{QR_REDESIGN_PENDING_COPY.navTab}</span>
                  </Button>
                </Link>
              )}
              {/* My Orders — the order list. Separate from the Cart button beside it, because
                  they are different places: this one is the record of what has been ordered, that
                  one is what has not been submitted yet. */}
              <Button
                size="sm"
                variant="outline"
                onClick={() => router.push(myOrdersHref)}
                aria-label={CUSTOMER_NAV_COPY.myOrders}
                className="h-11 cursor-pointer rounded-full px-4 font-sans text-xs font-semibold sm:text-sm"
              >
                {/* Not Receipt — that is the button beside this one. Below `sm` both labels are
                    hidden and the icon is the only thing distinguishing them, so they must not
                    share a glyph. ListChecks has no bounding rectangle, which reads clearly
                    apart from Receipt's outlined shape at 16px. */}
                <ListChecks className="h-4 w-4 stroke-[1.5] sm:mr-1.5" />
                {/* Label collapses on small screens, exactly as the Receipt button beside it
                    already does. Adding a third control pushed the left block past its
                    truncation point — the restaurant name rendered as "S…" and the table as
                    "T…", which is worse than an unlabelled icon. */}
                <span className="hidden sm:inline">{CUSTOMER_NAV_COPY.myOrders}</span>
              </Button>
              <Button
                size="sm"
                disabled={myOrdersLoading}
                onClick={() => {
                  if (myOrdersLoading) return
                  setMyOrdersLoading(true)
                  router.push(cartHref)
                }}
                className="relative h-11 cursor-pointer rounded-full bg-black px-4 font-sans text-xs font-semibold text-white hover:bg-black/90 disabled:opacity-70 disabled:cursor-not-allowed sm:text-sm"
              >
                {myOrdersLoading ? (
                  <>
                    <Loader2 className="mr-1.5 h-4 w-4 animate-spin" aria-hidden />
                    Loading...
                  </>
                ) : (
                  CUSTOMER_NAV_COPY.cart
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
            )}
          </div>

          {/* NO PIN HERE. It renders once, in the tab strip immediately below this header.

              A line was briefly added here as well and removed on sight: it answered a question
              the strip already answers two rows down, and the strip answers it better. There the
              PIN sits beside the running total and the person count, which is the context a
              customer reads it in — "this table, these people, this number" — rather than as a
              free-floating figure under the restaurant name. Anything wanting to surface the PIN
              should change the strip, not add a second reading of it.

              Pinned by the "renders the PIN exactly once" case in
              __tests__/browse-tab-pin-visible-to-joined-member.test.tsx. */}
        </div>
      </header>

      {/* PICKER MODE BANNER. The menu looks the same as always, and the ONE thing that differs
          is what happens when you add something — which is invisible until it happens. So it is
          said out loud, with a way out that does not require guessing that Back is safe. */}
      {pickForOrderId && (
        <div className="border-b border-amber-300 bg-amber-50 px-4 py-2 text-sm font-sans text-amber-900">
          <div className="mx-auto flex max-w-4xl items-center justify-between gap-3">
            <span>{QR_REDESIGN_PENDING_COPY.pickerBanner}</span>
            <button
              type="button"
              className="shrink-0 font-semibold underline"
              onClick={() =>
                router.replace(
                  `/menu/${restaurantId}/order-confirmation/${pickForOrderId}${
                    tableNumber > 0 ? `?table=${tableNumber}` : ''
                  }`,
                )
              }
            >
              {QR_REDESIGN_PENDING_COPY.pickerBack}
            </button>
          </div>
        </div>
      )}

      {/* THE TAB STRIP — a lightweight entry point, not a summary of the whole bill.

          Spec section 9. It used to be one dense sentence carrying status, money, people, the
          PIN and "Tap to settle →". Two rows now: the money leads, and the PIN and people are
          demoted beneath it. It says VIEW rather than settle, because section 30 puts the
          settlement action on the Tab itself and leaves this as navigation.

          The string is built by lib/tabs/browse-tab-strip.ts rather than inline, and that is
          where the real fix is: the old three-way ternary appended the pending figure to its two
          template-string arms and NOT to the JSX arm — the arm taken whenever the tab has a PIN.
          A customer on a PIN-protected tab who had just ordered therefore saw payable alone, with
          nothing naming what the restaurant had not yet confirmed. Building the money line once,
          before anything branches on the PIN, is what stops that recurring. */}
      {effectiveIsInTab && (
        <div className="border-b border-border bg-foreground text-background">
          <Link href={`/menu/${restaurantId}/tab${browseQuery}`}>
            <div className="mx-auto flex max-w-4xl items-center justify-between gap-3 px-4 py-2">
              <div className="min-w-0">
                <p className="truncate text-sm">
                  <span className="font-semibold">{tabStrip.headline}</span>
                  {tabStrip.amount ? <span> · {tabStrip.amount}</span> : null}
                  {tabStrip.pendingNote ? (
                    <span className="text-background/70"> {tabStrip.pendingNote}</span>
                  ) : null}
                </p>
                {tabStrip.meta ? (
                  <p className="truncate text-xs text-background/70">{tabStrip.meta}</p>
                ) : null}
              </div>
              <span className="shrink-0 text-xs font-semibold">{tabStrip.cta}</span>
            </div>
          </Link>
        </div>
      )}

      {/* NO ORDER TRACKER HERE. Spec section 8.

          <MenuOrderStatusTracker /> rendered a SIX-STEP progress bar per active order, above the
          food. With four people at one table across several rounds that is the whole first
          screen, and the customer scrolls past their own order history to reach the menu — which
          is the one thing this screen exists for. Order tracking now lives on My Orders, which is
          also where Place Order lands (piece 2).

          THE COMPONENT FILE IS DELIBERATELY NOT DELETED. Nothing else renders it, but eight
          suites `jest.mock` it by path, and it carries ReadyToPayCardButton — one of the two
          competing "call the waiter" affordances (audit D8). Deleting it would fold a settlement
          decision into a layout change. It is removed from this screen only; the consolidation
          is piece 7. */}

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
                    {...cardOpensSheetProps(item)}
                    className={`relative w-40 shrink-0 overflow-hidden rounded-2xl border border-gray-100 bg-white shadow-sm sm:w-44 ${
                      itemSheetAvailable(item) ? 'cursor-pointer transition-shadow hover:shadow-md' : ''
                    }`}
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

        {/* Menu list — heading follows category chip; items grouped by subcategory */}
        <section id="all-menu">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-lg font-bold text-black">{menuSectionTitle}</h2>
            {categoryFilter !== 'all' || normalizedSearchQuery ? (
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
            ) : null}
          </div>

          {menuNotice && menuNotice.tone === 'partial' && filteredGroupedEntries.length > 0 ? (
            <div className="mb-6 flex flex-col gap-3 rounded-2xl border border-amber-200 bg-amber-50 p-4 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex items-start gap-3">
                <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-600" aria-hidden />
                <div>
                  <p className="font-semibold text-amber-900">{menuNotice.title}</p>
                  <p className="text-sm text-amber-800">{menuNotice.description}</p>
                </div>
              </div>
              <Button
                variant="outline"
                onClick={retryMenuLoad}
                className="shrink-0 border-amber-300 bg-white text-amber-900 hover:bg-amber-100"
              >
                {menuNotice.retryLabel}
              </Button>
            </div>
          ) : null}

          {/*
            * Three states, decided by menuBodyState:
            *
            *   items   — something to show.
            *   loading — we do not yet know. A failed load must never fall through to
            *             "Menu coming soon!", and neither must a load that is merely SLOW: both
            *             tell the customer the restaurant sells nothing, which is a claim we have
            *             no basis for and which is wrong exactly when the kitchen is busiest.
            *   failed  — the fetch rejected. The notice, with its retry, replaces the list.
            *   empty   — a fetch completed successfully and returned nothing. Only here is
            *             "Menu coming soon!" a true statement.
            */}
          {bodyState === 'items' ? (
            <div className="space-y-8">
              {filteredGroupedEntries.map(({ subcategory, items }) => (
                <div key={String(subcategory.id)} className="space-y-3">
                  <h3 className="text-sm font-semibold uppercase tracking-wide text-gray-500">
                    {subcategorySectionTitle(subcategory)}
                  </h3>
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    {items.map((item) => renderMenuItemCard(item))}
                  </div>
                </div>
              ))}
            </div>
          ) : bodyState === 'loading' ? (
            /* The page's own loading treatment, reused. It says nothing, which is the point. */
            <div
              data-testid="menu-body-loading"
              className="flex items-center justify-center rounded-2xl border border-gray-100 bg-white py-16"
            >
              <div className="w-10 h-10 border-2 border-border border-t-foreground animate-spin" />
            </div>
          ) : bodyState === 'failed' && menuNotice ? (
            <div className="rounded-2xl border border-gray-200 bg-white py-16 text-center">
              <div className="mx-auto max-w-md px-6">
                <AlertTriangle
                  className="mx-auto mb-5 h-10 w-10 text-amber-500"
                  strokeWidth={1.5}
                  aria-hidden
                />
                <h3 className="mb-2 text-xl font-bold text-black">{menuNotice.title}</h3>
                <p className="mb-6 text-gray-500">{menuNotice.description}</p>
                <Button onClick={retryMenuLoad} style={{ backgroundColor: ACCENT }}>
                  {menuNotice.retryLabel}
                </Button>
              </div>
            </div>
          ) : (
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
          // Whatever the customer already tapped on the card carries into the popup, so opening
          // it never quietly resets a choice that is still visible behind it.
          initialVariantSelection={getResolvedVariantSelection(selectedItem)}
          restaurant={restaurant ? { ...restaurant, currency } : { currency }}
          onClose={() => setSelectedItem(null)}
          onAddToCart={(cartItem) => {
            if (!effectiveIsInTab && !isKiosk) return
            /**
             * PICKER MODE. Ruled 2026-08-16: "+ Add something" inside the editor opens the menu
             * and returns to the PENDING edit, not to the cart. Nothing commits until Save.
             *
             * So in picker mode the item does NOT enter the cart -- putting it there would let a
             * customer Place Order on something they meant to add to an existing order, which is
             * two kitchen tickets for one intention and exactly what the ruling avoids.
             */
            if (pickForOrderId) {
              appendPendingAddition(pickForOrderId, toPendingAddition(cartItem as never))
              setSelectedItem(null)
              // BACK TO THE EDITOR, which lives on the per-order screen -- not to My Orders.
              // The panel reopens itself because a pending addition exists for this order.
              router.replace(
                `/menu/${restaurantId}/order-confirmation/${pickForOrderId}${
                  tableNumber > 0 ? `?table=${tableNumber}` : ''
                }`,
              )
              return
            }
            addItem(cartItem)
            pushCartToast(cartItem.display_name || cartItem.name)
            setSelectedItem(null)
          }}
        />
      )}

      {/* "Create a tab to start ordering" -- suppressed entirely for a view-only menu:
          there is no path to ordering here at all, not just a currently-unstarted one. */}
      {!effectiveIsInTab && !isKiosk && !isViewOnly && (
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
