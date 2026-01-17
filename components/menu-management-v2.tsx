'use client'

import { useEffect, useState } from 'react'
import { useAuth } from '@/components/auth/auth-provider'
import { 
  getMenuCategories, 
  createMenuCategory, 
  deleteMenuCategory,
  MenuCategory 
} from '@/lib/firebase/menu-categories'
import { 
  getSubCategories, 
  createSubCategory, 
  deleteSubCategory,
  SubCategory 
} from '@/lib/firebase/sub-categories'
import { 
  getMenuItemsBySubCategory, 
  getMenuItems,
  createMenuItem, 
  updateMenuItem, 
  deleteMenuItem,
  MenuItem 
} from '@/lib/firebase/menu-items'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { ArrowLeft, Plus, Search, Edit, Trash2, X, ChevronRight, Upload, Loader2, UtensilsCrossed } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { useToast } from '@/hooks/use-toast'
import Image from 'next/image'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { uploadMenuItemImage } from '@/lib/firebase/storage'
import { Skeleton } from '@/components/ui/skeleton'

export function MenuManagementV2() {
  const { user, restaurantId } = useAuth()
  const router = useRouter()
  const { toast } = useToast()
  
  // Data state
  const [menuCategories, setMenuCategories] = useState<MenuCategory[]>([])
  const [allSubCategories, setAllSubCategories] = useState<SubCategory[]>([])
  const [allMenuItems, setAllMenuItems] = useState<MenuItem[]>([])
  const [groupedData, setGroupedData] = useState<Record<string, {
    subcategory: SubCategory
    items: MenuItem[]
  }>>({})
  
  // View state
  const [selectedMenuCategory, setSelectedMenuCategory] = useState<MenuCategory | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [loading, setLoading] = useState(true)
  
  // Modal state
  const [showMenuCategoryModal, setShowMenuCategoryModal] = useState(false)
  const [showSubCategoryModal, setShowSubCategoryModal] = useState(false)
  const [showItemModal, setShowItemModal] = useState(false)
  const [editingItem, setEditingItem] = useState<MenuItem | null>(null)
  
  // Form state
  const [menuCategoryForm, setMenuCategoryForm] = useState({ name: '', description: '' })
  const [subCategoryForm, setSubCategoryForm] = useState({ name: '', description: '' })
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
    has_addons: false,
    addons: [] as Array<{ name: string; price: number }>,
    allow_special_instructions: true,
    status: 'available' as 'available' | 'out_of_stock' | 'hidden',
  })
  const [uploadingImage, setUploadingImage] = useState(false)
  const [imagePreview, setImagePreview] = useState<string | null>(null)

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

    const loadAllData = async () => {
      try {
        setLoading(true)
        
        // Load categories first
        const categories = await getMenuCategories(effectiveRestaurantId)
        setMenuCategories(categories)
        
        // Load menu items (with error handling for missing index)
        let allItems: MenuItem[] = []
        try {
          allItems = await getMenuItems(effectiveRestaurantId)
        } catch (err: any) {
          console.warn('Could not load menu items (index may be missing):', err.message)
          // Continue without items - they'll show empty states
        }
        setAllMenuItems(allItems)
        
        // Load all sub-categories for all categories
        const allSubcats: SubCategory[] = []
        for (const category of categories) {
          try {
            const subcats = await getSubCategories(effectiveRestaurantId, category.id)
            allSubcats.push(...subcats)
          } catch (err) {
            console.warn(`Failed to load sub-categories for ${category.name}:`, err)
          }
        }
        setAllSubCategories(allSubcats)
        
        // Preserve selection if it still exists, otherwise auto-select first category
        // Use functional update to get current state value
        setSelectedMenuCategory(current => {
          if (categories.length > 0) {
            if (current) {
              // Check if selected category still exists
              const stillExists = categories.some(cat => cat.id === current.id)
              if (stillExists) {
                return current // Keep current selection
              }
            }
            // No selection or selected category was deleted, select first available
            return categories[0]
          } else {
            // No categories, clear selection
            return null
          }
        })
      } catch (err: any) {
        console.error('Error loading data:', err)
        toast({
          title: 'Error',
          description: err.message || 'Failed to load menu data',
          variant: 'destructive',
        })
      } finally {
        setLoading(false)
      }
    }

    loadAllData()
  }, [user, restaurantId, toast]) // Removed selectedMenuCategory from dependencies to prevent reset

  // Group items by sub-category when category is selected or items change
  useEffect(() => {
    if (!selectedMenuCategory) {
      setGroupedData({})
      return
    }

    // Get sub-categories for selected category
    const categorySubcats = allSubCategories.filter(sc => sc.menu_category_id === selectedMenuCategory.id)
    
    // Group items by sub-category
    const grouped: Record<string, { subcategory: SubCategory; items: MenuItem[] }> = {}
    
    for (const subcat of categorySubcats) {
      const items = allMenuItems.filter(item => 
        item.sub_category_id === subcat.id && 
        item.menu_category_id === selectedMenuCategory.id &&
        item.status !== 'hidden'
      )
      
      grouped[subcat.id] = {
        subcategory: subcat,
        items: items.sort((a, b) => a.name.localeCompare(b.name))
      }
    }
    
    setGroupedData(grouped)
  }, [selectedMenuCategory, allMenuItems, allSubCategories])

  // Calculate item counts for each category
  const getCategoryItemCount = (categoryId: string | null): number => {
    if (!categoryId) {
      // All items count
      return allMenuItems.filter(item => item.status !== 'hidden').length
    }
    return allMenuItems.filter(item => 
      item.menu_category_id === categoryId && item.status !== 'hidden'
    ).length
  }

  // Navigation handlers
  const handleSelectMenuCategory = (category: MenuCategory | null) => {
    setSelectedMenuCategory(category)
    setSearchQuery('')
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
      has_addons: false,
      addons: [],
      allow_special_instructions: true,
      status: 'available',
    })
    setEditingItem(null)
    setImagePreview(null)
    setShowItemModal(true)
  }

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
      const categories = await getMenuCategories(restaurantId)
      setMenuCategories(categories)
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

    // Check if has sub-categories
    const subcats = await getSubCategories(restaurantId, category.id)
    if (subcats.length > 0) {
      toast({
        title: 'Cannot Delete',
        description: `Cannot delete category "${category.name}" because it has ${subcats.length} sub-category/sub-categories. Delete sub-categories first.`,
        variant: 'destructive',
      })
      return
    }

    if (!confirm(`Delete category "${category.name}"? This cannot be undone.`)) return

    try {
      await deleteMenuCategory(category.id)
      toast({
        title: 'Success',
        description: `Category "${category.name}" deleted successfully`,
      })
      
      // Reload categories
      const categories = await getMenuCategories(restaurantId)
      setMenuCategories(categories)
      
      // Reset selection if deleted category was selected
      if (selectedMenuCategory?.id === category.id) {
        setSelectedMenuCategory(categories.length > 0 ? categories[0] : null)
      }
    } catch (err: any) {
      toast({
        title: 'Error',
        description: err.message || 'Failed to delete category',
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

    // Check if has menu items
    const items = await getMenuItemsBySubCategory(restaurantId, subCategory.id)
    if (items.length > 0) {
      toast({
        title: 'Cannot Delete',
        description: `Cannot delete sub-category "${subCategory.name}" because it has ${items.length} menu item(s). Delete items first.`,
        variant: 'destructive',
      })
      return
    }

    if (!confirm(`Delete sub-category "${subCategory.name}"? This cannot be undone.`)) return

    try {
      if (!subCategory.menu_category_id) {
        throw new Error('Sub-category is missing menu_category_id')
      }
      await deleteSubCategory(restaurantId, subCategory.menu_category_id, subCategory.id)
      toast({
        title: 'Success',
        description: `Sub-category "${subCategory.name}" deleted successfully`,
      })
      
      // Reload sub-categories
      if (selectedMenuCategory) {
        const subcats = await getSubCategories(restaurantId, selectedMenuCategory.id)
        const updatedAllSubcats = allSubCategories.filter(sc => sc.menu_category_id !== selectedMenuCategory.id)
        updatedAllSubcats.push(...subcats)
        setAllSubCategories(updatedAllSubcats)
      }
    } catch (err: any) {
      toast({
        title: 'Error',
        description: err.message || 'Failed to delete sub-category',
        variant: 'destructive',
      })
    }
  }

  // Menu Item handlers
  const handleAddItem = () => {
    if (!selectedMenuCategory || allSubCategories.length === 0) {
      toast({
        title: 'Error',
        description: 'Please select a category with sub-categories first',
        variant: 'destructive',
      })
      return
    }
    // If only one sub-category, use it; otherwise show sub-category selector
    if (allSubCategories.length === 1) {
      handleAddItemForSubCategory(allSubCategories[0])
    } else {
      // Open modal and let user select sub-category
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
        has_addons: false,
        addons: [],
        allow_special_instructions: true,
        status: 'available',
      })
      setEditingItem(null)
      setImagePreview(null)
      setShowItemModal(true)
    }
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
      has_addons: item.has_addons,
      addons: item.addons || [],
      allow_special_instructions: item.allow_special_instructions,
      status: item.status,
    })
    setImagePreview(item.image_url || null)
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

  const handleSaveItem = async () => {
    if (!restaurantId) return

    if (!itemForm.name || !itemForm.sub_category_id || !itemForm.base_price) {
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
        if (!editingItem.menu_category_id || !editingItem.sub_category_id) {
          throw new Error('Menu item missing category information')
        }
        
        await updateMenuItem(
          restaurantId,
          editingItem.menu_category_id,
          editingItem.sub_category_id,
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
          sub_category_id: itemForm.sub_category_id,
          name: itemForm.name,
          description: itemForm.description,
          image_url: imageUrl || undefined,
          base_price: price,
          imageFit: itemForm.imageFit,
          imagePosition: itemForm.imagePosition,
          has_sizes: itemForm.has_sizes,
          sizes: itemForm.sizes,
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
      // For delete, we need the full path - extract from item
      if (!item.menu_category_id || !item.sub_category_id) {
        throw new Error('Menu item missing category information')
      }
      
      await deleteMenuItem(
        restaurantId,
        item.menu_category_id,
        item.sub_category_id,
        item.id
      )
      toast({
        title: 'Success',
        description: 'Menu item deleted successfully',
      })
      
      // Reload all items
      const items = await getMenuItems(restaurantId)
      setAllMenuItems(items)
    } catch (err: any) {
      toast({
        title: 'Error',
        description: err.message || 'Failed to delete menu item',
        variant: 'destructive',
      })
    }
  }

  // Get all sub-categories for hierarchical dropdown
  const getAllSubCategories = async (): Promise<Array<{ id: string; name: string; menuCategoryName: string }>> => {
    if (!restaurantId) return []
    
    const allSubCategories: Array<{ id: string; name: string; menuCategoryName: string }> = []
    
    for (const menuCat of menuCategories) {
      try {
        const subcats = await getSubCategories(restaurantId, menuCat.id)
        subcats.forEach(subcat => {
          allSubCategories.push({
            id: subcat.id,
            name: subcat.name,
            menuCategoryName: menuCat.name,
          })
        })
      } catch (err) {
        console.warn(`Failed to load sub-categories for ${menuCat.name}:`, err)
      }
    }
    
    return allSubCategories
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
              <Button variant="ghost" size="icon" onClick={() => router.push('/')} className="h-11 w-11 sm:h-10 sm:w-10">
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
        <div className="flex gap-2 mb-4 sm:mb-6 overflow-x-auto pb-2 scrollbar-hide -mx-4 sm:mx-0 px-4 sm:px-0">
          <Button
            variant={selectedMenuCategory === null ? 'default' : 'outline'}
            onClick={() => handleSelectMenuCategory(null)}
            className={`${selectedMenuCategory === null ? 'bg-[#FF6B35] hover:bg-[#e55a28]' : ''} h-11 sm:h-10 text-sm sm:text-base whitespace-nowrap min-w-[100px] sm:min-w-0`}
          >
            All Items ({getCategoryItemCount(null)})
          </Button>
          {menuCategories.map((category) => (
            <div key={category.id} className="flex items-center gap-1 group flex-shrink-0">
              <Button
                variant={selectedMenuCategory?.id === category.id ? 'default' : 'outline'}
                onClick={() => handleSelectMenuCategory(category)}
                className={`${selectedMenuCategory?.id === category.id ? 'bg-[#FF6B35] hover:bg-[#e55a28]' : ''} h-11 sm:h-10 text-sm sm:text-base whitespace-nowrap`}
              >
                {category.name} ({getCategoryItemCount(category.id)})
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={(e) => {
                  e.stopPropagation()
                  handleDeleteMenuCategory(category)
                }}
                className="h-11 w-11 sm:h-8 sm:w-8 p-0 opacity-0 group-hover:opacity-100 sm:opacity-0 sm:group-hover:opacity-100 text-red-500 hover:text-red-700 hover:bg-red-50"
              >
                <X className="h-4 w-4" />
              </Button>
            </div>
          ))}
        </div>

        {/* Search Bar */}
        <div className="mb-4 sm:mb-6">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-muted-foreground" />
            <Input
              placeholder="Search menu items..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-10 h-11 sm:h-10 text-base sm:text-sm"
            />
          </div>
        </div>

        {/* Show All Items View */}
        {selectedMenuCategory === null && (
          <div className="space-y-8">
            {menuCategories.map((category) => {
              // Get all sub-categories for this category
              const categorySubcats = allSubCategories.filter(sc => sc.menu_category_id === category.id)
              
              // Group items by sub-category
              const categoryGrouped: Record<string, { subcategory: SubCategory; items: MenuItem[] }> = {}
              
              for (const subcat of categorySubcats) {
                const items = allMenuItems.filter(item => 
                  item.sub_category_id === subcat.id && 
                  item.menu_category_id === category.id &&
                  item.status !== 'hidden' &&
                  (!searchQuery || 
                    item.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
                    item.description?.toLowerCase().includes(searchQuery.toLowerCase()))
                )
                
                if (items.length > 0 || !searchQuery) {
                  categoryGrouped[subcat.id] = {
                    subcategory: subcat,
                    items: items.sort((a, b) => a.name.localeCompare(b.name))
                  }
                }
              }
              
              // Only show category if it has sub-categories with items (or if no search query)
              if (Object.keys(categoryGrouped).length === 0 && searchQuery) return null
              
              return (
                <div key={category.id} className="space-y-6">
                  <h2 className="text-xl sm:text-2xl font-bold">{category.name}</h2>
                  {Object.values(categoryGrouped).map(({ subcategory, items }) => (
                    <div key={subcategory.id} className="space-y-4">
                      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 sm:gap-0">
                        <h3 className="text-lg sm:text-xl font-semibold">
                          {subcategory.name} ({items.length} {items.length === 1 ? 'item' : 'items'})
                        </h3>
                        <div className="flex gap-2">
                          <Button
                            onClick={() => {
                              setSelectedMenuCategory(category)
                              handleAddItemForSubCategory(subcategory)
                            }}
                            className="bg-[#FF6B35] hover:bg-[#e55a28] w-full sm:w-auto h-11 sm:h-9 text-sm sm:text-sm"
                            size="sm"
                          >
                            <Plus className="h-4 w-4 mr-2" />
                            Add Item
                          </Button>
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => handleDeleteSubCategory(subcategory)}
                            className="h-11 sm:h-9 text-red-600 hover:text-red-700 hover:bg-red-50 border-red-200 w-full sm:w-auto"
                          >
                            <Trash2 className="h-4 w-4 mr-2" />
                            Delete
                          </Button>
                        </div>
                      </div>
                      {items.length > 0 ? (
                        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3 sm:gap-4">
                          {items.map((item) => (
                            <div
                              key={item.id}
                              className="bg-card border rounded-lg overflow-hidden hover:shadow-md transition-shadow"
                            >
                              <div className="relative w-full h-32 bg-gray-50 overflow-hidden">
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
                                      className="transition-opacity duration-300"
                                      onLoad={(e) => {
                                        e.currentTarget.style.opacity = '1'
                                        // Hide shimmer when image loads
                                        const container = e.currentTarget.closest('.relative')
                                        if (container) {
                                          const shimmer = container.querySelector('.image-shimmer')
                                          if (shimmer) {
                                            shimmer.classList.add('hidden')
                                          }
                                        }
                                      }}
                                      onError={(e) => {
                                        // Hide image on error, show placeholder
                                        e.currentTarget.style.display = 'none'
                                        const container = e.currentTarget.closest('.relative')
                                        if (container) {
                                          const placeholder = container.querySelector('.image-placeholder')
                                          const shimmer = container.querySelector('.image-shimmer')
                                          if (placeholder) {
                                            placeholder.classList.remove('hidden')
                                          }
                                          if (shimmer) {
                                            shimmer.classList.add('hidden')
                                          }
                                        }
                                      }}
                                    />
                                    {/* Shimmer effect while loading */}
                                    <div className="image-shimmer absolute inset-0 bg-gradient-to-r from-transparent via-white/30 to-transparent animate-shimmer pointer-events-none" />
                                  </>
                                ) : null}
                                {/* Food placeholder - shown when image fails or is missing */}
                                <div className={`image-placeholder absolute inset-0 flex items-center justify-center bg-gradient-to-br from-gray-100 to-gray-200 ${item.image_url ? 'hidden' : ''}`}>
                                  <div className="text-center">
                                    <UtensilsCrossed className="w-12 h-12 text-gray-400 mx-auto mb-1" />
                                    <p className="text-xs text-gray-500">No image</p>
                                  </div>
                                </div>
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
                                    item.status === 'available' 
                                      ? 'bg-green-100 text-green-800' 
                                      : 'bg-yellow-100 text-yellow-800'
                                  }`}>
                                    {item.status === 'available' ? '✓' : '⚠'}
                                  </span>
                                </div>
                              </div>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <p className="text-sm text-muted-foreground italic">No items in this sub-category</p>
                      )}
                    </div>
                  ))}
                  {categorySubcats.length === 0 && (
                    <p className="text-sm text-muted-foreground italic">No sub-categories in this category</p>
                  )}
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
            {Object.keys(groupedData).length === 0 ? (
              <div className="text-center py-8 sm:py-12 bg-card border rounded-lg px-4 sm:px-6">
                <div className="max-w-md mx-auto">
                  <div className="text-5xl sm:text-6xl mb-3 sm:mb-4">📁</div>
                  <h3 className="text-lg sm:text-xl font-semibold mb-2">No sub-categories yet</h3>
                  <p className="text-sm sm:text-base text-muted-foreground mb-4 sm:mb-6">
                    Create your first sub-category for "{selectedMenuCategory.name}"
                  </p>
                  <Button 
                    onClick={() => setShowSubCategoryModal(true)}
                    className="bg-[#FF6B35] hover:bg-[#e55a28] w-full sm:w-auto h-11 sm:h-10 text-sm sm:text-base px-6"
                  >
                    <Plus className="h-4 w-4 mr-2" />
                    Create First Sub-category
                  </Button>
                </div>
              </div>
            ) : (
              Object.values(groupedData).map(({ subcategory, items }) => {
                // Filter items by search query
                const filteredItems = items.filter(item => {
                  if (!searchQuery) return true
                  const query = searchQuery.toLowerCase()
                  return item.name.toLowerCase().includes(query) || 
                         item.description?.toLowerCase().includes(query)
                })
                
                return (
                  <div key={subcategory.id} className="space-y-4">
                    <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 sm:gap-0">
                      <h3 className="text-lg sm:text-xl font-semibold">
                        {subcategory.name} ({filteredItems.length} {filteredItems.length === 1 ? 'item' : 'items'})
                      </h3>
                      <div className="flex gap-2">
                        <Button
                          onClick={() => handleAddItemForSubCategory(subcategory)}
                          className="bg-[#FF6B35] hover:bg-[#e55a28] w-full sm:w-auto h-11 sm:h-9 text-sm sm:text-sm"
                          size="sm"
                        >
                          <Plus className="h-4 w-4 mr-2" />
                          Add Item
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => handleDeleteSubCategory(subcategory)}
                          className="h-11 sm:h-9 text-red-600 hover:text-red-700 hover:bg-red-50 border-red-200 w-full sm:w-auto"
                        >
                          <Trash2 className="h-4 w-4 mr-2" />
                          Delete
                        </Button>
                      </div>
                    </div>
                    {filteredItems.length > 0 ? (
                      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3 sm:gap-4">
                        {filteredItems.map((item) => (
                          <div
                            key={item.id}
                            className="bg-card border rounded-lg overflow-hidden hover:shadow-md transition-shadow"
                          >
                            <div className="relative w-full h-32 bg-gray-50 overflow-hidden">
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
                                    className="transition-opacity duration-300"
                                    onLoad={(e) => {
                                      e.currentTarget.style.opacity = '1'
                                      // Hide shimmer when image loads
                                      const container = e.currentTarget.closest('.relative')
                                      if (container) {
                                        const shimmer = container.querySelector('.image-shimmer')
                                        if (shimmer) {
                                          shimmer.classList.add('hidden')
                                        }
                                      }
                                    }}
                                    onError={(e) => {
                                      // Hide image on error, show placeholder
                                      e.currentTarget.style.display = 'none'
                                      const container = e.currentTarget.closest('.relative')
                                      if (container) {
                                        const placeholder = container.querySelector('.image-placeholder')
                                        const shimmer = container.querySelector('.image-shimmer')
                                        if (placeholder) {
                                          placeholder.classList.remove('hidden')
                                        }
                                        if (shimmer) {
                                          shimmer.classList.add('hidden')
                                        }
                                      }
                                    }}
                                  />
                                  {/* Shimmer effect while loading */}
                                  <div className="image-shimmer absolute inset-0 bg-gradient-to-r from-transparent via-white/30 to-transparent animate-shimmer pointer-events-none" />
                                </>
                              ) : null}
                              {/* Food placeholder - shown when image fails or is missing */}
                              <div className={`image-placeholder absolute inset-0 flex items-center justify-center bg-gradient-to-br from-gray-100 to-gray-200 ${item.image_url ? 'hidden' : ''}`}>
                                <div className="text-center">
                                  <UtensilsCrossed className="w-12 h-12 text-gray-400 mx-auto mb-1" />
                                  <p className="text-xs text-gray-500">No image</p>
                                </div>
                              </div>
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
                                  item.status === 'available' 
                                    ? 'bg-green-100 text-green-800' 
                                    : 'bg-yellow-100 text-yellow-800'
                                }`}>
                                  {item.status === 'available' ? '✓' : '⚠'}
                                </span>
                              </div>
                            </div>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <p className="text-sm text-muted-foreground italic">
                        {searchQuery ? `No items match "${searchQuery}"` : 'No items in this sub-category'}
                      </p>
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

      {/* Create Sub-Category Modal */}
      <Dialog open={showSubCategoryModal} onOpenChange={setShowSubCategoryModal}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create Sub-category</DialogTitle>
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

      {/* Add/Edit Menu Item Modal */}
      <Dialog open={showItemModal} onOpenChange={setShowItemModal}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{editingItem ? 'Edit Menu Item' : 'Add Menu Item'}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <Label>Sub-category *</Label>
              <SubCategorySelect
                restaurantId={restaurantId || ''}
                menuCategories={menuCategories}
                value={itemForm.sub_category_id}
                onChange={(value) => setItemForm({ ...itemForm, sub_category_id: value })}
              />
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
  restaurantId, 
  menuCategories, 
  value, 
  onChange 
}: { 
  restaurantId: string
  menuCategories: MenuCategory[]
  value: string
  onChange: (value: string) => void
}) {
  // Get user from auth context to ensure component has access to it
  const { user } = useAuth()
  const [subCategories, setSubCategories] = useState<Array<{ id: string; name: string; menuCategoryName: string }>>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const loadSubCategories = async () => {
      // Don't run if user is null (prevents fetching when signed out)
      if (!user) {
        setLoading(false)
        return
      }

      if (!restaurantId || menuCategories.length === 0) {
        setLoading(false)
        return
      }

      try {
        const allSubCategories: Array<{ id: string; name: string; menuCategoryName: string }> = []
        
        for (const menuCat of menuCategories) {
          try {
            const subcats = await getSubCategories(restaurantId, menuCat.id)
            subcats.forEach(subcat => {
              allSubCategories.push({
                id: subcat.id,
                name: subcat.name,
                menuCategoryName: menuCat.name,
              })
            })
          } catch (err) {
            console.warn(`Failed to load sub-categories for ${menuCat.name}:`, err)
          }
        }
        
        setSubCategories(allSubCategories)
      } catch (err) {
        console.error('Error loading sub-categories:', err)
      } finally {
        setLoading(false)
      }
    }

    loadSubCategories()
  }, [user, restaurantId, menuCategories])

  if (loading) {
    return <div className="text-sm text-muted-foreground">Loading sub-categories...</div>
  }

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

