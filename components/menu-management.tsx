"use client"

import type React from "react"

import { useState } from "react"
import { ArrowLeft, Plus, Search, MoreVertical, Edit, Copy, Trash2, Upload, FileDown, Eye } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Checkbox } from "@/components/ui/checkbox"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { useToast } from "@/hooks/use-toast"

type MenuItem = {
  id: string
  name: string
  description: string
  category: string
  price: number
  image?: string
  status: "available" | "out-of-stock" | "hidden"
  allowSizes?: boolean
  allowAddons?: boolean
  allowInstructions?: boolean
}

const sampleMenuItems: MenuItem[] = [
  {
    id: "1",
    name: "Grilled Salmon",
    description: "Fresh Atlantic salmon grilled to perfection with lemon butter sauce",
    category: "Mains",
    price: 180,
    image: "/grilled-salmon-dish.jpg",
    status: "available",
  },
  {
    id: "2",
    name: "Caesar Salad",
    description: "Crisp romaine lettuce with parmesan and croutons",
    category: "Starters",
    price: 85,
    image: "/caesar-salad.png",
    status: "out-of-stock",
  },
  {
    id: "3",
    name: "Beef Burger",
    description: "Angus beef patty with cheese, lettuce, tomato, and special sauce",
    category: "Mains",
    price: 145,
    image: "/beef-burger.png",
    status: "available",
  },
  {
    id: "4",
    name: "Mango Smoothie",
    description: "Fresh mango blended with yogurt and honey",
    category: "Drinks",
    price: 65,
    image: "/mango-smoothie.png",
    status: "available",
  },
  {
    id: "5",
    name: "Bruschetta",
    description: "Toasted bread with tomatoes, basil, garlic and olive oil",
    category: "Starters",
    price: 65,
    status: "available",
  },
  {
    id: "6",
    name: "Chocolate Lava Cake",
    description: "Warm chocolate cake with molten center, served with vanilla ice cream",
    category: "Desserts",
    price: 95,
    status: "available",
  },
]

