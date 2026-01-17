'use client'

import { useEffect, useState } from 'react'
import { useAuth } from '@/components/auth/auth-provider'
import { getCategories, createCategory, createDefaultCategories, deleteCategory, deleteAllCategories, removeDuplicateCategories, Category } from '@/lib/firebase/categories'
import { getMenuItems, createMenuItem, updateMenuItem, deleteMenuItem, removeDuplicateMenuItems, MenuItem } from '@/lib/firebase/menu-items'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { ArrowLeft, Plus, Search, Edit, Trash2, X } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { useToast } from '@/hooks/use-toast'
import Image from 'next/image'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { Checkbox } from '@/components/ui/checkbox'

export function MenuManagement() {
  const { user, restaurantId } = useAuth()
  const router = useRouter()
  const { toast } = useToast()
  const [categories, setCategories] = useState<Category[]>([])
  const [menuItems, setMenuItems] = useState<MenuItem[]>([])
  const [selectedCategory, setSelectedCategory] = useState<string | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [loading, setLoading] = useState(true)
  const [showItemModal, setShowItemModal] = useState(false)
  const [editingItem, setEditingItem] = useState<MenuItem | null>(null)
  const [creatingCategories, setCreatingCategories] = useState(false)
  const [showCategoryModal, setShowCategoryModal] = useState(false)
  const [newCategoryName, setNewCategoryName] = useState('')

  // Debug category modal state
  useEffect(() => {
    console.log('showCategoryModal state changed to:', showCategoryModal)
  }, [showCategoryModal])

  // Debug modal state
  useEffect(() => {
    console.log('showItemModal state changed to:', showItemModal)
  }, [showItemModal])

  // Form state
  const [formData, setFormData] = useState({
    name: '',
    description: '',
    category_id: '',
    base_price: '',
    image_url: '',
    has_sizes: false,
    sizes: [] as Array<{ name: string; price_modifier: number }>,
    has_addons: false,
    addons: [] as Array<{ name: string; price: number }>,
    allow_special_instructions: true,
    status: 'available' as 'available' | 'out_of_stock' | 'hidden',
  })

  useEffect(() => {
    // Don't run if user is null (prevents fetching when signed out)
    if (!user) {
      setLoading(false)
      return
    }

    if (!restaurantId) {
      console.warn('MenuManagement: restaurantId is missing')
      setLoading(false)
      return
    }

    const loadData = async () => {
      try {
        setLoading(true)
        console.log('Loading categories and menu items for restaurant:', restaurantId)
        
        // Load categories and menu items separately to handle index errors gracefully
        let categoriesData: Category[] = []
        let itemsData: MenuItem[] = []
        
        try {
          categoriesData = await getCategories(restaurantId)
          console.log('Categories loaded:', categoriesData.length)
        } catch (catError: any) {
          console.warn('Could not load categories (index may not exist):', catError)
          // Categories will be empty array, which is handled below
        }
        
        try {
          itemsData = await getMenuItems(restaurantId)
          console.log('Menu items loaded:', itemsData.length)
        } catch (itemError: any) {
          console.warn('Could not load menu items:', itemError)
          // Menu items will be empty array
        }
        
        setCategories(categoriesData)
        setMenuItems(itemsData)
        
        if (categoriesData.length > 0 && !selectedCategory) {
          setSelectedCategory(categoriesData[0].id)
          console.log('Selected first category:', categoriesData[0].name)
        } else if (categoriesData.length === 0) {
          console.warn('No categories found for restaurant:', restaurantId)
          // Don't show error toast if it's just because index doesn't exist
          // The empty state UI will handle this
        }
      } catch (err: any) {
        console.error('Error loading menu data:', err)
        // Only show error if it's not an index error (those are handled above)
        if (err?.code !== 'failed-precondition') {
          toast({
            title: 'Error',
            description: err.message || 'Failed to load menu data',
            variant: 'destructive',
          })
        }
      } finally {
        setLoading(false)
      }
    }

    loadData()
  }, [user, restaurantId, toast])

  useEffect(() => {
    // Don't run if user is null (prevents fetching when signed out)
    if (!user) return

    if (!restaurantId || !selectedCategory) return

    const loadItems = async () => {
      try {
        const items = await getMenuItems(restaurantId, selectedCategory)
        setMenuItems(items)
      } catch (err: any) {
        console.error('Failed to load menu items:', err)
      }
    }

    loadItems()
  }, [user, restaurantId, selectedCategory])

  const filteredItems = menuItems.filter(item => {
    if (searchQuery) {
      return item.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
             item.description?.toLowerCase().includes(searchQuery.toLowerCase())
    }
    return true
  })

  const handleAddItem = () => {
    console.log('Add Item button clicked')
    console.log('Categories available:', categories.length)
    console.log('Selected category:', selectedCategory)
    console.log('Current showItemModal state:', showItemModal)
    
    if (categories.length === 0) {
      console.warn('No categories loaded, but opening modal anyway')
      toast({
        title: 'Warning',
        description: 'Categories are still loading. You can still add an item, but you\'ll need to select a category once they load.',
        variant: 'default',
      })
    }
    
    setEditingItem(null)
    const defaultCategoryId = selectedCategory || categories[0]?.id || ''
    console.log('Opening add item modal with category:', defaultCategoryId)
    
    setFormData({
      name: '',
      description: '',
      category_id: defaultCategoryId,
      base_price: '',
      image_url: '',
      has_sizes: false,
      sizes: [],
      has_addons: false,
      addons: [],
      allow_special_instructions: true,
      status: 'available',
    })
    
    console.log('Setting showItemModal to true')
    setShowItemModal(true)
    console.log('Modal state set, should open now')
  }

  const handleEditItem = (item: MenuItem) => {
    setEditingItem(item)
    setFormData({
      name: item.name,
      description: item.description || '',
      category_id: item.category_id,
      base_price: item.base_price.toString(),
      image_url: item.image_url || '',
      has_sizes: item.has_sizes,
      sizes: item.sizes || [],
      has_addons: item.has_addons,
      addons: item.addons || [],
      allow_special_instructions: item.allow_special_instructions,
      status: item.status,
    })
    setShowItemModal(true)
  }

  const handleSaveItem = async () => {
    if (!restaurantId) {
      toast({
        title: 'Error',
        description: 'Restaurant ID is missing. Please sign in again.',
        variant: 'destructive',
      })
      return
    }

    try {
      console.log('Saving menu item with data:', {
        name: formData.name,
        category_id: formData.category_id,
        base_price: formData.base_price,
        restaurant_id: restaurantId,
      })

      if (!formData.name || !formData.category_id || !formData.base_price) {
        const missingFields = []
        if (!formData.name) missingFields.push('Item Name')
        if (!formData.category_id) missingFields.push('Category')
        if (!formData.base_price) missingFields.push('Price')
        
        toast({
          title: 'Validation Error',
          description: `Please fill in: ${missingFields.join(', ')}`,
          variant: 'destructive',
        })
        return
      }

      const price = parseFloat(formData.base_price)
      if (isNaN(price) || price <= 0) {
        toast({
          title: 'Validation Error',
          description: 'Please enter a valid price greater than 0',
          variant: 'destructive',
        })
        return
      }

      const itemData = {
        restaurant_id: restaurantId,
        category_id: formData.category_id,
        name: formData.name,
        description: formData.description,
        image_url: formData.image_url || undefined,
        base_price: price,
        has_sizes: formData.has_sizes,
        sizes: formData.sizes,
        has_addons: formData.has_addons,
        addons: formData.addons,
        allow_special_instructions: formData.allow_special_instructions,
        status: formData.status,
      }

      console.log('Creating menu item:', itemData)

      let itemId: string
      if (editingItem) {
        await updateMenuItem(editingItem.id, itemData)
        itemId = editingItem.id
        toast({
          title: 'Success',
          description: 'Menu item updated successfully',
        })
      } else {
        try {
          itemId = await createMenuItem(itemData)
          console.log('Menu item created with ID:', itemId)
          toast({
            title: 'Success',
            description: 'Menu item created successfully',
          })
        } catch (createError: any) {
          // Check if it's a duplicate error
          if (createError.message?.includes('already exists')) {
            toast({
              title: 'Duplicate Item',
              description: createError.message,
              variant: 'destructive',
            })
          } else {
            throw createError
          }
          return
        }
      }

      // Try to reload items, but handle missing index gracefully
      try {
        const items = await getMenuItems(restaurantId, selectedCategory)
        console.log('Menu items reloaded:', items.length)
        setMenuItems(items)
      } catch (reloadError: any) {
        console.warn('Could not reload menu items (index may not exist yet):', reloadError)
        // If we created a new item, add it to local state
        if (!editingItem) {
          const newItem: MenuItem = {
            id: itemId,
            restaurant_id: restaurantId,
            category_id: formData.category_id,
            name: formData.name,
            description: formData.description || '',
            image_url: formData.image_url || null,
            base_price: price,
            has_sizes: formData.has_sizes,
            sizes: formData.sizes,
            has_addons: formData.has_addons,
            addons: formData.addons,
            allow_special_instructions: formData.allow_special_instructions,
            status: formData.status,
            times_ordered: 0,
            total_revenue: 0,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          }
          // Add item to local state if it belongs to the selected category
          // If it belongs to a different category, switch to that category and add it
          if (!selectedCategory || newItem.category_id === selectedCategory) {
            setMenuItems([...menuItems, newItem])
            console.log('Menu item added to local state. Total items:', menuItems.length + 1)
          } else {
            // Item belongs to different category - switch to that category and add it
            console.log('Menu item belongs to different category, switching to that category')
            setSelectedCategory(newItem.category_id)
            setMenuItems([newItem]) // Start fresh with just this item for the new category
            console.log('Switched to category and added item')
          }
        } else {
          // If editing, update local state
          const updatedItems = menuItems.map(item => 
            item.id === itemId ? { 
              ...item, 
              ...itemData,
              updated_at: new Date().toISOString(),
            } : item
          )
          setMenuItems(updatedItems)
          console.log('Menu item updated in local state')
        }
      }
      
      setShowItemModal(false)
      
      // Reset form
      setFormData({
        name: '',
        description: '',
        category_id: selectedCategory || categories[0]?.id || '',
        base_price: '',
        image_url: '',
        has_sizes: false,
        sizes: [],
        has_addons: false,
        addons: [],
        allow_special_instructions: true,
        status: 'available',
      })
    } catch (err: any) {
      console.error('Error saving menu item:', err)
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
      await deleteMenuItem(item.id)
      toast({
        title: 'Success',
        description: 'Menu item deleted',
      })
      const items = await getMenuItems(restaurantId, selectedCategory)
      setMenuItems(items)
    } catch (err: any) {
      toast({
        title: 'Error',
        description: err.message || 'Failed to delete menu item',
        variant: 'destructive',
      })
    }
  }

  const handleToggleStatus = async (item: MenuItem) => {
    try {
      const newStatus = item.status === 'available' ? 'out_of_stock' : 'available'
      await updateMenuItem(item.id, { status: newStatus })
      const items = await getMenuItems(restaurantId, selectedCategory)
      setMenuItems(items)
    } catch (err: any) {
      toast({
        title: 'Error',
        description: 'Failed to update status',
        variant: 'destructive',
      })
    }
  }

  const handleCreateCategory = async () => {
    if (!restaurantId || !newCategoryName.trim()) {
      toast({
        title: 'Validation Error',
        description: 'Please enter a category name',
        variant: 'destructive',
      })
      return
    }

    const categoryName = newCategoryName.trim()
    
    try {
      // Get the highest display_order and add 1
      const maxOrder = categories.length > 0 
        ? Math.max(...categories.map(c => c.display_order))
        : 0

      console.log('Creating category:', categoryName, 'with order:', maxOrder + 1)
      
      // Create category in Firestore
      const categoryId = await createCategory({
        restaurant_id: restaurantId,
        name: categoryName,
        display_order: maxOrder + 1,
        active: true,
      })

      console.log('Category created with ID:', categoryId)

      // Create category object for local state
      const newCat: Category = {
        id: categoryId,
        restaurant_id: restaurantId,
        name: categoryName,
        display_order: maxOrder + 1,
        active: true,
        created_at: new Date().toISOString(),
      }

      // Update local state immediately (don't wait for reload)
      const updatedCategories = [...categories, newCat].sort((a, b) => a.display_order - b.display_order)
      setCategories(updatedCategories)
      setSelectedCategory(categoryId)
      
      console.log('Category added to local state. Total categories:', updatedCategories.length)

      toast({
        title: 'Success',
        description: `Category "${categoryName}" created successfully`,
      })

      // Try to reload categories from Firestore (in case index exists)
      try {
        const categoriesData = await getCategories(restaurantId)
        if (categoriesData.length > 0) {
          console.log('Categories reloaded from Firestore:', categoriesData.length)
          setCategories(categoriesData)
          // Keep the newly created category selected
          const newCategory = categoriesData.find(c => c.id === categoryId || c.name === categoryName)
          if (newCategory) {
            setSelectedCategory(newCategory.id)
          } else if (categoriesData.length > 0) {
            setSelectedCategory(categoriesData[categoriesData.length - 1].id)
          }
        }
      } catch (reloadError: any) {
        console.warn('Could not reload categories from Firestore (index may not exist yet):', reloadError)
        console.log('Using local state instead. Category is saved in Firestore and will appear once index is created.')
        // Local state is already updated above, so we're good
      }

      setNewCategoryName('')
      setShowCategoryModal(false)
    } catch (err: any) {
      console.error('Error creating category:', err)
      // Check if it's a duplicate error
      if (err.message?.includes('already exists')) {
        toast({
          title: 'Category Already Exists',
          description: err.message,
          variant: 'destructive',
        })
      } else {
        toast({
          title: 'Error',
          description: err.message || 'Failed to create category',
          variant: 'destructive',
        })
      }
    }
  }

  const handleDeleteCategory = async (category: Category) => {
    if (!restaurantId) return

    // Check if category has items
    const itemsInCategory = menuItems.filter(item => item.category_id === category.id)
    
    if (itemsInCategory.length > 0) {
      const confirmMessage = `Category "${category.name}" has ${itemsInCategory.length} item(s). Deleting it will remove the category from all items. Are you sure you want to delete it?`
      if (!confirm(confirmMessage)) return
    } else {
      if (!confirm(`Delete category "${category.name}"? This cannot be undone.`)) return
    }

    try {
      await deleteCategory(category.id)
      
      toast({
        title: 'Success',
        description: `Category "${category.name}" deleted successfully`,
      })

      // Reload categories
      try {
        const categoriesData = await getCategories(restaurantId)
        setCategories(categoriesData)
        
        // If deleted category was selected, select first available category
        if (selectedCategory === category.id) {
          if (categoriesData.length > 0) {
            setSelectedCategory(categoriesData[0].id)
          } else {
            setSelectedCategory(null)
          }
        }
      } catch (reloadError: any) {
        console.warn('Could not reload categories (index may not exist yet):', reloadError)
        // Remove from local state anyway
        setCategories(categories.filter(c => c.id !== category.id))
        if (selectedCategory === category.id) {
          const remaining = categories.filter(c => c.id !== category.id)
          if (remaining.length > 0) {
            setSelectedCategory(remaining[0].id)
          } else {
            setSelectedCategory(null)
          }
        }
      }
    } catch (err: any) {
      toast({
        title: 'Error',
        description: err.message || 'Failed to delete category',
        variant: 'destructive',
      })
    }
  }

  const handleDeleteAllCategories = async () => {
    if (!restaurantId) return

    // Check if any categories have items
    const categoriesWithItems = categories.filter(cat => {
      const itemsInCategory = menuItems.filter(item => item.category_id === cat.id)
      return itemsInCategory.length > 0
    })

    let confirmMessage = `Are you sure you want to delete ALL ${categories.length} category/categories?`
    if (categoriesWithItems.length > 0) {
      const totalItems = categoriesWithItems.reduce((sum, cat) => {
        return sum + menuItems.filter(item => item.category_id === cat.id).length
      }, 0)
      confirmMessage += `\n\nWARNING: ${categoriesWithItems.length} category/categories have ${totalItems} menu item(s). Deleting them will remove the category from all items.`
    }
    confirmMessage += '\n\nThis action cannot be undone!'

    if (!confirm(confirmMessage)) return

    try {
      const deletedCount = await deleteAllCategories(restaurantId)
      
      toast({
        title: 'Success',
        description: `Successfully deleted ${deletedCount} category/categories`,
      })

      // Clear local state
      setCategories([])
      setSelectedCategory(null)

      // Try to reload (should return empty, but good to sync)
      try {
        const categoriesData = await getCategories(restaurantId)
        setCategories(categoriesData)
      } catch (reloadError: any) {
        console.warn('Could not reload categories:', reloadError)
        // Already cleared local state, so we're good
      }
    } catch (err: any) {
      toast({
        title: 'Error',
        description: err.message || 'Failed to delete categories',
        variant: 'destructive',
      })
    }
  }

  const handleRemoveDuplicates = async () => {
    if (!restaurantId) return

    if (!confirm('This will remove duplicate categories and menu items. The first occurrence of each will be kept. Continue?')) {
      return
    }

    try {
      // Remove duplicate categories
      const categoryResult = await removeDuplicateCategories(restaurantId)
      
      // Remove duplicate menu items
      const menuItemResult = await removeDuplicateMenuItems(restaurantId)

      let message = ''
      if (categoryResult.removed > 0) {
        message += `Removed ${categoryResult.removed} duplicate category/categories. `
        if (categoryResult.duplicates.length > 0) {
          const dupNames = categoryResult.duplicates.map(d => `${d.name} (${d.count} total)`).join(', ')
          message += `Duplicates found: ${dupNames}. `
        }
      }
      
      if (menuItemResult.removed > 0) {
        message += `Removed ${menuItemResult.removed} duplicate menu item(s). `
        if (menuItemResult.duplicates.length > 0) {
          const dupNames = menuItemResult.duplicates.map(d => `${d.name} (${d.count} total)`).join(', ')
          message += `Duplicates found: ${dupNames}. `
        }
      }

      if (categoryResult.removed === 0 && menuItemResult.removed === 0) {
        toast({
          title: 'No Duplicates Found',
          description: 'No duplicate categories or menu items were found.',
        })
      } else {
        toast({
          title: 'Duplicates Removed',
          description: message || 'Duplicates have been removed successfully.',
        })
      }

      // Reload data
      try {
        const [categoriesData, itemsData] = await Promise.all([
          getCategories(restaurantId),
          getMenuItems(restaurantId, selectedCategory)
        ])
        setCategories(categoriesData)
        setMenuItems(itemsData)
      } catch (reloadError: any) {
        console.warn('Could not reload data after cleanup:', reloadError)
      }
    } catch (err: any) {
      toast({
        title: 'Error',
        description: err.message || 'Failed to remove duplicates',
        variant: 'destructive',
      })
    }
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-muted/30 flex items-center justify-center">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-[#FF6B35]"></div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-muted/30">
      {/* Header */}
      <header className="bg-card border-b border-border">
        <div className="container mx-auto px-6 py-6 flex items-center justify-between">
          <div className="flex items-center gap-4">
            <Button variant="ghost" size="icon" onClick={() => router.push('/')}>
              <ArrowLeft className="h-5 w-5" />
            </Button>
            <h1 className="text-3xl font-bold">Menu Management</h1>
          </div>
          <Button 
            type="button"
            onClick={(e) => {
              e.preventDefault()
              e.stopPropagation()
              console.log('Add Item button clicked (header)')
              handleAddItem()
            }} 
            className="bg-[#FF6B35] hover:bg-[#e55a28]"
          >
            <Plus className="h-4 w-4 mr-2" />
            Add Item
          </Button>
        </div>
      </header>

      <div className="container mx-auto px-6 py-6">
        {/* Category Tabs */}
        <div className="flex gap-2 mb-6 overflow-x-auto items-center">
          {categories.map((category) => (
            <div key={category.id} className="flex items-center gap-1 group">
              <Button
                variant={selectedCategory === category.id ? 'default' : 'outline'}
                onClick={() => setSelectedCategory(category.id)}
                className={selectedCategory === category.id ? 'bg-[#FF6B35] hover:bg-[#e55a28]' : ''}
              >
                {category.name} ({menuItems.filter(i => i.category_id === category.id).length})
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => handleDeleteCategory(category)}
                className="opacity-0 group-hover:opacity-100 transition-opacity h-8 w-8 p-0 text-red-500 hover:text-red-700 hover:bg-red-50"
                title={`Delete ${category.name}`}
              >
                <X className="h-4 w-4" />
              </Button>
            </div>
          ))}
          <Button
            type="button"
            variant="outline"
            onClick={(e) => {
              e.preventDefault()
              e.stopPropagation()
              console.log('Add Category button clicked')
              console.log('Current showCategoryModal state:', showCategoryModal)
              setShowCategoryModal(true)
              console.log('Set showCategoryModal to true')
            }}
            className="border-dashed"
            title="Add new category"
          >
            <Plus className="h-4 w-4 mr-2" />
            Add Category
          </Button>
          {categories.length > 0 && (
            <>
              <Button
                type="button"
                variant="outline"
                onClick={handleDeleteAllCategories}
                className="border-red-300 text-red-600 hover:bg-red-50 hover:text-red-700"
                title="Delete all categories"
              >
                <Trash2 className="h-4 w-4 mr-2" />
                Delete All
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={handleRemoveDuplicates}
                className="border-blue-300 text-blue-600 hover:bg-blue-50 hover:text-blue-700"
                title="Remove duplicate categories and menu items"
              >
                <Trash2 className="h-4 w-4 mr-2" />
                Remove Duplicates
              </Button>
            </>
          )}
        </div>

        {/* Search */}
        <div className="mb-6">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-muted-foreground" />
            <Input
              placeholder="Search menu items..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-10"
            />
          </div>
        </div>

        {/* Empty State */}
        {!loading && filteredItems.length === 0 && (
          <div className="text-center py-12 bg-card border rounded-lg">
            <div className="max-w-md mx-auto">
              <div className="text-6xl mb-4">🍽️</div>
              <h3 className="text-xl font-semibold mb-2">No menu items yet</h3>
              {categories.length === 0 ? (
                <>
                  <p className="text-muted-foreground mb-4">
                    Categories are missing. Create default categories or add your own custom category.
                  </p>
                  <div className="flex gap-3 justify-center">
                    <Button 
                      type="button"
                      variant="outline"
                      onClick={(e) => {
                        e.preventDefault()
                        e.stopPropagation()
                        console.log('Add Category button clicked (empty state)')
                        setShowCategoryModal(true)
                      }}
                      className="border-dashed"
                    >
                      <Plus className="h-4 w-4 mr-2" />
                      Add Custom Category
                    </Button>
                    <Button 
                      type="button"
                      disabled={creatingCategories || !restaurantId}
                      onClick={async (e) => {
                      e.preventDefault()
                      e.stopPropagation()
                      
                      console.log('=== CREATE CATEGORIES BUTTON CLICKED ===')
                      console.log('Timestamp:', new Date().toISOString())
                      console.log('Restaurant ID:', restaurantId)
                      console.log('Creating categories state:', creatingCategories)
                      
                      if (!restaurantId) {
                        console.error('❌ Restaurant ID is missing')
                        toast({
                          title: 'Error',
                          description: 'Restaurant ID is missing',
                          variant: 'destructive',
                        })
                        return
                      }
                      
                      setCreatingCategories(true)
                      console.log('✅ Starting category creation process...')
                      
                      try {
                        console.log('📝 Calling createDefaultCategories with restaurantId:', restaurantId)
                        await createDefaultCategories(restaurantId)
                        console.log('✅ Categories created successfully in Firestore')
                        
                        toast({
                          title: 'Success',
                          description: 'Default categories created successfully! Check Firebase Console to verify. You still need to create the Firestore index to view them here.',
                        })
                        
                        // Try to reload categories, but don't fail if index doesn't exist yet
                        try {
                          console.log('🔄 Attempting to reload categories...')
                          const categoriesData = await getCategories(restaurantId)
                          console.log('✅ Categories reloaded:', categoriesData.length)
                          setCategories(categoriesData)
                          if (categoriesData.length > 0) {
                            setSelectedCategory(categoriesData[0].id)
                          }
                        } catch (reloadError: any) {
                          console.warn('⚠️ Could not reload categories (index may not exist yet):', reloadError)
                          console.log('This is expected if the Firestore index has not been created yet.')
                          // Don't show error - categories were created, just can't view them yet
                        }
                      } catch (err: any) {
                        console.error('❌ Error creating categories:', err)
                        console.error('Error details:', {
                          message: err.message,
                          code: err.code,
                          stack: err.stack
                        })
                        toast({
                          title: 'Error',
                          description: err.message || 'Failed to create categories. Check console for details.',
                          variant: 'destructive',
                        })
                      } finally {
                        setCreatingCategories(false)
                        console.log('🏁 Category creation process finished')
                      }
                    }}
                    className="bg-[#FF6B35] hover:bg-[#e55a28] disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    <Plus className="h-4 w-4 mr-2" />
                    {creatingCategories ? 'Creating Categories...' : 'Create Default Categories'}
                  </Button>
                  </div>
                  <p className="text-xs text-muted-foreground mt-4">
                    Default categories: Starters, Mains, Drinks, Desserts
                  </p>
                </>
              ) : (
                <>
                  <p className="text-muted-foreground mb-6">
                    {searchQuery 
                      ? `No items match "${searchQuery}"`
                      : selectedCategory
                      ? `No items in ${categories.find(c => c.id === selectedCategory)?.name || 'this category'} yet. Create your first menu item!`
                      : 'Create your first menu item to get started.'
                    }
                  </p>
                  {!searchQuery && (
                    <Button 
                      type="button"
                      onClick={(e) => {
                        e.preventDefault()
                        e.stopPropagation()
                        console.log('Create First Menu Item button clicked')
                        handleAddItem()
                      }} 
                      className="bg-[#FF6B35] hover:bg-[#e55a28]"
                    >
                      <Plus className="h-4 w-4 mr-2" />
                      Create First Menu Item
                    </Button>
                  )}
                </>
              )}
            </div>
          </div>
        )}

        {/* Menu Items Grid */}
        {filteredItems.length > 0 && (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {filteredItems.map((item) => (
            <div
              key={item.id}
              className="bg-card border rounded-lg overflow-hidden hover:shadow-md transition-shadow"
            >
              {item.image_url && (
                <div className="relative w-full h-48">
                  <Image
                    src={item.image_url}
                    alt={item.name}
                    fill
                    className="object-cover"
                  />
                </div>
              )}
              <div className="p-4">
                <div className="flex items-start justify-between mb-2">
                  <h3 className="font-semibold text-lg">{item.name}</h3>
                  <div className="flex gap-2">
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => handleEditItem(item)}
                    >
                      <Edit className="h-4 w-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => handleDeleteItem(item)}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
                <p className="text-sm text-muted-foreground mb-2 line-clamp-2">
                  {item.description}
                </p>
                <div className="flex items-center justify-between">
                  <span className="text-lg font-bold text-[#FF6B35]">
                    N${item.base_price.toFixed(2)}
                  </span>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => handleToggleStatus(item)}
                  >
                    {item.status === 'available' ? 'Available' : 'Out of Stock'}
                  </Button>
                </div>
              </div>
            </div>
          ))}
          </div>
        )}
      </div>

      {/* Add/Edit Item Modal */}
      <Dialog 
        open={showItemModal} 
        onOpenChange={(open) => {
          console.log('Dialog onOpenChange called with:', open)
          setShowItemModal(open)
        }}
      >
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{editingItem ? 'Edit Menu Item' : 'Add Menu Item'}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <Label>Item Name *</Label>
              <Input
                value={formData.name}
                onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                placeholder="e.g., Grilled Chicken Breast"
              />
            </div>
            <div>
              <Label>Description</Label>
              <Textarea
                value={formData.description}
                onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                placeholder="Describe the item..."
                rows={3}
              />
            </div>
            <div>
              <Label>Category *</Label>
              {categories.length === 0 ? (
                <div className="p-3 bg-yellow-50 border border-yellow-200 rounded-md">
                  <p className="text-sm text-yellow-800">
                    No categories available. Please refresh the page or check if categories were created during signup.
                  </p>
                </div>
              ) : (
                <>
                  <Select
                    value={formData.category_id || undefined}
                    onValueChange={(value) => {
                      console.log('Category selected:', value)
                      setFormData({ ...formData, category_id: value })
                    }}
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue placeholder="Select category" />
                    </SelectTrigger>
                    <SelectContent>
                      {categories.map((cat) => (
                        <SelectItem key={cat.id} value={cat.id}>
                          {cat.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {formData.category_id && (
                    <p className="text-xs text-gray-500 mt-1">
                      Selected: {categories.find(c => c.id === formData.category_id)?.name}
                    </p>
                  )}
                </>
              )}
            </div>
            <div>
              <Label>Price (N$) *</Label>
              <Input
                type="number"
                step="0.01"
                value={formData.base_price}
                onChange={(e) => setFormData({ ...formData, base_price: e.target.value })}
                placeholder="145.00"
              />
            </div>
            <div>
              <Label>Image URL</Label>
              <Input
                value={formData.image_url}
                onChange={(e) => setFormData({ ...formData, image_url: e.target.value })}
                placeholder="https://..."
              />
            </div>
            <div>
              <Label>Status</Label>
              <RadioGroup
                value={formData.status}
                onValueChange={(value) => setFormData({ ...formData, status: value as any })}
              >
                <div className="flex items-center space-x-2">
                  <RadioGroupItem value="available" id="available" />
                  <Label htmlFor="available">Available</Label>
                </div>
                <div className="flex items-center space-x-2">
                  <RadioGroupItem value="out_of_stock" id="out_of_stock" />
                  <Label htmlFor="out_of_stock">Out of Stock</Label>
                </div>
                <div className="flex items-center space-x-2">
                  <RadioGroupItem value="hidden" id="hidden" />
                  <Label htmlFor="hidden">Hidden (Draft)</Label>
                </div>
              </RadioGroup>
            </div>
            <div className="flex items-center space-x-2">
              <Checkbox
                id="allow_instructions"
                checked={formData.allow_special_instructions}
                onCheckedChange={(checked) =>
                  setFormData({ ...formData, allow_special_instructions: checked as boolean })
                }
              />
              <Label htmlFor="allow_instructions">Allow special instructions</Label>
            </div>
            <div className="flex gap-4">
              <Button
                variant="outline"
                onClick={() => setShowItemModal(false)}
                className="flex-1"
              >
                Cancel
              </Button>
              <Button
                type="button"
                onClick={handleSaveItem}
                className="flex-1 bg-[#FF6B35] hover:bg-[#e55a28]"
                disabled={!formData.category_id || categories.length === 0}
              >
                {editingItem ? 'Update' : 'Create'} Item
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Add Category Modal */}
      <Dialog 
        open={showCategoryModal} 
        onOpenChange={(open) => {
          console.log('Category Dialog onOpenChange called with:', open)
          setShowCategoryModal(open)
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Add New Category</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <Label>Category Name *</Label>
              <Input
                value={newCategoryName}
                onChange={(e) => setNewCategoryName(e.target.value)}
                placeholder="e.g., Appetizers, Salads, Beverages"
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    handleCreateCategory()
                  }
                }}
                autoFocus
              />
            </div>
            <div className="flex gap-4">
              <Button
                variant="outline"
                onClick={() => {
                  setNewCategoryName('')
                  setShowCategoryModal(false)
                }}
                className="flex-1"
              >
                Cancel
              </Button>
              <Button
                onClick={handleCreateCategory}
                className="flex-1 bg-[#FF6B35] hover:bg-[#e55a28]"
                disabled={!newCategoryName.trim()}
              >
                Create Category
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
