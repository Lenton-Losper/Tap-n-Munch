'use client'

import { useEffect, useState } from 'react'
import { useAuth } from '@/components/auth/auth-provider'
import { getCategories, createCategory, Category } from '@/lib/firebase/categories'
import { getMenuItems, createMenuItem, updateMenuItem, deleteMenuItem, MenuItem } from '@/lib/firebase/menu-items'
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
  const { user } = useAuth()
  const router = useRouter()
  const { toast } = useToast()
  const [categories, setCategories] = useState<Category[]>([])
  const [menuItems, setMenuItems] = useState<MenuItem[]>([])
  const [selectedCategory, setSelectedCategory] = useState<string | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [loading, setLoading] = useState(true)
  const [showItemModal, setShowItemModal] = useState(false)
  const [editingItem, setEditingItem] = useState<MenuItem | null>(null)

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
    if (!user) return

    const loadData = async () => {
      try {
        setLoading(true)
        const [categoriesData, itemsData] = await Promise.all([
          getCategories(user.uid),
          getMenuItems(user.uid),
        ])
        setCategories(categoriesData)
        setMenuItems(itemsData)
        
        if (categoriesData.length > 0 && !selectedCategory) {
          setSelectedCategory(categoriesData[0].id)
        }
      } catch (err: any) {
        toast({
          title: 'Error',
          description: err.message || 'Failed to load menu data',
          variant: 'destructive',
        })
      } finally {
        setLoading(false)
      }
    }

    loadData()
  }, [user, toast])

  useEffect(() => {
    if (!user || !selectedCategory) return

    const loadItems = async () => {
      try {
        const items = await getMenuItems(user.uid, selectedCategory)
        setMenuItems(items)
      } catch (err: any) {
        console.error('Failed to load menu items:', err)
      }
    }

    loadItems()
  }, [user, selectedCategory])

  const filteredItems = menuItems.filter(item => {
    if (searchQuery) {
      return item.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
             item.description?.toLowerCase().includes(searchQuery.toLowerCase())
    }
    return true
  })

  const handleAddItem = () => {
    setEditingItem(null)
    setFormData({
      name: '',
      description: '',
      category_id: selectedCategory || '',
      base_price: '',
      image_url: '',
      has_sizes: false,
      sizes: [],
      has_addons: false,
      addons: [],
      allow_special_instructions: true,
      status: 'available',
    })
    setShowItemModal(true)
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
    if (!user) return

    try {
      if (!formData.name || !formData.category_id || !formData.base_price) {
        toast({
          title: 'Validation Error',
          description: 'Please fill in all required fields',
          variant: 'destructive',
        })
        return
      }

      const itemData = {
        restaurant_id: user.uid,
        category_id: formData.category_id,
        name: formData.name,
        description: formData.description,
        image_url: formData.image_url || undefined,
        base_price: parseFloat(formData.base_price),
        has_sizes: formData.has_sizes,
        sizes: formData.sizes,
        has_addons: formData.has_addons,
        addons: formData.addons,
        allow_special_instructions: formData.allow_special_instructions,
        status: formData.status,
      }

      if (editingItem) {
        await updateMenuItem(editingItem.id, itemData)
        toast({
          title: 'Success',
          description: 'Menu item updated successfully',
        })
      } else {
        await createMenuItem(itemData)
        toast({
          title: 'Success',
          description: 'Menu item created successfully',
        })
      }

      // Reload items
      const items = await getMenuItems(user.uid, selectedCategory)
      setMenuItems(items)
      setShowItemModal(false)
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
      await deleteMenuItem(item.id)
      toast({
        title: 'Success',
        description: 'Menu item deleted',
      })
      const items = await getMenuItems(user.uid, selectedCategory)
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
      const items = await getMenuItems(user.uid, selectedCategory)
      setMenuItems(items)
    } catch (err: any) {
      toast({
        title: 'Error',
        description: 'Failed to update status',
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
          <Button onClick={handleAddItem} className="bg-[#FF6B35] hover:bg-[#e55a28]">
            <Plus className="h-4 w-4 mr-2" />
            Add Item
          </Button>
        </div>
      </header>

      <div className="container mx-auto px-6 py-6">
        {/* Category Tabs */}
        <div className="flex gap-2 mb-6 overflow-x-auto">
          {categories.map((category) => (
            <Button
              key={category.id}
              variant={selectedCategory === category.id ? 'default' : 'outline'}
              onClick={() => setSelectedCategory(category.id)}
              className={selectedCategory === category.id ? 'bg-[#FF6B35] hover:bg-[#e55a28]' : ''}
            >
              {category.name} ({menuItems.filter(i => i.category_id === category.id).length})
            </Button>
          ))}
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

        {/* Menu Items Grid */}
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

        {filteredItems.length === 0 && (
          <div className="text-center py-12">
            <p className="text-muted-foreground">No menu items found</p>
          </div>
        )}
      </div>

      {/* Add/Edit Item Modal */}
      <Dialog open={showItemModal} onOpenChange={setShowItemModal}>
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
              <Select
                value={formData.category_id}
                onValueChange={(value) => setFormData({ ...formData, category_id: value })}
              >
                <SelectTrigger>
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
                onClick={handleSaveItem}
                className="flex-1 bg-[#FF6B35] hover:bg-[#e55a28]"
              >
                {editingItem ? 'Update' : 'Create'} Item
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}

