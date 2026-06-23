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
  createMenuItem, 
  updateMenuItem, 
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
import { ArrowLeft, Plus, Search, Edit, Trash2, X, ChevronRight, Upload, Loader2, Pencil } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { useToast } from '@/hooks/use-toast'
import Image from 'next/image'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { uploadMenuItemImage } from '@/lib/supabase/storage'
import { menuItemImageDisplayUrl } from '@/lib/menu-item-image'
import { Skeleton } from '@/components/ui/skeleton'
import { FoodItemImage } from '@/components/menu/food-item-image'

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

export function MenuManagementV2() {
  const { user, restaurantId } = useAuth()
  const router = useRouter()
  const { toast } = useToast()
  
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
  const [showEditMenuCategoryModal, setShowEditMenuCategoryModal] = useState(false)
  const [showEditSubCategoryModal, setShowEditSubCategoryModal] = useState(false)
  const [editingItem, setEditingItem] = useState<MenuItem | null>(null)
  const [editingMenuCategory, setEditingMenuCategory] = useState<MenuCategory | null>(null)
  const [editingSubCategory, setEditingSubCategory] = useState<SubCategory | null>(null)
  
  // Form state
  const [menuCategoryForm, setMenuCategoryForm] = useState({ name: '', description: '' })
  const [subCategoryForm, setSubCategoryForm] = useState({ name: '', description: '' })
  const [editMenuCategoryForm, setEditMenuCategoryForm] = useState({ name: '', description: '', display_order: '' })
  const [editSubCategoryForm, setEditSubCategoryForm] = useState({ name: '', description: '', display_order: '' })
  const [itemForm, setItemForm] = useState({
    name: '',
    description: '',
    sub_category_id: '',
    base_price: '',
    image_url: '',
    imageFile: null as File | null,
    imageFit: 'contain' as 'contain' | 'cover' | 'fill' | 'scale-down',
    imagePosition: 'center' as 'center' | 'top' | 'bottom',
    has_sizes: false,
    sizes: [] as Array<{ name: string; price_modifier: number }>,
    variants: [] as Array<{ size: string; label: string; price: number }>,
    variantGroups: [] as Array<{
      name: string
      required: boolean
      type: 'text' | 'price'
      options: Array<string | { label: string; price: number }>
    }>,
    has_addons: false,
    addons: [] as Array<{ name: string; price: number }>,
    allow_special_instructions: true,
    status: 'available' as 'available' | 'out_of_stock' | 'hidden',
  })
  const [uploadingImage, setUploadingImage] = useState(false)
  const [imagePreview, setImagePreview] = useState<string | null>(null)
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
  useEffect(() => {
    // Check localStorage first for faster initial load
    const cachedRestaurantId = typeof window !== 'undefined' ? localStorage.getItem('restaurantId') : null
    const effectiveRestaurantId = restaurantId || cachedRestaurantId

    // Don't run if user is null (prevents fetching when signed out)
    if (!user && !cachedRestaurantId) {
      setLoading(false)
      return
    }

    if (!effectiveRestaurantId) {
      setLoading(false)
      return
    }

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
  }, [user?.id, restaurantId, readCache, writeCache]) // Removed selectedMenuCategory from dependencies to prevent reset

  const searchableQuery = useMemo(() => searchQuery.trim().toLowerCase(), [searchQuery])

  const visibleMenuItems = useMemo(
    () => (showHidden ? allMenuItems : allMenuItems.filter((item) => item.status !== 'hidden')),
    [allMenuItems, showHidden]
  )

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
    if (loading) return

    writeCache({
      menuCategories,
      allSubCategories,
      allMenuItems,
      selectedMenuCategoryId: selectedMenuCategory?.id || null,
    })
  }, [allMenuItems, allSubCategories, loading, menuCategories, selectedMenuCategory?.id, writeCache])

  // Navigation handlers
  const handleSelectMenuCategory = (category: MenuCategory | null) => {
    setSelectedMenuCategory(category)
    setSearchQuery('')
    setVisibleItemsBySubcategory({})
  }

  // Handle add item for specific sub-category
  const handleAddItemForSubCategory = (subCategory: SubCategory) => {
    setItemForm({
      name: '',
      description: '',
      sub_category_id: subCategory.id,
      base_price: '',
      image_url: '',
      imageFile: null,
      imageFit: 'contain',
      imagePosition: 'center',
      has_sizes: false,
      sizes: [],
      variants: [],
      variantGroups: [],
      has_addons: false,
      addons: [],
      allow_special_instructions: true,
      status: 'available',
    })
    setEditingItem(null)
    setImagePreview(null)
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
      await createMenuCategory(restaurantId, name, menuCategoryForm.description || undefined)
      toast({
        title: 'Success',
        description: `Category "${name}" created successfully`,
      })
      setMenuCategoryForm({ name: '', description: '' })
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
    setItemForm({
      name: '',
      description: '',
      sub_category_id: firstCategorySub?.id || '',
      base_price: '',
      image_url: '',
      imageFile: null,
      imageFit: 'contain',
      imagePosition: 'center',
      has_sizes: false,
      sizes: [],
      variants: [],
      variantGroups: [],
      has_addons: false,
      addons: [],
      allow_special_instructions: true,
      status: 'available',
    })
    setEditingItem(null)
    setImagePreview(null)
    setShowItemModal(true)
  }

  const handleEditItem = (item: MenuItem) => {
    setEditingItem(item)
    setItemForm({
      name: item.name,
      description: item.description || '',
      sub_category_id: item.sub_category_id,
      base_price: item.base_price.toString(),
      image_url: item.image_url || '',
      imageFile: null,
      imageFit: item.imageFit || 'contain',
      imagePosition: item.imagePosition || 'center',
      has_sizes: item.has_sizes,
      sizes: item.sizes || [],
      variants: Array.isArray((item as MenuItem & { variants?: Array<{ size: string; label: string; price: number }> }).variants)
        ? (item as MenuItem & { variants?: Array<{ size: string; label: string; price: number }> }).variants || []
        : [],
      variantGroups: Array.isArray((item as MenuItem & { variantGroups?: Array<{
        name: string
        required: boolean
        type: 'text' | 'price'
        options: Array<string | { label: string; price: number }>
      }> }).variantGroups)
        ? (item as MenuItem & { variantGroups?: Array<{
            name: string
            required: boolean
            type: 'text' | 'price'
            options: Array<string | { label: string; price: number }>
          }> }).variantGroups || []
        : [],
      has_addons: item.has_addons,
      addons: item.addons || [],
      allow_special_instructions: item.allow_special_instructions,
      status: item.status,
    })
    setImagePreview(
      item.image_url
        ? menuItemImageDisplayUrl(item.id, item.image_url) || item.image_url
        : null
    )
    setShowItemModal(true)
  }

  const handleImageFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return

    // Validate file type
    if (!file.type.startsWith('image/')) {
      toast({
        title: 'Invalid File',
        description: 'Please select an image file',
        variant: 'destructive',
      })
      return
    }

    // Validate file size (max 5MB)
    const maxSize = 5 * 1024 * 1024 // 5MB
    if (file.size > maxSize) {
      toast({
        title: 'File Too Large',
        description: 'Image must be less than 5MB',
        variant: 'destructive',
      })
      return
    }

    setItemForm({ ...itemForm, imageFile: file, image_url: '' })
    
    // Create preview
    const reader = new FileReader()
    reader.onloadend = () => {
      setImagePreview(reader.result as string)
    }
    reader.readAsDataURL(file)
  }

  const handleRemoveImage = () => {
    setItemForm({ ...itemForm, imageFile: null, image_url: '' })
    setImagePreview(null)
  }

  const handleAddVariantRow = () => {
    setItemForm((prev) => ({
      ...prev,
      variants: [...prev.variants, { size: '', label: '', price: Number(prev.base_price) || 0 }],
    }))
  }

  const handleUpdateVariantRow = (
    index: number,
    field: 'size' | 'label' | 'price',
    value: string
  ) => {
    setItemForm((prev) => {
      const next = [...prev.variants]
      if (!next[index]) return prev
      if (field === 'price') {
        next[index] = { ...next[index], price: Number(value) || 0 }
      } else {
        next[index] = { ...next[index], [field]: value }
      }
      return { ...prev, variants: next }
    })
  }

  const handleRemoveVariantRow = (index: number) => {
    setItemForm((prev) => ({
      ...prev,
      variants: prev.variants.filter((_, idx) => idx !== index),
    }))
  }

  const handleAddVariantGroup = () => {
    setItemForm((prev) => ({
      ...prev,
      variantGroups: [
        ...prev.variantGroups,
        { name: '', required: true, type: 'text', options: [''] },
      ],
    }))
  }

  const handleUpdateVariantGroup = (
    groupIndex: number,
    field: 'name' | 'required' | 'type',
    value: string | boolean
  ) => {
    setItemForm((prev) => {
      const next = [...prev.variantGroups]
      if (!next[groupIndex]) return prev
      next[groupIndex] = { ...next[groupIndex], [field]: value } as typeof next[number]
      return { ...prev, variantGroups: next }
    })
  }

  const handleRemoveVariantGroup = (groupIndex: number) => {
    setItemForm((prev) => ({
      ...prev,
      variantGroups: prev.variantGroups.filter((_, idx) => idx !== groupIndex),
    }))
  }

  const handleAddVariantGroupOption = (groupIndex: number) => {
    setItemForm((prev) => {
      const next = [...prev.variantGroups]
      if (!next[groupIndex]) return prev
      const group = next[groupIndex]
      const newOption = group.type === 'price' ? { label: '', price: Number(prev.base_price) || 0 } : ''
      next[groupIndex] = { ...group, options: [...group.options, newOption] }
      return { ...prev, variantGroups: next }
    })
  }

  const handleUpdateVariantGroupOption = (
    groupIndex: number,
    optionIndex: number,
    field: 'label' | 'price' | 'value',
    value: string
  ) => {
    setItemForm((prev) => {
      const next = [...prev.variantGroups]
      const group = next[groupIndex]
      if (!group || !group.options[optionIndex]) return prev
      const nextOptions = [...group.options]
      const existing = nextOptions[optionIndex]
      if (group.type === 'price') {
        const obj = typeof existing === 'string' ? { label: existing, price: 0 } : existing
        nextOptions[optionIndex] =
          field === 'price' ? { ...obj, price: Number(value) || 0 } : { ...obj, label: value }
      } else {
        nextOptions[optionIndex] = value
      }
      next[groupIndex] = { ...group, options: nextOptions }
      return { ...prev, variantGroups: next }
    })
  }

  const handleRemoveVariantGroupOption = (groupIndex: number, optionIndex: number) => {
    setItemForm((prev) => {
      const next = [...prev.variantGroups]
      const group = next[groupIndex]
      if (!group) return prev
      next[groupIndex] = {
        ...group,
        options: group.options.filter((_, idx) => idx !== optionIndex),
      }
      return { ...prev, variantGroups: next }
    })
  }

  const handleSaveItem = async () => {
    if (!restaurantId) return

    if (!itemForm.name || !itemForm.base_price) {
      toast({
        title: 'Validation Error',
        description: 'Please fill in all required fields',
        variant: 'destructive',
      })
      return
    }

    const price = parseFloat(itemForm.base_price)
    if (isNaN(price) || price <= 0) {
      toast({
        title: 'Validation Error',
        description: 'Please enter a valid price greater than 0',
        variant: 'destructive',
      })
      return
    }

    const sanitizedVariants = itemForm.variants
      .map((variant) => ({
        size: String(variant.size || '').trim(),
        label: String(variant.label || '').trim(),
        price: Number(variant.price),
      }))
      .filter((variant) => variant.size && variant.label && Number.isFinite(variant.price) && variant.price > 0)

    const sanitizedVariantGroups = itemForm.variantGroups
      .map((group) => {
        const cleanedName = String(group.name || '').trim()
        const cleanedOptions =
          group.type === 'price'
            ? group.options
                .map((opt) => {
                  if (typeof opt === 'string') return null
                  return {
                    label: String(opt.label || '').trim(),
                    price: Number(opt.price),
                  }
                })
                .filter((opt) => opt && opt.label && Number.isFinite(opt.price) && opt.price > 0)
            : group.options
                .map((opt) => (typeof opt === 'string' ? String(opt).trim() : String(opt?.label || '').trim()))
                .filter(Boolean)
        return {
          name: cleanedName,
          required: Boolean(group.required),
          type: group.type,
          options: cleanedOptions,
        }
      })
      .filter((group) => group.name && group.options.length > 0)

    try {
      let imageUrl = itemForm.image_url

      // Upload image if file is selected
      if (itemForm.imageFile) {
        setUploadingImage(true)
        try {
          imageUrl = await uploadMenuItemImage(
            itemForm.imageFile,
            restaurantId,
            editingItem?.id
          )
          toast({
            title: 'Image Uploaded',
            description: 'Image uploaded successfully',
          })
        } catch (uploadError: any) {
          toast({
            title: 'Upload Error',
            description: uploadError.message || 'Failed to upload image',
            variant: 'destructive',
          })
          setUploadingImage(false)
          return
        } finally {
          setUploadingImage(false)
        }
      }

      if (editingItem) {
        // For update, we need the full path - extract from editingItem
        if (!editingItem.menu_category_id) {
          throw new Error('Menu item missing category information')
        }
        
        await updateMenuItem(
          restaurantId,
          editingItem.menu_category_id,
          editingItem.sub_category_id || '',
          editingItem.id,
          {
            name: itemForm.name,
            description: itemForm.description,
            base_price: price,
            image_url: imageUrl || undefined,
            imageFit: itemForm.imageFit,
            imagePosition: itemForm.imagePosition,
            has_sizes: itemForm.has_sizes,
            sizes: itemForm.sizes,
            variants: sanitizedVariants.length > 0 ? sanitizedVariants : undefined,
            variantGroups: sanitizedVariantGroups.length > 0 ? sanitizedVariantGroups : undefined,
            has_addons: itemForm.has_addons,
            addons: itemForm.addons,
            allow_special_instructions: itemForm.allow_special_instructions,
            status: itemForm.status,
          }
        )
        toast({
          title: 'Success',
          description: 'Menu item updated successfully',
        })
      } else {
        await createMenuItem({
          restaurant_id: restaurantId,
          category_id: selectedMenuCategory?.id || null,
          sub_category_id: itemForm.sub_category_id || null,
          name: itemForm.name,
          description: itemForm.description,
          image_url: imageUrl || undefined,
          base_price: price,
          imageFit: itemForm.imageFit,
          imagePosition: itemForm.imagePosition,
          has_sizes: itemForm.has_sizes,
          sizes: itemForm.sizes,
          variants: sanitizedVariants.length > 0 ? sanitizedVariants : undefined,
          variantGroups: sanitizedVariantGroups.length > 0 ? sanitizedVariantGroups : undefined,
          has_addons: itemForm.has_addons,
          addons: itemForm.addons,
          allow_special_instructions: itemForm.allow_special_instructions,
          status: itemForm.status,
        })
        toast({
          title: 'Success',
          description: 'Menu item created successfully',
        })
      }

      setShowItemModal(false)
      setItemForm({
        name: '',
        description: '',
        sub_category_id: '',
        base_price: '',
        image_url: '',
        imageFile: null,
        imageFit: 'contain',
        imagePosition: 'center',
        has_sizes: false,
        sizes: [],
        variants: [],
        variantGroups: [],
        has_addons: false,
        addons: [],
        allow_special_instructions: true,
        status: 'available',
      })
      setEditingItem(null)
      setImagePreview(null)

      // Reload all items to refresh the view
      const items = await getMenuItems(restaurantId)
      setAllMenuItems(items)
      await invalidateServerMenuCache()
    } catch (err: any) {
      toast({
        title: 'Error',
        description: err.message || 'Failed to save menu item',
        variant: 'destructive',
      })
    }
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
  if (loading) {
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
                          setItemForm((prev) => ({ ...prev, sub_category_id: '' }))
                          setEditingItem(null)
                          setImagePreview(null)
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
                    Add your first item to "{selectedMenuCategory.name}"
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

      {/* Add/Edit Menu Item Modal */}
      <Dialog open={showItemModal} onOpenChange={setShowItemModal}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{editingItem ? 'Edit Menu Item' : 'Add Menu Item'}</DialogTitle>
            <DialogDescription>
              {editingItem
                ? 'Modify item details, pricing, variants, and image settings.'
                : 'Create a new menu item with pricing, variants, and optional image.'}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <Label>Sub-category (Optional)</Label>
              {allSubCategoryOptions.length > 0 ? (
                <SubCategorySelect
                  subCategories={allSubCategoryOptions}
                  value={itemForm.sub_category_id}
                  onChange={(value) => setItemForm({ ...itemForm, sub_category_id: value })}
                />
              ) : (
                <p className="text-sm text-muted-foreground">
                  No sub-categories available. Item will be saved directly under this category.
                </p>
              )}
            </div>
            <div>
              <Label>Item Name *</Label>
              <Input
                value={itemForm.name}
                onChange={(e) => setItemForm({ ...itemForm, name: e.target.value })}
                placeholder="e.g., Windhoek Lager"
              />
            </div>
            <div>
              <Label>Description</Label>
              <Textarea
                value={itemForm.description}
                onChange={(e) => setItemForm({ ...itemForm, description: e.target.value })}
                placeholder="Describe the item..."
                rows={3}
              />
            </div>
            <div>
              <Label>Price (N$) *</Label>
              <Input
                type="number"
                step="0.01"
                value={itemForm.base_price}
                onChange={(e) => setItemForm({ ...itemForm, base_price: e.target.value })}
                placeholder="25.00"
              />
            </div>
            <div className="space-y-3 border border-border rounded-md p-3">
              <div className="flex items-center justify-between">
                <Label>Add Variants (Optional)</Label>
                <Button type="button" variant="outline" size="sm" onClick={handleAddVariantRow}>
                  <Plus className="h-4 w-4 mr-1" />
                  Add Variant
                </Button>
              </div>
              {itemForm.variants.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  Leave empty to use a single default price only.
                </p>
              ) : (
                <div className="space-y-2">
                  {itemForm.variants.map((variant, index) => (
                    <div key={`variant-${index}`} className="grid grid-cols-12 gap-2 items-center">
                      <Input
                        className="col-span-2"
                        placeholder="S"
                        value={variant.size}
                        onChange={(e) => handleUpdateVariantRow(index, 'size', e.target.value)}
                      />
                      <Input
                        className="col-span-5"
                        placeholder="Small"
                        value={variant.label}
                        onChange={(e) => handleUpdateVariantRow(index, 'label', e.target.value)}
                      />
                      <Input
                        className="col-span-4"
                        type="number"
                        step="0.01"
                        placeholder="25.00"
                        value={Number.isFinite(variant.price) ? variant.price : ''}
                        onChange={(e) => handleUpdateVariantRow(index, 'price', e.target.value)}
                      />
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="col-span-1"
                        onClick={() => handleRemoveVariantRow(index)}
                      >
                        <Trash2 className="h-4 w-4 text-red-500" />
                      </Button>
                    </div>
                  ))}
                </div>
              )}
            </div>
            <div className="space-y-3 border border-border rounded-md p-3">
              <div className="flex items-center justify-between">
                <Label>Variant Groups (Optional)</Label>
                <Button type="button" variant="outline" size="sm" onClick={handleAddVariantGroup}>
                  <Plus className="h-4 w-4 mr-1" />
                  Add Group
                </Button>
              </div>
              {itemForm.variantGroups.length === 0 ? (
                <p className="text-xs text-muted-foreground">No groups configured.</p>
              ) : (
                <div className="space-y-3">
                  {itemForm.variantGroups.map((group, groupIndex) => (
                    <div key={`variant-group-${groupIndex}`} className="rounded-md border p-3 space-y-2">
                      <div className="grid grid-cols-12 gap-2 items-center">
                        <Input
                          className="col-span-4"
                          placeholder="Group name (e.g. Size)"
                          value={group.name}
                          onChange={(e) => handleUpdateVariantGroup(groupIndex, 'name', e.target.value)}
                        />
                        <Select
                          value={group.type}
                          onValueChange={(value: 'text' | 'price') =>
                            handleUpdateVariantGroup(groupIndex, 'type', value)
                          }
                        >
                          <SelectTrigger className="col-span-3">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="text">text</SelectItem>
                            <SelectItem value="price">price</SelectItem>
                          </SelectContent>
                        </Select>
                        <label className="col-span-3 flex items-center gap-2 text-xs">
                          <input
                            type="checkbox"
                            checked={group.required}
                            onChange={(e) =>
                              handleUpdateVariantGroup(groupIndex, 'required', e.target.checked)
                            }
                          />
                          Required
                        </label>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="col-span-2"
                          onClick={() => handleRemoveVariantGroup(groupIndex)}
                        >
                          <Trash2 className="h-4 w-4 text-red-500" />
                        </Button>
                      </div>
                      <div className="space-y-2">
                        {group.options.map((opt, optionIndex) => (
                          <div key={`group-${groupIndex}-opt-${optionIndex}`} className="grid grid-cols-12 gap-2">
                            {group.type === 'price' ? (
                              <>
                                <Input
                                  className="col-span-7"
                                  placeholder="Option label"
                                  value={typeof opt === 'string' ? opt : opt.label}
                                  onChange={(e) =>
                                    handleUpdateVariantGroupOption(
                                      groupIndex,
                                      optionIndex,
                                      'label',
                                      e.target.value
                                    )
                                  }
                                />
                                <Input
                                  className="col-span-4"
                                  type="number"
                                  step="0.01"
                                  placeholder="Price"
                                  value={
                                    typeof opt === 'string'
                                      ? ''
                                      : Number.isFinite(opt.price)
                                        ? opt.price
                                        : ''
                                  }
                                  onChange={(e) =>
                                    handleUpdateVariantGroupOption(
                                      groupIndex,
                                      optionIndex,
                                      'price',
                                      e.target.value
                                    )
                                  }
                                />
                              </>
                            ) : (
                              <Input
                                className="col-span-11"
                                placeholder="Option value"
                                value={typeof opt === 'string' ? opt : opt.label}
                                onChange={(e) =>
                                  handleUpdateVariantGroupOption(
                                    groupIndex,
                                    optionIndex,
                                    'value',
                                    e.target.value
                                  )
                                }
                              />
                            )}
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              className="col-span-1"
                              onClick={() => handleRemoveVariantGroupOption(groupIndex, optionIndex)}
                            >
                              <X className="h-4 w-4 text-red-500" />
                            </Button>
                          </div>
                        ))}
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() => handleAddVariantGroupOption(groupIndex)}
                        >
                          <Plus className="h-4 w-4 mr-1" />
                          Add Option
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
            <div>
              <Label>Image</Label>
              <div className="space-y-2">
                {/* File Upload */}
                <div className="flex items-center gap-2">
                  <Input
                    type="file"
                    accept="image/*"
                    onChange={handleImageFileChange}
                    className="cursor-pointer"
                    disabled={uploadingImage}
                  />
                  {imagePreview && (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={handleRemoveImage}
                      disabled={uploadingImage}
                    >
                      <X className="h-4 w-4" />
                    </Button>
                  )}
                </div>
                
                {/* Or URL Input */}
                <div className="text-sm text-muted-foreground text-center">or</div>
                <Input
                  value={itemForm.image_url}
                  onChange={(e) => {
                    setItemForm({ ...itemForm, image_url: e.target.value, imageFile: null })
                    setImagePreview(e.target.value || null)
                  }}
                  placeholder="Enter image URL..."
                  disabled={uploadingImage || !!itemForm.imageFile}
                />
                
                {/* Image Preview */}
                    {imagePreview && (
                      <div className="relative w-full h-48 border rounded-lg overflow-hidden bg-gray-50">
                        <Image
                          src={imagePreview}
                          alt="Preview"
                          fill
                          style={{
                            objectFit: itemForm.imageFit,
                            objectPosition: itemForm.imagePosition,
                          }}
                        />
                    {uploadingImage && (
                      <div className="absolute inset-0 bg-black/50 flex items-center justify-center">
                        <Loader2 className="h-8 w-8 animate-spin text-white" />
                      </div>
                    )}
                  </div>
                )}
                
                {itemForm.imageFile && (
                  <p className="text-xs text-muted-foreground">
                    Selected: {itemForm.imageFile.name} ({(itemForm.imageFile.size / 1024 / 1024).toFixed(2)} MB)
                  </p>
                )}
              </div>
            </div>
            
            {/* Image Display Options */}
            {imagePreview && (
              <div className="space-y-4">
                <div>
                  <Label>Image Display</Label>
                  <Select
                    value={itemForm.imageFit}
                    onValueChange={(value: 'contain' | 'cover' | 'fill' | 'scale-down') => 
                      setItemForm({ ...itemForm, imageFit: value })
                    }
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="contain">Fit (Show full image)</SelectItem>
                      <SelectItem value="cover">Fill (May crop image)</SelectItem>
                      <SelectItem value="scale-down">Scale Down</SelectItem>
                      <SelectItem value="fill">Stretch</SelectItem>
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-muted-foreground mt-1">
                    Choose how the image should be displayed in the card
                  </p>
                </div>
                
                <div>
                  <Label>Image Position</Label>
                  <Select
                    value={itemForm.imagePosition}
                    onValueChange={(value: 'center' | 'top' | 'bottom') => 
                      setItemForm({ ...itemForm, imagePosition: value })
                    }
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="center">Center</SelectItem>
                      <SelectItem value="top">Top</SelectItem>
                      <SelectItem value="bottom">Bottom</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                
                {/* Visual Preview */}
                <div className="grid grid-cols-2 gap-2">
                  {(['contain', 'cover', 'fill', 'scale-down'] as const).map((fit) => (
                    <button
                      key={fit}
                      type="button"
                      onClick={() => setItemForm({ ...itemForm, imageFit: fit })}
                      className={`p-2 border-2 rounded-lg transition-colors ${
                        itemForm.imageFit === fit ? 'border-[#FF6B35] bg-orange-50' : 'border-gray-200 hover:border-gray-300'
                      }`}
                    >
                      <div className="w-full h-16 bg-gray-100 mb-1 rounded overflow-hidden">
                        {imagePreview && (
                          <img 
                            src={imagePreview} 
                            style={{ objectFit: fit }}
                            className="w-full h-full"
                            alt={fit}
                          />
                        )}
                      </div>
                      <span className="text-xs capitalize block text-center">{fit.replace('-', ' ')}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}
            
            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={itemForm.allow_special_instructions}
                onChange={(e) => setItemForm({ ...itemForm, allow_special_instructions: e.target.checked })}
                className="rounded"
              />
              <Label>Allow special instructions</Label>
            </div>
            <div>
              <Label>Status</Label>
              <Select
                value={itemForm.status}
                onValueChange={(value: 'available' | 'out_of_stock' | 'hidden') => 
                  setItemForm({ ...itemForm, status: value })
                }
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="available">Available</SelectItem>
                  <SelectItem value="out_of_stock">Out of Stock</SelectItem>
                  <SelectItem value="hidden">Hidden</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="flex justify-end gap-2">
              <Button 
                variant="outline" 
                onClick={() => {
                  setShowItemModal(false)
                  setImagePreview(null)
                  setItemForm({
                    ...itemForm,
                    imageFile: null,
                    image_url: '',
                  })
                }}
                disabled={uploadingImage}
              >
                Cancel
              </Button>
              <Button 
                onClick={handleSaveItem} 
                className="bg-[#FF6B35] hover:bg-[#e55a28]"
                disabled={uploadingImage}
              >
                {uploadingImage ? (
                  <>
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    Uploading...
                  </>
                ) : (
                  editingItem ? 'Update' : 'Create'
                )}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}

// Helper component for hierarchical sub-category selection
function SubCategorySelect({ 
  subCategories,
  value, 
  onChange 
}: { 
  subCategories: Array<{ id: string; name: string; menuCategoryName: string }>
  value: string
  onChange: (value: string) => void
}) {
  if (subCategories.length === 0) {
    return (
      <div className="p-3 bg-yellow-50 border border-yellow-200 rounded-md">
        <p className="text-sm text-yellow-800">
          No sub-categories available. Create a sub-category first.
        </p>
      </div>
    )
  }

  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger>
        <SelectValue placeholder="Select sub-category" />
      </SelectTrigger>
      <SelectContent>
        {subCategories.map((subcat) => (
          <SelectItem key={subcat.id} value={subcat.id}>
            {subcat.menuCategoryName} &gt; {subcat.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

