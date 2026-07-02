// @ts-nocheck
'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useRef } from 'react'
import { useAuth } from '@/components/auth/auth-provider'
import { 
  getMenuCategories, 
  createMenuCategory, 
  updateMenuCategory,
  deleteMenuCategoryCascade,
  MenuCategory 
} from '@/lib/supabase/menu'
import { 
  getSubCategories, 
  createSubCategory, 
  updateSubCategory,
  deleteSubCategoryCascade,
  SubCategory 
} from '@/lib/supabase/menu'
import { 
  getMenuItems,
  deleteMenuItem,
  normalizeMenuItemForClient,
  normalizeSubCategoryForClient,
  MenuItem 
} from '@/lib/supabase/menu'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { ArrowLeft, Plus, Search, Edit, Trash2, X, ChevronRight, Loader2, Pencil } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { useToast } from '@/hooks/use-toast'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Skeleton } from '@/components/ui/skeleton'
import { FoodItemImage } from '@/components/menu/food-item-image'
import { MenuItemFormModal } from '@/components/menu/menu-item-form-modal'
import { InventorySetupBanner } from '@/components/menu/inventory-setup-ui'
import { MenuItemInventoryBadge } from '@/components/menu/menu-item-inventory-badge'
import { loadInventorySetupAction } from '@/lib/recipes/actions'
import type { InventorySetupData } from '@/lib/recipes/queries'

const MENU_MGMT_CACHE_PREFIX = 'menu_mgmt_cache_v1'
const MENU_MGMT_CACHE_TTL_MS = 2 * 60 * 1000
const INITIAL_VISIBLE_ITEMS_PER_SUBCATEGORY = 24

type MenuManagementCachePayload = {
  menuCategories: MenuCategory[]
  allSubCategories: SubCategory[]
  allMenuItems: MenuItem[]
  selectedMenuCategoryId: string | null
  timestamp: number
}