export function MenuManagement() {
  const [menuItems, setMenuItems] = useState<MenuItem[]>(sampleMenuItems)
  const [activeCategory, setActiveCategory] = useState("All")
  const [searchQuery, setSearchQuery] = useState("")
  const [showItemModal, setShowItemModal] = useState(false)
  const [editingItem, setEditingItem] = useState<MenuItem | null>(null)
  const [showCategoryModal, setShowCategoryModal] = useState(false)
  const { toast } = useToast()

  // Calculate category counts
  const categories = ["All", "Starters", "Mains", "Drinks", "Desserts"]
  const getCategoryCount = (cat: string) => {
    if (cat === "All") return menuItems.length
    return menuItems.filter((item) => item.category === cat).length
  }

  // Filter items
  const filteredItems = menuItems.filter((item) => {
    const matchesCategory = activeCategory === "All" || item.category === activeCategory
    const matchesSearch = item.name.toLowerCase().includes(searchQuery.toLowerCase())
    return matchesCategory && matchesSearch
  })

  const handleAddItem = () => {
    setEditingItem(null)
    setShowItemModal(true)
  }

  const handleEditItem = (item: MenuItem) => {
    setEditingItem(item)
    setShowItemModal(true)
  }

  const handleDuplicateItem = (item: MenuItem) => {
    const newItem = { ...item, id: Date.now().toString(), name: `${item.name} (Copy)` }
    setMenuItems([...menuItems, newItem])
    toast({
      title: "Item duplicated",
      description: `${item.name} has been duplicated`,
    })
  }

  const handleDeleteItem = (id: string) => {
    const item = menuItems.find((i) => i.id === id)
    if (confirm(`Delete ${item?.name}?`)) {
      setMenuItems(menuItems.filter((i) => i.id !== id))
      toast({
        title: "Item deleted",
        description: "Menu item has been removed",
      })
    }
  }

  const handleToggleStatus = (id: string) => {
    setMenuItems(
      menuItems.map((item) =>
        item.id === id
          ? {
              ...item,
              status: item.status === "available" ? "out-of-stock" : "available",
            }
          : item,
      ),
    )
  }

  // Empty state
  if (menuItems.length === 0) {
    return (
      <div className="min-h-screen bg-gray-50">
        <div className="bg-white border-b px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <button
              onClick={() => window.history.back()}
              className="p-2 hover:bg-gray-100 rounded-lg transition-colors"
            >
              <ArrowLeft className="w-5 h-5" />
            </button>
            <h1 className="text-xl font-bold">Menu Management</h1>
          </div>
        </div>

        <div className="flex items-center justify-center min-h-[600px]">
          <div className="text-center space-y-6 max-w-md">
            <div className="text-6xl">🍽️</div>
            <div className="space-y-2">
              <h2 className="text-2xl font-bold">No Menu Items Yet</h2>
              <p className="text-gray-600">Create your first menu item to start accepting orders</p>
            </div>
            <Button size="lg" className="bg-[#FF6B35] hover:bg-[#e55a28]" onClick={handleAddItem}>
              <Plus className="w-4 h-4 mr-2" />
              Create First Item
            </Button>
            <div className="flex items-center gap-4 justify-center">
              <div className="h-px bg-gray-300 flex-1" />
              <span className="text-sm text-gray-500">or</span>
              <div className="h-px bg-gray-300 flex-1" />
            </div>
            <Button variant="outline" size="lg">
              <Upload className="w-4 h-4 mr-2" />
              Import Menu (CSV)
            </Button>
          </div>
        </div>

        {showItemModal && (
          <ItemModal
            item={editingItem}
            onClose={() => setShowItemModal(false)}
            onSave={(item) => {
              if (editingItem) {
                setMenuItems(menuItems.map((i) => (i.id === item.id ? item : i)))
              } else {
                setMenuItems([...menuItems, { ...item, id: Date.now().toString() }])
              }
              setShowItemModal(false)
              toast({
                title: editingItem ? "Item updated" : "Item added",
                description: `${item.name} has been ${editingItem ? "updated" : "added to menu"}`,
              })
            }}
          />
        )}
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <div className="bg-white border-b px-6 py-4 flex items-center justify-between sticky top-0 z-10">
        <div className="flex items-center gap-3">
          <button onClick={() => window.history.back()} className="p-2 hover:bg-gray-100 rounded-lg transition-colors">
            <ArrowLeft className="w-5 h-5" />
          </button>
          <h1 className="text-xl font-bold">Menu Management</h1>
        </div>
        <Button className="bg-[#FF6B35] hover:bg-[#e55a28]" onClick={handleAddItem}>
          <Plus className="w-4 h-4 mr-2" />
          Add Item
        </Button>
      </div>

      <div className="max-w-6xl mx-auto p-6 space-y-6">
        {/* Categories */}
        <div className="bg-white rounded-xl p-4 shadow-sm">
          <h3 className="font-semibold mb-3">Categories</h3>
          <div className="flex items-center gap-3 overflow-x-auto pb-2">
            {categories.map((cat) => (
              <button
                key={cat}
                onClick={() => setActiveCategory(cat)}
                className={`px-4 py-2 rounded-lg whitespace-nowrap transition-all ${
                  activeCategory === cat
                    ? "bg-orange-50 text-[#FF6B35] font-semibold border-b-4 border-[#FF6B35]"
                    : "bg-gray-50 text-gray-600 hover:bg-gray-100"
                }`}
              >
                {cat} ({getCategoryCount(cat)})
              </button>
            ))}
            <button
              onClick={() => setShowCategoryModal(true)}
              className="px-4 py-2 rounded-lg whitespace-nowrap text-[#FF6B35] hover:bg-orange-50 flex items-center gap-2"
            >
              <Plus className="w-4 h-4" />
              Add Category
            </button>
          </div>
        </div>

        {/* Search and Bulk Actions */}
        <div className="flex items-center gap-4">
          <div className="flex-1 relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-400" />
            <Input
              placeholder="Search menu items..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-10 h-12"
            />
          </div>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="lg">
                <MoreVertical className="w-4 h-4 mr-2" />
                Bulk
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56">
              <DropdownMenuItem>
                <FileDown className="w-4 h-4 mr-2" />
                Export Menu (CSV)
              </DropdownMenuItem>
              <DropdownMenuItem>
                <Upload className="w-4 h-4 mr-2" />
                Import Menu (CSV)
              </DropdownMenuItem>
              <DropdownMenuItem>
                <Copy className="w-4 h-4 mr-2" />
                Duplicate Category
              </DropdownMenuItem>
              <DropdownMenuItem>
                <Eye className="w-4 h-4 mr-2" />
                Preview Menu
              </DropdownMenuItem>
              <DropdownMenuItem className="text-red-600">
                <Trash2 className="w-4 h-4 mr-2" />
                Delete Multiple
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        {/* Menu Items */}
        <div className="space-y-3">
          {filteredItems.map((item) => (
            <div
              key={item.id}
              className="bg-white rounded-xl p-4 shadow-sm border border-gray-200 hover:shadow-md transition-shadow"
            >
              <div className="flex gap-4">
                {/* Image */}
                <div className="w-20 h-20 bg-gray-100 rounded-lg flex-shrink-0 overflow-hidden">
                  {item.image ? (
                    <img
                      src={item.image || "/placeholder.svg"}
                      alt={item.name}
                      className="w-full h-full object-cover"
                    />
                  ) : (
                    <div className="w-full h-full flex items-center justify-center text-3xl">🍽️</div>
                  )}
                </div>

                {/* Content */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-start justify-between gap-4 mb-1">
                    <h3 className="font-bold text-lg">{item.name}</h3>
                    <div className="font-bold text-lg text-[#FF6B35] whitespace-nowrap">N${item.price}</div>
                  </div>
                  <p className="text-sm text-gray-600 mb-2 line-clamp-2">{item.description}</p>
                  <div className="flex items-center gap-2 text-xs text-gray-500 mb-3">
                    <span>{item.category}</span>
                    <span>•</span>
                    <span
                      className={`flex items-center gap-1 ${
                        item.status === "available"
                          ? "text-green-600"
                          : item.status === "out-of-stock"
                            ? "text-red-600"
                            : "text-gray-600"
                      }`}
                    >
                      <span
                        className={`w-2 h-2 rounded-full ${
                          item.status === "available"
                            ? "bg-green-600"
                            : item.status === "out-of-stock"
                              ? "bg-red-600"
                              : "bg-gray-600"
                        }`}
                      />
                      {item.status === "available"
                        ? "Available"
                        : item.status === "out-of-stock"
                          ? "Out of Stock"
                          : "Hidden"}
                    </span>
                  </div>

                  {/* Actions */}
                  <div className="flex items-center gap-2 flex-wrap">
                    <Button variant="outline" size="sm" onClick={() => handleEditItem(item)}>
                      <Edit className="w-3 h-3 mr-1" />
                      Edit
                    </Button>
                    <Button variant="outline" size="sm" onClick={() => handleDuplicateItem(item)}>
                      <Copy className="w-3 h-3 mr-1" />
                      Duplicate
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => handleDeleteItem(item.id)}
                      className="text-red-600 hover:text-red-700"
                    >
                      <Trash2 className="w-3 h-3 mr-1" />
                      Delete
                    </Button>
                    <Button
                      variant={item.status === "available" ? "secondary" : "default"}
                      size="sm"
                      onClick={() => handleToggleStatus(item.id)}
                      className={item.status === "available" ? "" : "bg-[#FF6B35] hover:bg-[#e55a28]"}
                    >
                      {item.status === "available" ? "Mark Out of Stock" : "Mark Available"}
                    </Button>
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>

        {filteredItems.length === 0 && (
          <div className="text-center py-12 text-gray-500">
            <p>No items found matching &quot;{searchQuery}&quot;</p>
          </div>
        )}
      </div>

      {showItemModal && (
        <ItemModal
          item={editingItem}
          onClose={() => setShowItemModal(false)}
          onSave={(item) => {
            if (editingItem) {
              setMenuItems(menuItems.map((i) => (i.id === item.id ? item : i)))
            } else {
              setMenuItems([...menuItems, { ...item, id: Date.now().toString() }])
            }
            setShowItemModal(false)
            toast({
              title: editingItem ? "Item updated" : "Item added",
              description: `${item.name} has been ${editingItem ? "updated" : "added to menu"}`,
            })
          }}
        />
      )}

      {showCategoryModal && <CategoryModal onClose={() => setShowCategoryModal(false)} />}
    </div>
  )
}

function ItemModal({
  item,
  onClose,
  onSave,
}: {
  item: MenuItem | null
  onClose: () => void
  onSave: (item: MenuItem) => void
}) {
  const [formData, setFormData] = useState<MenuItem>(
    item || {
      id: "",
      name: "",
      description: "",
      category: "Mains",
      price: 0,
      status: "available",
      allowSizes: false,
      allowAddons: false,
      allowInstructions: false,
    },
  )
  const [imagePreview, setImagePreview] = useState(item?.image || "")

  const handleImageUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (file) {
      const reader = new FileReader()
      reader.onloadend = () => {
        setImagePreview(reader.result as string)
        setFormData({ ...formData, image: reader.result as string })
      }
      reader.readAsDataURL(file)
    }
  }

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!formData.name || !formData.category || formData.price <= 0) {
      alert("Please fill in all required fields")
      return
    }
    onSave(formData)
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl max-w-2xl w-full max-h-[90vh] overflow-y-auto">
        <div className="sticky top-0 bg-white border-b px-6 py-4 flex items-center justify-between">
          <h2 className="text-xl font-bold">{item ? "Edit Menu Item" : "Add Menu Item"}</h2>
          <button onClick={onClose} className="p-2 hover:bg-gray-100 rounded-lg transition-colors">
            ×
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-6 space-y-6">
          {/* Photo Upload */}
          <div>
            <Label>Photo</Label>
            <div className="mt-2 flex items-center gap-4">
              <div className="w-32 h-32 bg-gray-100 rounded-lg overflow-hidden flex items-center justify-center">
                {imagePreview ? (
                  <img src={imagePreview || "/placeholder.svg"} alt="Preview" className="w-full h-full object-cover" />
                ) : (
                  <div className="text-center text-gray-400">
                    <div className="text-4xl mb-2">📷</div>
                    <div className="text-xs">Add Photo</div>
                  </div>
                )}
              </div>
              <div className="flex-1">
                <Label htmlFor="photo-upload" className="cursor-pointer">
                  <div className="border-2 border-dashed border-gray-300 rounded-lg p-6 text-center hover:border-[#FF6B35] transition-colors">
                    <p className="text-sm text-gray-600">Tap to upload image</p>
                    <p className="text-xs text-gray-400 mt-1">(or drag & drop)</p>
                  </div>
                </Label>
                <input id="photo-upload" type="file" accept="image/*" className="hidden" onChange={handleImageUpload} />
              </div>
            </div>
          </div>

          {/* Item Name */}
          <div>
            <Label htmlFor="name">
              Item Name <span className="text-red-500">*</span>
            </Label>
            <Input
              id="name"
              value={formData.name}
              onChange={(e) => setFormData({ ...formData, name: e.target.value })}
              placeholder="e.g., Grilled Chicken Breast"
              maxLength={60}
              required
            />
          </div>

          {/* Description */}
          <div>
            <Label htmlFor="description">Description</Label>
            <Textarea
              id="description"
              value={formData.description}
              onChange={(e) => setFormData({ ...formData, description: e.target.value })}
              placeholder="Describe the dish, ingredients, cooking style..."
              maxLength={200}
              rows={3}
            />
            <p className="text-xs text-gray-500 mt-1">{formData.description.length}/200</p>
          </div>

          {/* Category */}
          <div>
            <Label htmlFor="category">
              Category <span className="text-red-500">*</span>
            </Label>
            <Select value={formData.category} onValueChange={(value) => setFormData({ ...formData, category: value })}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="Starters">Starters</SelectItem>
                <SelectItem value="Mains">Mains</SelectItem>
                <SelectItem value="Drinks">Drinks</SelectItem>
                <SelectItem value="Desserts">Desserts</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* Price */}
          <div>
            <Label htmlFor="price">
              Price (N$) <span className="text-red-500">*</span>
            </Label>
            <Input
              id="price"
              type="number"
              value={formData.price || ""}
              onChange={(e) => setFormData({ ...formData, price: Number.parseFloat(e.target.value) })}
              placeholder="0.00"
              step="0.01"
              min="0"
              required
            />
          </div>

          <div className="border-t pt-6">
            <h3 className="font-semibold mb-4">Customization Options (Optional)</h3>

            {/* Size Selection */}
            <div className="flex items-center space-x-2 mb-3">
              <Checkbox
                id="allow-sizes"
                checked={formData.allowSizes}
                onCheckedChange={(checked) => setFormData({ ...formData, allowSizes: checked as boolean })}
              />
              <Label htmlFor="allow-sizes" className="cursor-pointer">
                Allow size selection
              </Label>
            </div>

            {/* Add-ons */}
            <div className="flex items-center space-x-2 mb-3">
              <Checkbox
                id="allow-addons"
                checked={formData.allowAddons}
                onCheckedChange={(checked) => setFormData({ ...formData, allowAddons: checked as boolean })}
              />
              <Label htmlFor="allow-addons" className="cursor-pointer">
                Allow add-ons
              </Label>
            </div>

            {/* Special Instructions */}
            <div className="flex items-center space-x-2">
              <Checkbox
                id="allow-instructions"
                checked={formData.allowInstructions}
                onCheckedChange={(checked) => setFormData({ ...formData, allowInstructions: checked as boolean })}
              />
              <Label htmlFor="allow-instructions" className="cursor-pointer">
                Allow customers to add notes
              </Label>
            </div>
          </div>

          {/* Status */}
          <div className="border-t pt-6">
            <Label>Status</Label>
            <RadioGroup
              value={formData.status}
              onValueChange={(value) => setFormData({ ...formData, status: value as MenuItem["status"] })}
              className="mt-2"
            >
              <div className="flex items-center space-x-2">
                <RadioGroupItem value="available" id="available" />
                <Label htmlFor="available" className="cursor-pointer">
                  Available
                </Label>
              </div>
              <div className="flex items-center space-x-2">
                <RadioGroupItem value="out-of-stock" id="out-of-stock" />
                <Label htmlFor="out-of-stock" className="cursor-pointer">
                  Out of Stock
                </Label>
              </div>
              <div className="flex items-center space-x-2">
                <RadioGroupItem value="hidden" id="hidden" />
                <Label htmlFor="hidden" className="cursor-pointer">
                  Hidden (draft)
                </Label>
              </div>
            </RadioGroup>
          </div>

          {/* Actions */}
          <div className="flex gap-3 pt-4">
            <Button type="button" variant="outline" onClick={onClose} className="flex-1 bg-transparent">
              Cancel
            </Button>
            <Button type="submit" className="flex-1 bg-[#FF6B35] hover:bg-[#e55a28]">
              Save Item
            </Button>
          </div>
        </form>
      </div>
    </div>
  )
}

function CategoryModal({ onClose }: { onClose: () => void }) {
  const [categoryName, setCategoryName] = useState("")
  const { toast } = useToast()

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!categoryName) return

    toast({
      title: "Category created",
      description: `${categoryName} has been added to your menu`,
    })
    onClose()
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl max-w-md w-full">
        <div className="border-b px-6 py-4 flex items-center justify-between">
          <h2 className="text-xl font-bold">Add Category</h2>
          <button onClick={onClose} className="p-2 hover:bg-gray-100 rounded-lg transition-colors">
            ×
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-6 space-y-6">
          <div>
            <Label htmlFor="category-name">Category Name</Label>
            <Input
              id="category-name"
              value={categoryName}
              onChange={(e) => setCategoryName(e.target.value)}
              placeholder="e.g., Desserts, Specials, Kids Menu"
              required
            />
          </div>

          <div className="flex gap-3">
            <Button type="button" variant="outline" onClick={onClose} className="flex-1 bg-transparent">
              Cancel
            </Button>
            <Button type="submit" className="flex-1 bg-[#FF6B35] hover:bg-[#e55a28]">
              Add Category
            </Button>
          </div>
        </form>
      </div>
    </div>
  )
}