export function MenuManagementV2({
  initialInventorySetup = null,
  missingInventoryFilter = false,
}: {
  initialInventorySetup?: InventorySetupData | null
  missingInventoryFilter?: boolean
}) {
  const { user, restaurantId } = useAuth()
  const router = useRouter()
  const { toast } = useToast()
  const [inventorySetup, setInventorySetup] = useState<InventorySetupData | null>(
    initialInventorySetup,
  )
  
  // Data state
  const [menuCategories, setMenuCategories] = useState<MenuCategory[]>([])
  const [allSubCategories, setAllSubCategories] = useState<SubCategory[]>([])
  const [allMenuItems, setAllMenuItems] = useState<MenuItem[]>([])
  
  // View state
  const [selectedMenuCategory, setSelectedMenuCategory] = useState<MenuCategory | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [visibleItemsBySubcategory, setVisibleItemsBySubcategory] = useState<Record<string, number>>({})
  const [showHidden, setShowHidden] = useState(false)
  const [loading, setLoading] = useState(true)
  
  // Modal state
  const [showMenuCategoryModal, setShowMenuCategoryModal] = useState(false)
  const [showSubCategoryModal, setShowSubCategoryModal] = useState(false)
  const [showItemModal, setShowItemModal] = useState(false)
  const [defaultSubCategoryId, setDefaultSubCategoryId] = useState('')
  const [showEditMenuCategoryModal, setShowEditMenuCategoryModal] = useState(false)
  const [showEditSubCategoryModal, setShowEditSubCategoryModal] = useState(false)
  const [editingItem, setEditingItem] = useState<MenuItem | null>(null)
  const [editingMenuCategory, setEditingMenuCategory] = useState<MenuCategory | null>(null)
  const [editingSubCategory, setEditingSubCategory] = useState<SubCategory | null>(null)
  
  // Form state
  const [menuCategoryForm, setMenuCategoryForm] = useState({ name: '', description: '', route_to: 'kitchen' as 'kitchen' | 'bar' | 'both' })
  const [subCategoryForm, setSubCategoryForm] = useState({ name: '', description: '' })
  const [editMenuCategoryForm, setEditMenuCategoryForm] = useState({ name: '', description: '', display_order: '', route_to: 'kitchen' as 'kitchen' | 'bar' | 'both' })
  const [editSubCategoryForm, setEditSubCategoryForm] = useState({ name: '', description: '', display_order: '' })
  const lastMenuInvalidateAtRef = useRef(0)
  const menuInvalidateInFlightRef = useRef(false)
  const loadInFlightRef = useRef(false)
  const loadedRestaurantRef = useRef<string | null>(null)

  const cacheKey = useMemo(
    () => (restaurantId ? `${MENU_MGMT_CACHE_PREFIX}:${restaurantId}` : null),
    [restaurantId]
  )

  const invalidateServerMenuCache = useCallback(async () => {
    if (!restaurantId) return
    const now = Date.now()
    if (menuInvalidateInFlightRef.current || now - lastMenuInvalidateAtRef.current < 1500) {
      return
    }

    menuInvalidateInFlightRef.current = true
    try {
      await fetch('/api/cache/menu/invalidate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ restaurantId }),
      })
      lastMenuInvalidateAtRef.current = Date.now()
    } catch (error) {
      console.error('[MENU] Failed to invalidate server cache:', error)
    } finally {
      menuInvalidateInFlightRef.current = false
    }
  }, [restaurantId])

  const readCache = useCallback((): MenuManagementCachePayload | null => {
    if (!cacheKey || typeof window === 'undefined') return null

    try {
      const cachedRaw = sessionStorage.getItem(cacheKey)
      if (!cachedRaw) return null
      const parsed = JSON.parse(cachedRaw) as MenuManagementCachePayload

      if (Date.now() - parsed.timestamp > MENU_MGMT_CACHE_TTL_MS) {
        sessionStorage.removeItem(cacheKey)
        return null
      }

      return parsed
    } catch {
      return null
    }
  }, [cacheKey])

  const writeCache = useCallback(
    (payload: Omit<MenuManagementCachePayload, 'timestamp'>) => {
      if (!cacheKey || typeof window === 'undefined') return

      try {
        sessionStorage.setItem(
          cacheKey,
          JSON.stringify({
            ...payload,
            timestamp: Date.now(),
          } satisfies MenuManagementCachePayload)
        )
      } catch {
        // Ignore quota/storage errors.
      }
    },
    [cacheKey]
  )

  // Load all data - Pre-fetch using localStorage restaurantId for faster loading
  const cachedRestaurantId =
    typeof window !== 'undefined' ? localStorage.getItem('restaurantId') : null
  const effectiveRestaurantId = restaurantId || cachedRestaurantId
  const canLoadMenuData = Boolean(user || cachedRestaurantId) && Boolean(effectiveRestaurantId)
  const showMenuLoading = canLoadMenuData && loading

  useEffect(() => {
    if (!canLoadMenuData) return
    if (!effectiveRestaurantId) return

    if (loadInFlightRef.current) return
    if (loadedRestaurantRef.current === effectiveRestaurantId) return

    const loadAllData = async () => {
      loadInFlightRef.current = true
      try {
        const cached = readCache()
        if (cached) {
          setMenuCategories(cached.menuCategories)
          setAllSubCategories(cached.allSubCategories.map(normalizeSubCategoryForClient))
          setAllMenuItems(cached.allMenuItems.map(normalizeMenuItemForClient))
          setSelectedMenuCategory(
            cached.selectedMenuCategoryId
              ? cached.menuCategories.find((category) => category.id === cached.selectedMenuCategoryId) || null
              : null
          )
          setLoading(false)
        } else {
          setLoading(true)
        }

        // Fetch categories and items in parallel.
        const [categoriesRaw, itemsResultRaw] = await Promise.all([
          getMenuCategories(effectiveRestaurantId),
          getMenuItems(effectiveRestaurantId).catch((err: any) => {
            console.warn('Could not load menu items (index may be missing):', err?.message || err)
            return [] as MenuItem[]
          }),
        ])
        const categories = (categoriesRaw || []) as any[]
        const itemsResult = (itemsResultRaw || []) as any[]

        // Fetch sub-categories in parallel per category.
        const subCategoryResults = await Promise.allSettled(
          (categories as any[]).map(async (category: any) => {
            try {
              const subcats = await getSubCategories(effectiveRestaurantId, category.id)
              return subcats
            } catch (err) {
              console.warn(`Failed to load sub-categories for ${category.name}:`, err)
              return [] as SubCategory[]
            }
          })
        )

        const allSubcats: SubCategory[] = subCategoryResults.flatMap((result) =>
          result.status === 'fulfilled' ? result.value : []
        )

        setMenuCategories(categories)
        setAllMenuItems(itemsResult)
        setAllSubCategories(allSubcats)

        setSelectedMenuCategory((current) => {
          if (!categories.length) return null
          if (current && categories.some((category) => category.id === current.id)) return current
          return categories[0]
        })

        writeCache({
          menuCategories: categories,
          allSubCategories: allSubcats,
          allMenuItems: itemsResult,
          selectedMenuCategoryId: selectedMenuCategory?.id || (categories[0]?.id ?? null),
        })
      } catch (err: any) {
        console.error('Error loading data:', err)
      } finally {
        loadedRestaurantRef.current = effectiveRestaurantId
        loadInFlightRef.current = false
        setLoading(false)
      }
    }

    loadAllData()
    // selectedMenuCategory is updated inside loadAllData; including it would reset category selection on each load.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- restaurant/user identity only
  }, [canLoadMenuData, effectiveRestaurantId, readCache, writeCache])

  const searchableQuery = useMemo(() => searchQuery.trim().toLowerCase(), [searchQuery])

  const missingMenuItemIds = useMemo(
    () => new Set(inventorySetup?.missingItems.map((item) => item.menuItemId) ?? []),
    [inventorySetup],
  )

  const refreshInventorySetup = useCallback(async () => {
    const result = await loadInventorySetupAction()
    if (result.data) {
      setInventorySetup(result.data)
    }
  }, [])

  const visibleMenuItems = useMemo(() => {
    let items = showHidden ? allMenuItems : allMenuItems.filter((item) => item.status !== 'hidden')
    if (missingInventoryFilter) {
      items = items.filter((item) => missingMenuItemIds.has(item.id))
    }
    return items
  }, [allMenuItems, showHidden, missingInventoryFilter, missingMenuItemIds])

  const subCategoriesByMenuCategory = useMemo(() => {
    const map: Record<string, SubCategory[]> = {}
    for (const subCategory of allSubCategories) {
      if (!map[subCategory.menu_category_id]) {
        map[subCategory.menu_category_id] = []
      }
      map[subCategory.menu_category_id].push(subCategory)
    }
    return map
  }, [allSubCategories])

  const categoryItemCountMap = useMemo(() => {
    const counts: Record<string, number> = {}
    for (const item of visibleMenuItems) {
      counts[item.menu_category_id] = (counts[item.menu_category_id] || 0) + 1
    }
    return counts
  }, [visibleMenuItems])

  const itemsByCategory = useMemo(() => {
    const map: Record<string, MenuItem[]> = {}
    for (const item of visibleMenuItems) {
      if (!map[item.menu_category_id]) {
        map[item.menu_category_id] = []
      }
      map[item.menu_category_id].push(item)
    }
    for (const key of Object.keys(map)) {
      map[key].sort((a, b) => a.name.localeCompare(b.name))
    }
    return map
  }, [visibleMenuItems])

  const groupedData = useMemo(() => {
    if (!selectedMenuCategory) return {}
    const categoryItems = itemsByCategory[selectedMenuCategory.id] || []
    const realSubcategories = subCategoriesByMenuCategory[selectedMenuCategory.id] || []

    if (realSubcategories.length > 0) {
      const result: Record<string, { subcategory: SubCategory; items: MenuItem[] }> = {}

      for (const subcategory of realSubcategories) {
        const items = categoryItems.filter((item) => item.sub_category_id === subcategory.id)
        result[subcategory.id] = { subcategory, items }
      }

      const otherItems = categoryItems.filter(
        (item) =>
          !item.sub_category_id ||
          !realSubcategories.some((subcategory) => subcategory.id === item.sub_category_id)
      )
      if (otherItems.length > 0) {
        result.__other__ = {
          subcategory: {
            id: '__other__',
            menu_category_id: selectedMenuCategory.id,
            name: 'Other',
            description: '',
            display_order: 9999,
          } as SubCategory,
          items: otherItems,
        }
      }

      return result
    }

    return {
      [selectedMenuCategory.id]: {
        subcategory: {
          id: selectedMenuCategory.id,
          menu_category_id: selectedMenuCategory.id,
          name: selectedMenuCategory.name || 'Items',
          description: '',
          display_order: 0,
        } as SubCategory,
        items: categoryItems,
      },
    }
  }, [itemsByCategory, selectedMenuCategory, subCategoriesByMenuCategory])

  const hasRealSubcategories = useMemo(() => {
    if (!selectedMenuCategory) return false
    return (subCategoriesByMenuCategory[selectedMenuCategory.id] || []).length > 0
  }, [selectedMenuCategory, subCategoriesByMenuCategory])

  const allSubCategoryOptions = useMemo(() => {
    const categoryNameById = Object.fromEntries(
      menuCategories.map((menuCategory) => [menuCategory.id, menuCategory.name])
    )

    return allSubCategories
      .map((subCategory) => ({
        id: subCategory.id,
        name: subCategory.name,
        menuCategoryName: categoryNameById[subCategory.menu_category_id] || 'Uncategorized',
      }))
      .sort((a, b) => {
        const categoryCompare = a.menuCategoryName.localeCompare(b.menuCategoryName)
        if (categoryCompare !== 0) return categoryCompare
        return a.name.localeCompare(b.name)
      })
  }, [allSubCategories, menuCategories])

  useEffect(() => {
    if (showMenuLoading) return

    writeCache({
      menuCategories,
      allSubCategories,
      allMenuItems,
      selectedMenuCategoryId: selectedMenuCategory?.id || null,
    })
  }, [allMenuItems, allSubCategories, loading, menuCategories, selectedMenuCategory?.id, writeCache, showMenuLoading])

  // Navigation handlers
  const handleSelectMenuCategory = (category: MenuCategory | null) => {
    setSelectedMenuCategory(category)
    setSearchQuery('')
    setVisibleItemsBySubcategory({})
  }

  // Handle add item for specific sub-category
  const handleAddItemForSubCategory = (subCategory: SubCategory) => {
    setDefaultSubCategoryId(subCategory.id)
    setEditingItem(null)
    setShowItemModal(true)
  }

  const getVisibleLimit = useCallback(
    (subCategoryId: string) => visibleItemsBySubcategory[subCategoryId] ?? INITIAL_VISIBLE_ITEMS_PER_SUBCATEGORY,
    [visibleItemsBySubcategory]
  )

  const handleLoadMoreItems = useCallback((subCategoryId: string) => {
    setVisibleItemsBySubcategory((prev) => ({
      ...prev,
      [subCategoryId]: (prev[subCategoryId] ?? INITIAL_VISIBLE_ITEMS_PER_SUBCATEGORY) + INITIAL_VISIBLE_ITEMS_PER_SUBCATEGORY,
    }))
  }, [])

  // Menu Category handlers
  const handleCreateMenuCategory = async () => {
    if (!restaurantId) return

    const name = menuCategoryForm.name.trim()
    if (!name) {
      toast({
        title: 'Validation Error',
        description: 'Category name is required',
        variant: 'destructive',
      })
      return
    }

    try {
      await createMenuCategory(
        restaurantId,
        name,
        menuCategoryForm.description || undefined,
        menuCategoryForm.route_to
      )
      toast({
        title: 'Success',
        description: `Category "${name}" created successfully`,
      })
      setMenuCategoryForm({ name: '', description: '', route_to: 'kitchen' })
      setShowMenuCategoryModal(false)
      
      // Reload categories
      const categories = ((await getMenuCategories(restaurantId)) || []) as any[]
      setMenuCategories(categories)
      await invalidateServerMenuCache()
    } catch (err: any) {
      toast({
        title: 'Error',
        description: err.message || 'Failed to create category',
        variant: 'destructive',
      })
    }
  }

  const handleDeleteMenuCategory = async (category: MenuCategory) => {
    if (!restaurantId) return
    if (
      !confirm('Are you sure you want to delete this? All items inside will also be deleted.')
    ) {
      return
    }

    try {
      await deleteMenuCategoryCascade(restaurantId, category.id)
      toast({
        title: 'Success',
        description: `Category "${category.name}" and nested data deleted successfully`,
      })
      
      const [categoriesRaw, itemsRaw] = await Promise.all([
        getMenuCategories(restaurantId),
        getMenuItems(restaurantId),
      ])
      const categories = (categoriesRaw || []) as any[]
      const items = (itemsRaw || []) as any[]
      setMenuCategories(categories)
      setAllMenuItems(items)
      const subCategoryResults = await Promise.all(
        (categories as any[]).map((cat: any) => getSubCategories(restaurantId, cat.id).catch(() => [] as SubCategory[]))
      )
      setAllSubCategories(subCategoryResults.flat())
      
      // Reset selection if deleted category was selected
      if (selectedMenuCategory?.id === category.id) {
        setSelectedMenuCategory(categories.length > 0 ? categories[0] : null)
      }
      await invalidateServerMenuCache()
    } catch (err: any) {
      console.error('[menu-delete][category] failed', { categoryId: category.id, error: err?.message || err })
      toast({
        title: 'Error',
        description: err.message || 'Failed to delete category',
        variant: 'destructive',
      })
    }
  }

  const handleOpenEditMenuCategory = (category: MenuCategory) => {
    setEditingMenuCategory(category)
    setEditMenuCategoryForm({
      name: category.name || '',
      description: category.description || '',
      display_order: String(category.display_order ?? ''),
      route_to: (category.route_to || 'kitchen') as 'kitchen' | 'bar' | 'both',
    })
    setShowEditMenuCategoryModal(true)
  }

  const handleSaveMenuCategoryEdit = async () => {
    if (!restaurantId || !editingMenuCategory) return

    const nextName = editMenuCategoryForm.name.trim()
    const nextDisplayOrder = Number(editMenuCategoryForm.display_order)

    if (!nextName) {
      toast({
        title: 'Validation Error',
        description: 'Category name is required',
        variant: 'destructive',
      })
      return
    }

    if (isNaN(nextDisplayOrder) || nextDisplayOrder < 0) {
      toast({
        title: 'Validation Error',
        description: 'Display order must be a valid non-negative number',
        variant: 'destructive',
      })
      return
    }

    try {
      await updateMenuCategory(restaurantId, editingMenuCategory.id, {
        name: nextName,
        description: editMenuCategoryForm.description.trim() || null,
        display_order: nextDisplayOrder,
        route_to: editMenuCategoryForm.route_to,
      } as Partial<MenuCategory>)

      const categories = ((await getMenuCategories(restaurantId)) || []) as any[]
      setMenuCategories(categories)
      setSelectedMenuCategory((current) =>
        current?.id === editingMenuCategory.id
          ? (categories as any[]).find((category: any) => category.id === editingMenuCategory.id) || current
          : current
      )

      toast({
        title: 'Success',
        description: `Category "${nextName}" updated`,
      })

      setShowEditMenuCategoryModal(false)
      setEditingMenuCategory(null)
      await invalidateServerMenuCache()
    } catch (err: any) {
      toast({
        title: 'Error',
        description: err.message || 'Failed to update category',
        variant: 'destructive',
      })
    }
  }

  // Sub-Category handlers
  const handleCreateSubCategory = async () => {
    if (!restaurantId || !selectedMenuCategory) return

    const name = subCategoryForm.name.trim()
    if (!name) {
      toast({
        title: 'Validation Error',
        description: 'Sub-category name is required',
        variant: 'destructive',
      })
      return
    }

    try {
      await createSubCategory(
        restaurantId,
        selectedMenuCategory.id,
        name,
        subCategoryForm.description || undefined
      )
      toast({
        title: 'Success',
        description: `Sub-category "${name}" created successfully`,
      })
      setSubCategoryForm({ name: '', description: '' })
      setShowSubCategoryModal(false)
      
      // Reload all items and sub-categories
      const [items, subcats] = await Promise.all([
        getMenuItems(restaurantId),
        getSubCategories(restaurantId, selectedMenuCategory.id)
      ])
      setAllMenuItems(items)
      
      // Update all sub-categories list
      const updatedAllSubcats = allSubCategories.filter(sc => sc.menu_category_id !== selectedMenuCategory.id)
      updatedAllSubcats.push(...subcats)
      setAllSubCategories(updatedAllSubcats)
      await invalidateServerMenuCache()
    } catch (err: any) {
      toast({
        title: 'Error',
        description: err.message || 'Failed to create sub-category',
        variant: 'destructive',
      })
    }
  }

  const handleDeleteSubCategory = async (subCategory: SubCategory) => {
    if (!restaurantId) return
    if (
      !confirm('Are you sure you want to delete this? All items inside will also be deleted.')
    ) {
      return
    }

    try {
      if (!subCategory.menu_category_id) {
        throw new Error('Sub-category is missing menu_category_id')
      }
      await deleteSubCategoryCascade(restaurantId, subCategory.menu_category_id, subCategory.id)
      toast({
        title: 'Success',
        description: `Sub-category "${subCategory.name}" and its items deleted successfully`,
      })
      
      // Reload sub-categories
      if (selectedMenuCategory) {
        const [items, subcats] = await Promise.all([
          getMenuItems(restaurantId),
          getSubCategories(restaurantId, selectedMenuCategory.id),
        ])
        setAllMenuItems(items)
        const updatedAllSubcats = allSubCategories.filter(
          (sc) => sc.menu_category_id !== selectedMenuCategory.id
        )
        updatedAllSubcats.push(...subcats)
        setAllSubCategories(updatedAllSubcats)
      }
      await invalidateServerMenuCache()
    } catch (err: any) {
      console.error('[menu-delete][subcategory] failed', { subCategoryId: subCategory.id, error: err?.message || err })
      toast({
        title: 'Error',
        description: err.message || 'Failed to delete sub-category',
        variant: 'destructive',
      })
    }
  }

  const handleOpenEditSubCategory = (subCategory: SubCategory) => {
    setEditingSubCategory(subCategory)
    setEditSubCategoryForm({
      name: subCategory.name || '',
      description: subCategory.description || '',
      display_order: String(subCategory.display_order ?? ''),
    })
    setShowEditSubCategoryModal(true)
  }

  const handleSaveSubCategoryEdit = async () => {
    if (!restaurantId || !editingSubCategory || !editingSubCategory.menu_category_id) return

    const nextName = editSubCategoryForm.name.trim()
    const nextDisplayOrder = Number(editSubCategoryForm.display_order)

    if (!nextName) {
      toast({
        title: 'Validation Error',
        description: 'Sub-category name is required',
        variant: 'destructive',
      })
      return
    }

    if (isNaN(nextDisplayOrder) || nextDisplayOrder < 0) {
      toast({
        title: 'Validation Error',
        description: 'Display order must be a valid non-negative number',
        variant: 'destructive',
      })
      return
    }

    try {
      await updateSubCategory(
        restaurantId,
        editingSubCategory.menu_category_id,
        editingSubCategory.id,
        {
          name: nextName,
          description: editSubCategoryForm.description.trim() || null,
          display_order: nextDisplayOrder,
        } as Partial<SubCategory>
      )

      const subcats = await getSubCategories(restaurantId, editingSubCategory.menu_category_id)
      const updatedAllSubcats = allSubCategories.filter(
        (sc) => sc.menu_category_id !== editingSubCategory.menu_category_id
      )
      updatedAllSubcats.push(...subcats)
      setAllSubCategories(updatedAllSubcats)

      toast({
        title: 'Success',
        description: `Sub-category "${nextName}" updated`,
      })

      setShowEditSubCategoryModal(false)
      setEditingSubCategory(null)
      await invalidateServerMenuCache()
    } catch (err: any) {
      toast({
        title: 'Error',
        description: err.message || 'Failed to update sub-category',
        variant: 'destructive',
      })
    }
  }

  // Menu Item handlers
  const handleAddItem = () => {
    if (!selectedMenuCategory) {
      toast({
        title: 'Error',
        description: 'Please select a category first',
        variant: 'destructive',
      })
      return
    }
    const firstCategorySub = (subCategoriesByMenuCategory[selectedMenuCategory.id] || [])[0]
    setDefaultSubCategoryId(firstCategorySub?.id || '')
    setEditingItem(null)
    setShowItemModal(true)
  }

  const handleEditItem = (item: MenuItem) => {
    setEditingItem(item)
    setDefaultSubCategoryId('')
    setShowItemModal(true)
  }

  const handleItemSaved = async () => {
    if (!restaurantId) return
    const items = await getMenuItems(restaurantId)
    setAllMenuItems(items)
    await invalidateServerMenuCache()
    await refreshInventorySetup()
  }

  const handleDeleteItem = async (item: MenuItem) => {
    if (!confirm(`Delete "${item.name}"? This cannot be undone.`)) return

    try {
      if (!item.menu_category_id) {
        throw new Error('Menu item missing category information')
      }

      await deleteMenuItem(
        restaurantId!,
        item.menu_category_id,
        item.sub_category_id || '',
        item.id
      )
      setAllMenuItems((prev) => prev.filter((row) => row.id !== item.id))
      toast({
        title: 'Success',
        description: 'Menu item deleted successfully',
      })

      const items = await getMenuItems(restaurantId!)
      setAllMenuItems(items)
      await invalidateServerMenuCache()
    } catch (err: any) {
      toast({
        title: 'Error',
        description: err.message || 'Failed to delete menu item',
        variant: 'destructive',
      })
    }
  }

  // Skeleton loading UI
  if (showMenuLoading) {
    return (
      <div className="min-h-screen bg-muted/30">
        {/* Header Skeleton */}
        <header className="bg-card border-b border-border">
          <div className="container mx-auto px-4 sm:px-6 py-4 sm:py-6">
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
              <div className="flex items-center gap-2 sm:gap-4">
                <Skeleton className="h-10 w-10" />
                <Skeleton className="h-8 w-48" />
              </div>
              <div className="flex gap-2">
                <Skeleton className="h-10 w-32" />
                <Skeleton className="h-10 w-36" />
              </div>
            </div>
          </div>
        </header>

        <div className="container mx-auto px-4 sm:px-6 py-4 sm:py-6">
          {/* Category Tabs Skeleton */}
          <div className="flex gap-2 mb-6 overflow-x-auto pb-2">
            {[1, 2, 3, 4].map((i) => (
              <Skeleton key={i} className="h-10 w-24" />
            ))}
          </div>

          {/* Search Bar Skeleton */}
          <div className="mb-6">
            <Skeleton className="h-10 w-full" />
          </div>

          {/* Menu Items Grid Skeleton */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3 sm:gap-4">
            {[1, 2, 3, 4, 5, 6, 7, 8].map((i) => (
              <div key={i} className="bg-card border rounded-lg overflow-hidden">
                <Skeleton className="w-full h-32" />
                <div className="p-3 space-y-2">
                  <Skeleton className="h-5 w-3/4" />
                  <Skeleton className="h-4 w-full" />
                  <Skeleton className="h-4 w-2/3" />
                  <Skeleton className="h-6 w-20 mt-2" />
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-muted/30">
      {/* Header */}
      <header className="bg-card border-b border-border">
        <div className="container mx-auto px-4 sm:px-6 py-4 sm:py-6">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
            <div className="flex items-center gap-2 sm:gap-4">
              <Button variant="ghost" size="icon" onClick={() => router.push('/dashboard')} className="h-11 w-11 sm:h-10 sm:w-10">
                <ArrowLeft className="h-5 w-5" />
              </Button>
              <h1 className="text-2xl sm:text-3xl font-bold">Menu Management</h1>
            </div>
            <div className="flex flex-col sm:flex-row gap-2 w-full sm:w-auto">
              <Button 
                onClick={() => setShowMenuCategoryModal(true)}
                className="bg-[#FF6B35] hover:bg-[#e55a28] w-full sm:w-auto h-11 sm:h-10 text-sm sm:text-base px-4 sm:px-6"
              >
                <Plus className="h-4 w-4 mr-2" />
                Add Category
              </Button>
              {selectedMenuCategory && (
                <Button 
                  onClick={() => setShowSubCategoryModal(true)}
                  className="bg-[#FF6B35] hover:bg-[#e55a28] w-full sm:w-auto h-11 sm:h-10 text-sm sm:text-base px-4 sm:px-6"
                >
                  <Plus className="h-4 w-4 mr-2" />
                  Add Sub-category
                </Button>
              )}
            </div>
          </div>
        </div>
      </header>

      <div className="container mx-auto px-4 sm:px-6 py-4 sm:py-6">
        {inventorySetup ? (
          <InventorySetupBanner setup={inventorySetup} filterActive={missingInventoryFilter} />
        ) : null}
        {/* Category Tabs */}
        <div
          className="flex overflow-x-auto gap-2 pb-2 categories-scroll mb-4 sm:mb-6 -mx-4 sm:mx-0 px-4 sm:px-0"
          style={{
            scrollbarWidth: 'none',
            msOverflowStyle: 'none',
            WebkitOverflowScrolling: 'touch',
          }}
        >
          <Button
            variant={selectedMenuCategory === null ? 'default' : 'outline'}
            onClick={() => handleSelectMenuCategory(null)}
            className={`shrink-0 ${selectedMenuCategory === null ? 'bg-[#FF6B35] hover:bg-[#e55a28]' : ''} h-11 sm:h-10 text-sm sm:text-base whitespace-nowrap min-w-[100px] sm:min-w-0`}
          >
            All Items ({visibleMenuItems.length})
          </Button>
          {menuCategories.map((category) => (
            <div key={category.id} className="flex shrink-0 items-center gap-1 group">
              <Button
                variant={selectedMenuCategory?.id === category.id ? 'default' : 'outline'}
                onClick={() => handleSelectMenuCategory(category)}
                className={`${selectedMenuCategory?.id === category.id ? 'bg-[#FF6B35] hover:bg-[#e55a28]' : ''} h-11 sm:h-10 text-sm sm:text-base whitespace-nowrap`}
              >
                {category.name} ({categoryItemCountMap[category.id] || 0})
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={(e) => {
                  e.stopPropagation()
                  handleOpenEditMenuCategory(category)
                }}
                className="h-11 w-11 sm:h-8 sm:w-8 shrink-0 p-0 text-blue-600 hover:text-blue-700 hover:bg-blue-50 opacity-100 sm:opacity-0 sm:group-hover:opacity-100"
                title={`Edit ${category.name}`}
              >
                <Pencil className="h-4 w-4" />
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={(e) => {
                  e.stopPropagation()
                  handleDeleteMenuCategory(category)
                }}
                className="h-11 w-11 sm:h-8 sm:w-8 shrink-0 p-0 text-red-500 hover:text-red-700 hover:bg-red-50 opacity-100 sm:opacity-0 sm:group-hover:opacity-100"
              >
                <X className="h-4 w-4" />
              </Button>
            </div>
          ))}
        </div>

        {/* Search Bar */}
        <div className="mb-4 sm:mb-6 flex flex-col sm:flex-row gap-3 sm:items-center">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-muted-foreground" />
            <Input
              placeholder="Search menu items..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-10 h-11 sm:h-10 text-base sm:text-sm"
            />
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setShowHidden((prev) => !prev)}
            className="h-11 sm:h-9 shrink-0"
          >
            {showHidden ? 'Hide hidden items' : 'Show hidden items'}
          </Button>
        </div>

        {/* Show All Items View */}
        {selectedMenuCategory === null && (
          <div className="space-y-8">
            {menuCategories.map((category) => {
              const categoryItems = (itemsByCategory[category.id] || []).filter((item) =>
                !searchableQuery ||
                item.name.toLowerCase().includes(searchableQuery) ||
                item.description?.toLowerCase().includes(searchableQuery)
              )

              if (categoryItems.length === 0 && searchableQuery) return null
              
              return (
                <div key={category.id} className="space-y-6">
                  <h2 className="text-xl sm:text-2xl font-bold">{category.name}</h2>
                  <div className="space-y-4">
                    <div className="flex justify-end">
                      <Button
                        onClick={() => {
                          setSelectedMenuCategory(category)
                          setDefaultSubCategoryId('')
                          setEditingItem(null)
                          setShowItemModal(true)
                        }}
                        className="bg-[#FF6B35] hover:bg-[#e55a28] h-11 sm:h-9 text-sm sm:text-sm"
                        size="sm"
                      >
                        <Plus className="h-4 w-4 mr-2" />
                        Add Item
                      </Button>
                    </div>
                    {categoryItems.length > 0 ? (
                      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3 sm:gap-4">
                        {categoryItems.slice(0, getVisibleLimit(category.id)).map((item) => (
                            <div
                              key={item.id}
                              className="bg-card border rounded-lg overflow-hidden hover:shadow-md transition-shadow"
                            >
                              <div className="relative w-full h-32 bg-gray-50 overflow-hidden">
                                <FoodItemImage
                                  itemName={item.name}
                                  menuItemId={item.id}
                                  storedImageUrl={item.image_url}
                                  alt={item.name}
                                  className="w-full h-full object-cover rounded-t-lg"
                                  style={{
                                    objectFit: item.imageFit || 'cover',
                                    objectPosition: item.imagePosition || 'center',
                                  }}
                                />
                              </div>
                              <div className="p-3">
                                <div className="flex items-start justify-between mb-1 gap-2">
                                  <h4 className="font-semibold text-sm sm:text-sm line-clamp-1 flex-1">{item.name}</h4>
                                  <div className="flex gap-1 flex-shrink-0">
                                    <Button
                                      variant="ghost"
                                      size="icon"
                                      className="h-8 w-8 sm:h-6 sm:w-6"
                                      onClick={() => handleEditItem(item)}
                                    >
                                      <Edit className="h-4 w-4 sm:h-3 sm:w-3" />
                                    </Button>
                                    <Button
                                      variant="ghost"
                                      size="icon"
                                      className="h-8 w-8 sm:h-6 sm:w-6 text-red-500 hover:text-red-700"
                                      onClick={() => handleDeleteItem(item)}
                                    >
                                      <Trash2 className="h-4 w-4 sm:h-3 sm:w-3" />
                                    </Button>
                                  </div>
                                </div>
                                <p className="text-xs text-muted-foreground mb-2 line-clamp-1">
                                  {item.description}
                                </p>
                                <div className="mb-2">
                                  <MenuItemInventoryBadge item={item} setup={inventorySetup} />
                                </div>
                                <div className="flex items-center justify-between">
                                  <span className="text-sm font-bold text-[#FF6B35]">
                                    N${item.base_price.toFixed(2)}
                                  </span>
                                  <span className={`text-xs px-1.5 py-0.5 rounded ${
                                    item.status === 'hidden'
                                      ? 'bg-gray-200 text-gray-600'
                                      : item.status === 'available'
                                        ? 'bg-green-100 text-green-800'
                                        : 'bg-yellow-100 text-yellow-800'
                                  }`}>
                                    {item.status === 'hidden'
                                      ? 'Hidden'
                                      : item.status === 'available'
                                        ? '✓'
                                        : '⚠'}
                                  </span>
                                </div>
                              </div>
                            </div>
                        ))}
                      </div>
                    ) : (
                      <p className="text-sm text-muted-foreground italic">No items in this category</p>
                    )}
                    {categoryItems.length > getVisibleLimit(category.id) && (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => handleLoadMoreItems(category.id)}
                          className="h-9 text-sm"
                        >
                          Load More ({categoryItems.length - getVisibleLimit(category.id)} remaining)
                        </Button>
                    )}
                  </div>
                </div>
              )
            })}
            {menuCategories.length === 0 && (
              <div className="text-center py-8 sm:py-12 bg-card border rounded-lg px-4 sm:px-6">
                <div className="max-w-md mx-auto">
                  <div className="text-5xl sm:text-6xl mb-3 sm:mb-4">📋</div>
                  <h3 className="text-lg sm:text-xl font-semibold mb-2">No menu categories yet</h3>
                  <p className="text-sm sm:text-base text-muted-foreground mb-4 sm:mb-6">
                    Create your first menu category to get started
                  </p>
                  <Button 
                    onClick={() => setShowMenuCategoryModal(true)}
                    className="bg-[#FF6B35] hover:bg-[#e55a28] w-full sm:w-auto h-11 sm:h-10 text-sm sm:text-base px-6"
                  >
                    <Plus className="h-4 w-4 mr-2" />
                    Create First Category
                  </Button>
                </div>
              </div>
            )}
          </div>
        )}

        {/* Show Selected Category View */}
        {selectedMenuCategory && (
          <div className="space-y-8">
            {hasRealSubcategories ? (
              <h3 className="text-lg sm:text-xl font-semibold">{selectedMenuCategory.name}</h3>
            ) : null}
            {Object.keys(groupedData).length === 0 ? (
              <div className="text-center py-8 sm:py-12 bg-card border rounded-lg px-4 sm:px-6">
                <div className="max-w-md mx-auto">
                  <div className="text-5xl sm:text-6xl mb-3 sm:mb-4">📁</div>
                  <h3 className="text-lg sm:text-xl font-semibold mb-2">No items yet</h3>
                  <p className="text-sm sm:text-base text-muted-foreground mb-4 sm:mb-6">
                    Add your first item to &ldquo;{selectedMenuCategory.name}&rdquo;
                  </p>
                  <Button 
                    onClick={handleAddItem}
                    className="bg-[#FF6B35] hover:bg-[#e55a28] w-full sm:w-auto h-11 sm:h-10 text-sm sm:text-base px-6"
                  >
                    <Plus className="h-4 w-4 mr-2" />
                    Add First Item
                  </Button>
                </div>
              </div>
            ) : (
              Object.values(groupedData).map(({ subcategory, items }) => {
                // Filter items by search query
                const filteredItems = items.filter(item => {
                  if (!searchableQuery) return true
                  return item.name.toLowerCase().includes(searchableQuery) || 
                         item.description?.toLowerCase().includes(searchableQuery)
                })

                if (filteredItems.length === 0 && searchableQuery) return null
                
                return (
                  <div key={subcategory.id} className="space-y-4">
                    {hasRealSubcategories ? (
                      <h4 className="text-base font-medium text-muted-foreground">
                        {subcategory.name} ({filteredItems.length}{' '}
                        {filteredItems.length === 1 ? 'item' : 'items'})
                      </h4>
                    ) : (
                      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 sm:gap-0">
                        <h3 className="text-lg sm:text-xl font-semibold">
                          {selectedMenuCategory.name} ({filteredItems.length}{' '}
                          {filteredItems.length === 1 ? 'item' : 'items'})
                        </h3>
                        <div className="flex gap-2">
                          <Button
                            onClick={handleAddItem}
                            className="bg-[#FF6B35] hover:bg-[#e55a28] w-full sm:w-auto h-11 sm:h-9 text-sm sm:text-sm"
                            size="sm"
                          >
                            <Plus className="h-4 w-4 mr-2" />
                            Add Item
                          </Button>
                        </div>
                      </div>
                    )}
                    {hasRealSubcategories ? (
                      <div className="flex justify-end">
                        <Button
                          onClick={() =>
                            subcategory.id === '__other__'
                              ? handleAddItem()
                              : handleAddItemForSubCategory(subcategory)
                          }
                          className="bg-[#FF6B35] hover:bg-[#e55a28] h-11 sm:h-9 text-sm sm:text-sm"
                          size="sm"
                        >
                          <Plus className="h-4 w-4 mr-2" />
                          Add Item
                        </Button>
                      </div>
                    ) : null}
                    {filteredItems.length > 0 ? (
                      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3 sm:gap-4">
                        {filteredItems.slice(0, getVisibleLimit(subcategory.id)).map((item) => (
                          <div
                            key={item.id}
                            className="bg-card border rounded-lg overflow-hidden hover:shadow-md transition-shadow"
                          >
                            <div className="relative w-full h-32 bg-gray-50 overflow-hidden">
                              <FoodItemImage
                                itemName={item.name}
                                menuItemId={item.id}
                                storedImageUrl={item.image_url}
                                alt={item.name}
                                className="w-full h-full object-cover rounded-t-lg"
                                style={{
                                  objectFit: item.imageFit || 'cover',
                                  objectPosition: item.imagePosition || 'center',
                                }}
                              />
                            </div>
                              <div className="p-3">
                                <div className="flex items-start justify-between mb-1 gap-2">
                                  <h4 className="font-semibold text-sm sm:text-sm line-clamp-1 flex-1">{item.name}</h4>
                                  <div className="flex gap-1 flex-shrink-0">
                                    <Button
                                      variant="ghost"
                                      size="icon"
                                      className="h-8 w-8 sm:h-6 sm:w-6"
                                      onClick={() => handleEditItem(item)}
                                    >
                                      <Edit className="h-4 w-4 sm:h-3 sm:w-3" />
                                    </Button>
                                    <Button
                                      variant="ghost"
                                      size="icon"
                                      className="h-8 w-8 sm:h-6 sm:w-6 text-red-500 hover:text-red-700"
                                      onClick={() => handleDeleteItem(item)}
                                    >
                                      <Trash2 className="h-4 w-4 sm:h-3 sm:w-3" />
                                    </Button>
                                  </div>
                                </div>
                              <p className="text-xs text-muted-foreground mb-2 line-clamp-1">
                                {item.description}
                              </p>
                              <div className="mb-2">
                                <MenuItemInventoryBadge item={item} setup={inventorySetup} />
                              </div>
                              <div className="flex items-center justify-between">
                                <span className="text-sm font-bold text-[#FF6B35]">
                                  N${item.base_price.toFixed(2)}
                                </span>
                                <span className={`text-xs px-1.5 py-0.5 rounded ${
                                  item.status === 'hidden'
                                    ? 'bg-gray-200 text-gray-600'
                                    : item.status === 'available'
                                      ? 'bg-green-100 text-green-800'
                                      : 'bg-yellow-100 text-yellow-800'
                                }`}>
                                  {item.status === 'hidden'
                                    ? 'Hidden'
                                    : item.status === 'available'
                                      ? '✓'
                                      : '⚠'}
                                </span>
                              </div>
                            </div>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <p className="text-sm text-muted-foreground italic">
                        {searchableQuery ? `No items match "${searchQuery}"` : 'No items in this category'}
                      </p>
                    )}
                    {filteredItems.length > getVisibleLimit(subcategory.id) && (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => handleLoadMoreItems(subcategory.id)}
                        className="h-9 text-sm"
                      >
                        Load More ({filteredItems.length - getVisibleLimit(subcategory.id)} remaining)
                      </Button>
                    )}
                  </div>
                )
              })
            )}
          </div>
        )}

      </div>

      {/* Create Menu Category Modal */}
      <Dialog open={showMenuCategoryModal} onOpenChange={setShowMenuCategoryModal}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create Menu Category</DialogTitle>
            <DialogDescription>Add a new top-level menu category.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <Label>Category Name *</Label>
              <Input
                value={menuCategoryForm.name}
                onChange={(e) => setMenuCategoryForm({ ...menuCategoryForm, name: e.target.value })}
                placeholder="e.g., Drinks, Food, Specials"
              />
            </div>
            <div>
              <Label>Description (Optional)</Label>
              <Textarea
                value={menuCategoryForm.description}
                onChange={(e) => setMenuCategoryForm({ ...menuCategoryForm, description: e.target.value })}
                placeholder="Describe this category..."
                rows={3}
              />
            </div>
            <div>
              <Label>Order goes to</Label>
              <Select
                value={menuCategoryForm.route_to}
                onValueChange={(value: 'kitchen' | 'bar' | 'both') =>
                  setMenuCategoryForm({ ...menuCategoryForm, route_to: value })
                }
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select destination" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="kitchen">Kitchen</SelectItem>
                  <SelectItem value="bar">Bar</SelectItem>
                  <SelectItem value="both">Both</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setShowMenuCategoryModal(false)}>
                Cancel
              </Button>
              <Button onClick={handleCreateMenuCategory} className="bg-[#FF6B35] hover:bg-[#e55a28]">
                Create
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Edit Menu Category Modal */}
      <Dialog
        open={showEditMenuCategoryModal}
        onOpenChange={(open) => {
          setShowEditMenuCategoryModal(open)
          if (!open) {
            setEditingMenuCategory(null)
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit Menu Category</DialogTitle>
            <DialogDescription>Update this menu category details and display order.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <Label>Category Name *</Label>
              <Input
                value={editMenuCategoryForm.name}
                onChange={(e) => setEditMenuCategoryForm({ ...editMenuCategoryForm, name: e.target.value })}
                placeholder="e.g., Drinks, Food, Specials"
              />
            </div>
            <div>
              <Label>Description (Optional)</Label>
              <Textarea
                value={editMenuCategoryForm.description}
                onChange={(e) => setEditMenuCategoryForm({ ...editMenuCategoryForm, description: e.target.value })}
                placeholder="Describe this category..."
                rows={3}
              />
            </div>
            <div>
              <Label>Display Order</Label>
              <Input
                type="number"
                min={0}
                value={editMenuCategoryForm.display_order}
                onChange={(e) => setEditMenuCategoryForm({ ...editMenuCategoryForm, display_order: e.target.value })}
                placeholder="0"
              />
            </div>
            <div>
              <Label>Order goes to</Label>
              <Select
                value={editMenuCategoryForm.route_to}
                onValueChange={(value: 'kitchen' | 'bar' | 'both') =>
                  setEditMenuCategoryForm({ ...editMenuCategoryForm, route_to: value })
                }
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select destination" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="kitchen">Kitchen</SelectItem>
                  <SelectItem value="bar">Bar</SelectItem>
                  <SelectItem value="both">Both</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="flex justify-end gap-2">
              <Button
                variant="outline"
                onClick={() => {
                  setShowEditMenuCategoryModal(false)
                  setEditingMenuCategory(null)
                }}
              >
                Cancel
              </Button>
              <Button onClick={handleSaveMenuCategoryEdit} className="bg-[#FF6B35] hover:bg-[#e55a28]">
                Save
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Create Sub-Category Modal */}
      <Dialog open={showSubCategoryModal} onOpenChange={setShowSubCategoryModal}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create Sub-category</DialogTitle>
            <DialogDescription>Create a sub-category under the selected parent category.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <Label>Parent Category</Label>
              <Input
                value={selectedMenuCategory?.name || ''}
                disabled
                className="bg-muted"
              />
            </div>
            <div>
              <Label>Sub-category Name *</Label>
              <Input
                value={subCategoryForm.name}
                onChange={(e) => setSubCategoryForm({ ...subCategoryForm, name: e.target.value })}
                placeholder="e.g., Alcoholic drinks, Soft drinks"
              />
            </div>
            <div>
              <Label>Description (Optional)</Label>
              <Textarea
                value={subCategoryForm.description}
                onChange={(e) => setSubCategoryForm({ ...subCategoryForm, description: e.target.value })}
                placeholder="Describe this sub-category..."
                rows={3}
              />
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setShowSubCategoryModal(false)}>
                Cancel
              </Button>
              <Button onClick={handleCreateSubCategory} className="bg-[#FF6B35] hover:bg-[#e55a28]">
                Create
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Edit Sub-Category Modal */}
      <Dialog
        open={showEditSubCategoryModal}
        onOpenChange={(open) => {
          setShowEditSubCategoryModal(open)
          if (!open) {
            setEditingSubCategory(null)
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit Sub-category</DialogTitle>
            <DialogDescription>Update this sub-category details and display order.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <Label>Sub-category Name *</Label>
              <Input
                value={editSubCategoryForm.name}
                onChange={(e) => setEditSubCategoryForm({ ...editSubCategoryForm, name: e.target.value })}
                placeholder="e.g., Alcoholic drinks, Soft drinks"
              />
            </div>
            <div>
              <Label>Description (Optional)</Label>
              <Textarea
                value={editSubCategoryForm.description}
                onChange={(e) => setEditSubCategoryForm({ ...editSubCategoryForm, description: e.target.value })}
                placeholder="Describe this sub-category..."
                rows={3}
              />
            </div>
            <div>
              <Label>Display Order</Label>
              <Input
                type="number"
                min={0}
                value={editSubCategoryForm.display_order}
                onChange={(e) => setEditSubCategoryForm({ ...editSubCategoryForm, display_order: e.target.value })}
                placeholder="0"
              />
            </div>
            <div className="flex justify-end gap-2">
              <Button
                variant="outline"
                onClick={() => {
                  setShowEditSubCategoryModal(false)
                  setEditingSubCategory(null)
                }}
              >
                Cancel
              </Button>
              <Button onClick={handleSaveSubCategoryEdit} className="bg-[#FF6B35] hover:bg-[#e55a28]">
                Save
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <MenuItemFormModal
        open={showItemModal}
        onOpenChange={(open) => {
          setShowItemModal(open)
          if (!open) setEditingItem(null)
        }}
        editingItem={editingItem}
        restaurantId={restaurantId}
        categoryId={selectedMenuCategory?.id ?? editingItem?.menu_category_id ?? null}
        defaultSubCategoryId={defaultSubCategoryId}
        subCategoryOptions={allSubCategoryOptions}
        onSaved={handleItemSaved}
      />
    </div>
  )
}

