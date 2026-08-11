'use client'

import { useEffect, useMemo, useState } from 'react'
import Image from 'next/image'
import { Loader2, Plus, Trash2, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Textarea } from '@/components/ui/textarea'
import {
  MenuItemInventoryTab,
  emptyIngredientRow,
  toIngredientRowsFromLoaded,
  type MenuItemIngredientRow,
} from '@/components/menu/menu-item-inventory-tab'
import { useToast } from '@/hooks/use-toast'
import { menuItemImageDisplayUrl } from '@/lib/menu-item-image'
import {
  validateMenuItemDraft,
  type ExistingMenuItem,
} from '@/lib/menu/validate-menu-item'
import {
  canEditMenuInventoryAction,
  loadInventoryPickerAction,
  loadMenuItemInventoryAction,
  saveRecipeAction,
} from '@/lib/recipes/actions'
import { createMenuItem, updateMenuItem, type MenuItem } from '@/lib/supabase/menu'
import { uploadMenuItemImage } from '@/lib/supabase/storage'
import type { MeasurementUnitOption } from '@/lib/measurement-units/format'
import type { StockItemOptionWithLevel } from '@/lib/stock/queries'
import { getTaxRatesForMenuFormAction } from '@/lib/tax-rates/actions'
import { formatTaxRateLabel, type TaxRateOption } from '@/lib/tax-rates/format'

type ItemFormState = {
  name: string
  description: string
  category_id: string
  sub_category_id: string
  base_price: string
  image_url: string
  imageFile: File | null
  imageFit: 'contain' | 'cover' | 'fill' | 'scale-down'
  imagePosition: 'center' | 'top' | 'bottom'
  has_sizes: boolean
  sizes: Array<{ name: string; price_modifier: number }>
  variants: Array<{ size: string; label: string; price: number }>
  variantGroups: Array<{
    name: string
    required: boolean
    type: 'text' | 'price'
    options: Array<string | { label: string; price: number }>
  }>
  has_addons: boolean
  addons: Array<{ name: string; price: number }>
  allow_special_instructions: boolean
  is_popular: boolean
  status: 'available' | 'out_of_stock' | 'hidden'
  tax_rate_id: string
}

function emptyItemForm(subCategoryId = '', categoryId = ''): ItemFormState {
  return {
    name: '',
    description: '',
    category_id: categoryId,
    sub_category_id: subCategoryId,
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
    is_popular: false,
    status: 'available',
    tax_rate_id: '',
  }
}

function itemToForm(item: MenuItem): ItemFormState {
  return {
    name: item.name,
    description: item.description || '',
    category_id: item.menu_category_id || '',
    sub_category_id: item.sub_category_id,
    base_price: item.base_price.toString(),
    image_url: item.image_url || '',
    imageFile: null,
    imageFit: item.imageFit || 'contain',
    imagePosition: item.imagePosition || 'center',
    has_sizes: item.has_sizes,
    sizes: item.sizes || [],
    variants: Array.isArray((item as MenuItem & { variants?: ItemFormState['variants'] }).variants)
      ? (item as MenuItem & { variants?: ItemFormState['variants'] }).variants || []
      : [],
    variantGroups: Array.isArray(
      (item as MenuItem & { variantGroups?: ItemFormState['variantGroups'] }).variantGroups,
    )
      ? (item as MenuItem & { variantGroups?: ItemFormState['variantGroups'] }).variantGroups || []
      : [],
    has_addons: item.has_addons,
    addons: item.addons || [],
    allow_special_instructions: item.allow_special_instructions,
    is_popular: item.is_popular === true,
    status: item.status,
    tax_rate_id: item.tax_rate_id || '',
  }
}

function SubCategorySelect({
  subCategories,
  value,
  onChange,
}: {
  subCategories: Array<{ id: string; name: string; menuCategoryId: string; menuCategoryName: string }>
  value: string
  onChange: (value: string) => void
}) {
  if (subCategories.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No sub-categories available. Item will be saved directly under this category.
      </p>
    )
  }

  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger>
        <SelectValue placeholder="Select sub-category" />
      </SelectTrigger>
      <SelectContent>
        {subCategories.map((sub) => (
          <SelectItem key={sub.id} value={sub.id}>
            {sub.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

function MenuItemFormContent({
  editingItem,
  defaultSubCategoryId,
  restaurantId,
  categoryId,
  categoryOptions,
  subCategoryOptions,
  existingItems,
  onOpenChange,
  onSaved,
}: {
  editingItem: MenuItem | null
  defaultSubCategoryId: string
  restaurantId: string | null
  categoryId: string | null
  categoryOptions: Array<{ id: string; name: string }>
  subCategoryOptions: Array<{ id: string; name: string; menuCategoryId: string; menuCategoryName: string }>
  existingItems: ExistingMenuItem[]
  onOpenChange: (open: boolean) => void
  onSaved: () => void | Promise<void>
}) {
  const { toast } = useToast()
  const [activeTab, setActiveTab] = useState('general')
  const [itemForm, setItemForm] = useState<ItemFormState>(() =>
    editingItem ? itemToForm(editingItem) : emptyItemForm(defaultSubCategoryId, categoryId ?? ''),
  )
  const [uploadingImage, setUploadingImage] = useState(false)
  const [saving, setSaving] = useState(false)
  const [imagePreview, setImagePreview] = useState<string | null>(() =>
    editingItem?.image_url
      ? menuItemImageDisplayUrl(editingItem.id, editingItem.image_url) || editingItem.image_url
      : null,
  )
  const [canEditInventory, setCanEditInventory] = useState(false)
  const [trackInventory, setTrackInventory] = useState(false)
  /**
   * Whether `trackInventory` reflects a value we actually established, rather than the initial
   * false. #106: the effect below sets canEditInventory BEFORE loading the item's inventory
   * state and returns early if that load errors, so a failed load used to leave trackInventory
   * sitting at false while the payload sent it anyway -- silently turning tracking off for an
   * item whose recipe and ingredients are untouched. `menu_items.track_inventory` is what
   * getInventorySetupOverview filters on, what deduct_recipe_stock requires, and what
   * checkStockSufficiency reads, so clearing it stops deduction and hides the item from the
   * setup UI entirely. Unknown means: leave the column alone.
   */
  const [inventoryStateKnown, setInventoryStateKnown] = useState(false)
  const [ingredientRows, setIngredientRows] = useState<MenuItemIngredientRow[]>([emptyIngredientRow()])
  const [stockItems, setStockItems] = useState<StockItemOptionWithLevel[]>([])
  const [measurementUnits, setMeasurementUnits] = useState<MeasurementUnitOption[]>([])
  const [inventoryLoadError, setInventoryLoadError] = useState<string | null>(null)
  const [inventorySaveError, setInventorySaveError] = useState<string | null>(null)
  const [savedMenuItemId, setSavedMenuItemId] = useState<string | null>(null)
  const [taxRates, setTaxRates] = useState<TaxRateOption[]>([])

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const result = await getTaxRatesForMenuFormAction()
      if (cancelled) return
      if ('data' in result) {
        setTaxRates(result.data)
      }
    })()

    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const perm = await canEditMenuInventoryAction()
      if (cancelled) return
      setCanEditInventory(perm.canEdit)

      if (!perm.canEdit) return

      if (editingItem?.id) {
        const result = await loadMenuItemInventoryAction(editingItem.id)
        if (cancelled) return
        if (result.error) {
          setInventoryLoadError(result.error)
          return
        }
        setInventoryLoadError(null)
        setStockItems(result.data?.stockItems ?? [])
        setMeasurementUnits(result.data?.measurementUnits ?? [])
        const trackingOn = Boolean(result.data?.trackInventory)
        setTrackInventory(trackingOn)
        setInventoryStateKnown(true)
        setIngredientRows(
          trackingOn
            ? toIngredientRowsFromLoaded(result.data?.ingredients ?? [])
            : [emptyIngredientRow()],
        )
      } else {
        const result = await loadInventoryPickerAction()
        if (cancelled) return
        if (result.error) {
          setInventoryLoadError(result.error)
          return
        }
        setInventoryLoadError(null)
        setStockItems(result.data?.stockItems ?? [])
        setMeasurementUnits(result.data?.measurementUnits ?? [])
        // A brand new item has no recipe, so false is established rather than assumed.
        setTrackInventory(false)
        setInventoryStateKnown(true)
        setIngredientRows([emptyIngredientRow()])
      }
    })()

    return () => {
      cancelled = true
    }
  }, [editingItem?.id])

  const handleImageFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (!file) return

    if (!file.type.startsWith('image/')) {
      toast({ title: 'Invalid File', description: 'Please select an image file', variant: 'destructive' })
      return
    }

    const maxSize = 5 * 1024 * 1024
    if (file.size > maxSize) {
      toast({ title: 'File Too Large', description: 'Image must be less than 5MB', variant: 'destructive' })
      return
    }

    setItemForm((prev) => ({ ...prev, imageFile: file, image_url: '' }))
    const reader = new FileReader()
    reader.onloadend = () => setImagePreview(reader.result as string)
    reader.readAsDataURL(file)
  }

  const handleRemoveImage = () => {
    setItemForm((prev) => ({ ...prev, imageFile: null, image_url: '' }))
    setImagePreview(null)
  }

  const subCategoriesForSelectedCategory = useMemo(
    () => subCategoryOptions.filter((sub) => sub.menuCategoryId === itemForm.category_id),
    [subCategoryOptions, itemForm.category_id],
  )

  const handleCategoryChange = (newCategoryId: string) => {
    setItemForm((prev) => {
      const subStillValid = subCategoryOptions.some(
        (sub) => sub.id === prev.sub_category_id && sub.menuCategoryId === newCategoryId,
      )
      return {
        ...prev,
        category_id: newCategoryId,
        sub_category_id: subStillValid ? prev.sub_category_id : '',
      }
    })
  }

  const sanitizedVariants = useMemo(
    () =>
      itemForm.variants
        .map((variant) => ({
          size: String(variant.size || '').trim(),
          label: String(variant.label || '').trim(),
          price: Number(variant.price),
        }))
        .filter(
          (variant) =>
            variant.size && variant.label && Number.isFinite(variant.price) && variant.price > 0,
        ),
    [itemForm.variants],
  )

  const sanitizedVariantGroups = useMemo(
    () =>
      itemForm.variantGroups
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
                  .map((opt) =>
                    typeof opt === 'string' ? String(opt).trim() : String(opt?.label || '').trim(),
                  )
                  .filter(Boolean)
          return {
            name: cleanedName,
            required: Boolean(group.required),
            type: group.type,
            options: cleanedOptions,
          }
        })
        .filter((group) => group.name && group.options.length > 0),
    [itemForm.variantGroups],
  )

  const inventoryIngredients = useMemo(
    () =>
      ingredientRows
        .filter((row) => row.stockItemId && row.unitId && Number(row.quantity) > 0)
        .map((row) => ({
          stockItemId: row.stockItemId,
          quantity: Number(row.quantity),
          unitId: row.unitId,
        })),
    [ingredientRows],
  )

  const buildMenuPayload = (imageUrl: string, price: number) => ({
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
    addons: itemForm.has_addons ? itemForm.addons : [],
    allow_special_instructions: itemForm.allow_special_instructions,
    is_popular: itemForm.is_popular,
    status: itemForm.status,
    tax_rate_id: itemForm.tax_rate_id || null,
    // Omitted, not defaulted, when the current value was never established (#106).
    // buildMenuItemDbPayload only writes the column when the key is present, so leaving it out
    // is a genuine no-op on an item whose tracking state this form never learned.
    ...(canEditInventory && inventoryStateKnown ? { track_inventory: trackInventory } : {}),
  })

  const saveInventoryOnly = async (menuItemId: string) => {
    const result = await saveRecipeAction({
      menuItemId,
      ingredients: inventoryIngredients,
    })
    if (result.error) {
      setInventorySaveError(result.error)
      return false
    }
    setInventorySaveError(null)
    return true
  }

  const handleRetryInventorySave = async () => {
    const menuItemId = savedMenuItemId ?? editingItem?.id
    if (!menuItemId) return
    setSaving(true)
    try {
      const ok = await saveInventoryOnly(menuItemId)
      if (ok) {
        toast({ title: 'Success', description: 'Inventory ingredients saved.' })
        onOpenChange(false)
        await onSaved()
      }
    } finally {
      setSaving(false)
    }
  }

  const handleSaveItem = async () => {
    if (!restaurantId) return

    if (!itemForm.category_id) {
      toast({
        title: 'Validation Error',
        description: 'Please select a category',
        variant: 'destructive',
      })
      setActiveTab('general')
      return
    }

    const { blockingErrors } = validateMenuItemDraft(
      {
        itemId: editingItem?.id ?? null,
        name: itemForm.name,
        subCategoryId: itemForm.sub_category_id || null,
        categoryId: itemForm.category_id,
        ingredientRows: trackInventory
          ? ingredientRows.map(({ stockItemId, quantity, unitId }) => ({
              stockItemId,
              quantity,
              unitId,
            }))
          : [],
      },
      existingItems,
    )
    if (blockingErrors.length > 0) {
      toast({
        title: 'Validation Error',
        description: blockingErrors.join('\n'),
        variant: 'destructive',
      })
      return
    }

    if (!itemForm.name || !itemForm.base_price) {
      toast({
        title: 'Validation Error',
        description: 'Please fill in all required fields',
        variant: 'destructive',
      })
      setActiveTab('general')
      return
    }

    const price = parseFloat(itemForm.base_price)
    if (Number.isNaN(price) || price <= 0) {
      toast({
        title: 'Validation Error',
        description: 'Please enter a valid price greater than 0',
        variant: 'destructive',
      })
      setActiveTab('pricing')
      return
    }

    setSaving(true)
    setInventorySaveError(null)

    try {
      let imageUrl = itemForm.image_url

      if (itemForm.imageFile) {
        setUploadingImage(true)
        try {
          imageUrl = await uploadMenuItemImage(itemForm.imageFile, restaurantId, editingItem?.id)
        } catch (uploadError: unknown) {
          const message =
            uploadError instanceof Error ? uploadError.message : 'Failed to upload image'
          toast({ title: 'Upload Error', description: message, variant: 'destructive' })
          return
        } finally {
          setUploadingImage(false)
        }
      }

      const payload = buildMenuPayload(imageUrl, price)
      let menuItemId = editingItem?.id ?? null

      if (editingItem) {
        await updateMenuItem(
          restaurantId,
          itemForm.category_id,
          itemForm.sub_category_id || '',
          editingItem.id,
          payload,
        )
        menuItemId = editingItem.id
      } else {
        menuItemId = await createMenuItem({
          restaurant_id: restaurantId,
          category_id: itemForm.category_id,
          sub_category_id: itemForm.sub_category_id || null,
          ...payload,
        })
      }

      if (!menuItemId) {
        throw new Error('Menu item saved but no id was returned')
      }

      setSavedMenuItemId(menuItemId)

      const shouldSaveInventory =
        canEditInventory && trackInventory && inventoryIngredients.length > 0

      if (shouldSaveInventory) {
        const inventoryOk = await saveInventoryOnly(menuItemId)
        if (!inventoryOk) {
          return
        }
      }

      toast({
        title: 'Success',
        description: editingItem ? 'Menu item updated successfully' : 'Menu item created successfully',
      })
      onOpenChange(false)
      await onSaved()
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to save menu item'
      toast({ title: 'Error', description: message, variant: 'destructive' })
    } finally {
      setSaving(false)
    }
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
    value: string,
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
    value: string | boolean,
  ) => {
    setItemForm((prev) => {
      const next = [...prev.variantGroups]
      if (!next[groupIndex]) return prev
      next[groupIndex] = { ...next[groupIndex], [field]: value } as (typeof next)[number]
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
      const newOption =
        group.type === 'price' ? { label: '', price: Number(prev.base_price) || 0 } : ''
      next[groupIndex] = { ...group, options: [...group.options, newOption] }
      return { ...prev, variantGroups: next }
    })
  }

  const handleUpdateVariantGroupOption = (
    groupIndex: number,
    optionIndex: number,
    field: 'label' | 'price' | 'value',
    value: string,
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

  const handleAddAddon = () => {
    setItemForm((prev) => ({
      ...prev,
      addons: [...prev.addons, { name: '', price: Number(prev.base_price) || 0 }],
    }))
  }

  const handleUpdateAddon = (index: number, field: 'name' | 'price', value: string) => {
    setItemForm((prev) => {
      const next = [...prev.addons]
      if (!next[index]) return prev
      next[index] =
        field === 'price'
          ? { ...next[index], price: Number(value) || 0 }
          : { ...next[index], name: value }
      return { ...prev, addons: next }
    })
  }

  const handleRemoveAddon = (index: number) => {
    setItemForm((prev) => ({
      ...prev,
      addons: prev.addons.filter((_, idx) => idx !== index),
    }))
  }

  return (
    <>
        <Tabs value={activeTab} onValueChange={setActiveTab}>
          <TabsList className="flex h-auto w-full flex-wrap justify-start gap-1">
            <TabsTrigger value="general">General</TabsTrigger>
            <TabsTrigger value="pricing">Pricing</TabsTrigger>
            {canEditInventory ? <TabsTrigger value="inventory">Inventory</TabsTrigger> : null}
            <TabsTrigger value="options">Options</TabsTrigger>
            <TabsTrigger value="media">Media</TabsTrigger>
          </TabsList>

          <TabsContent value="general" className="space-y-4 pt-2">
            <div>
              <Label>Category *</Label>
              <Select value={itemForm.category_id} onValueChange={handleCategoryChange}>
                <SelectTrigger>
                  <SelectValue placeholder="Select category" />
                </SelectTrigger>
                <SelectContent>
                  {categoryOptions.map((category) => (
                    <SelectItem key={category.id} value={category.id}>
                      {category.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Sub-category (Optional)</Label>
              <SubCategorySelect
                subCategories={subCategoriesForSelectedCategory}
                value={itemForm.sub_category_id}
                onChange={(value) => setItemForm((prev) => ({ ...prev, sub_category_id: value }))}
              />
            </div>
            <div>
              <Label>Item Name *</Label>
              <Input
                value={itemForm.name}
                onChange={(event) => setItemForm((prev) => ({ ...prev, name: event.target.value }))}
                placeholder="e.g., Windhoek Lager"
              />
            </div>
            {canEditInventory ? (
              <div className="flex items-center justify-between gap-4 rounded-lg border border-border border-l-[3px] border-l-[#FF6B35] p-4">
                <div className="space-y-1">
                  <Label htmlFor="track-inventory-general" className="font-semibold">
                    Track Inventory
                  </Label>
                  <p className="text-sm text-muted-foreground">
                    Link ingredients to this menu item for automatic stock deduction on sale.
                  </p>
                </div>
                <Switch
                  id="track-inventory-general"
                  checked={trackInventory}
                  onCheckedChange={(checked) => {
                    // Touching the switch establishes the value even if the load failed --
                    // an explicit choice is never "unknown".
                    setTrackInventory(checked)
                    setInventoryStateKnown(true)
                  }}
                />
              </div>
            ) : null}
            {canEditInventory && trackInventory ? (
              <p className="text-sm text-muted-foreground">
                Set which ingredients and quantities are used on the Inventory tab.
              </p>
            ) : null}
            <div>
              <Label>Description</Label>
              <Textarea
                value={itemForm.description}
                onChange={(event) =>
                  setItemForm((prev) => ({ ...prev, description: event.target.value }))
                }
                placeholder="Describe the item..."
                rows={3}
              />
            </div>
          </TabsContent>

          <TabsContent value="pricing" className="space-y-4 pt-2">
            <div>
              <Label>Price (N$) *</Label>
              <Input
                type="number"
                step="0.01"
                value={itemForm.base_price}
                onChange={(event) =>
                  setItemForm((prev) => ({ ...prev, base_price: event.target.value }))
                }
                placeholder="25.00"
              />
            </div>
            <div>
              <Label>Tax Rate</Label>
              <Select
                value={itemForm.tax_rate_id || '__default__'}
                onValueChange={(value) =>
                  setItemForm((prev) => ({
                    ...prev,
                    tax_rate_id: value === '__default__' ? '' : value,
                  }))
                }
              >
                <SelectTrigger>
                  <SelectValue placeholder="Use restaurant default" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__default__">Use restaurant default</SelectItem>
                  {taxRates.map((rate) => (
                    <SelectItem key={rate.id} value={rate.id}>
                      {formatTaxRateLabel(rate)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-3 rounded-md border border-border p-3">
              <div className="flex items-center justify-between">
                <Label>Add Variants (Optional)</Label>
                <Button type="button" variant="outline" size="sm" onClick={handleAddVariantRow}>
                  <Plus className="mr-1 h-4 w-4" />
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
                    <div key={`variant-${index}`} className="grid grid-cols-12 items-center gap-2">
                      <Input
                        className="col-span-2"
                        placeholder="S"
                        value={variant.size}
                        onChange={(event) =>
                          handleUpdateVariantRow(index, 'size', event.target.value)
                        }
                      />
                      <Input
                        className="col-span-5"
                        placeholder="Small"
                        value={variant.label}
                        onChange={(event) =>
                          handleUpdateVariantRow(index, 'label', event.target.value)
                        }
                      />
                      <Input
                        className="col-span-4"
                        type="number"
                        step="0.01"
                        placeholder="25.00"
                        value={Number.isFinite(variant.price) ? variant.price : ''}
                        onChange={(event) =>
                          handleUpdateVariantRow(index, 'price', event.target.value)
                        }
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
            <div className="space-y-3 rounded-md border border-border p-3">
              <div className="flex items-center justify-between">
                <Label>Variant Groups (Optional)</Label>
                <Button type="button" variant="outline" size="sm" onClick={handleAddVariantGroup}>
                  <Plus className="mr-1 h-4 w-4" />
                  Add Group
                </Button>
              </div>
              {itemForm.variantGroups.length === 0 ? (
                <p className="text-xs text-muted-foreground">No groups configured.</p>
              ) : (
                <div className="space-y-3">
                  {itemForm.variantGroups.map((group, groupIndex) => (
                    <div key={`variant-group-${groupIndex}`} className="space-y-2 rounded-md border p-3">
                      <div className="grid grid-cols-12 items-center gap-2">
                        <Input
                          className="col-span-4"
                          placeholder="Group name (e.g. Size)"
                          value={group.name}
                          onChange={(event) =>
                            handleUpdateVariantGroup(groupIndex, 'name', event.target.value)
                          }
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
                            onChange={(event) =>
                              handleUpdateVariantGroup(groupIndex, 'required', event.target.checked)
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
                                  onChange={(event) =>
                                    handleUpdateVariantGroupOption(
                                      groupIndex,
                                      optionIndex,
                                      'label',
                                      event.target.value,
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
                                  onChange={(event) =>
                                    handleUpdateVariantGroupOption(
                                      groupIndex,
                                      optionIndex,
                                      'price',
                                      event.target.value,
                                    )
                                  }
                                />
                              </>
                            ) : (
                              <Input
                                className="col-span-11"
                                placeholder="Option value"
                                value={typeof opt === 'string' ? opt : opt.label}
                                onChange={(event) =>
                                  handleUpdateVariantGroupOption(
                                    groupIndex,
                                    optionIndex,
                                    'value',
                                    event.target.value,
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
                          <Plus className="mr-1 h-4 w-4" />
                          Add Option
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </TabsContent>

          {canEditInventory ? (
            <TabsContent value="inventory" className="space-y-4 pt-2">
              {inventoryLoadError ? (
                <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
                  {inventoryLoadError}
                </div>
              ) : null}
              <MenuItemInventoryTab
                trackInventory={trackInventory}
                rows={ingredientRows}
                onRowsChange={setIngredientRows}
                stockItems={stockItems}
                onStockItemsChange={(items) =>
                  setStockItems((prev) => {
                    const levelById = new Map(prev.map((item) => [item.id, item.currentStock]))
                    return items.map((item) => ({
                      ...item,
                      currentStock: levelById.get(item.id) ?? 0,
                    }))
                  })
                }
                measurementUnits={measurementUnits}
                onMeasurementUnitsChange={setMeasurementUnits}
                disabled={saving || uploadingImage}
              />
            </TabsContent>
          ) : null}

          <TabsContent value="options" className="space-y-4 pt-2">
            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={itemForm.allow_special_instructions}
                onChange={(event) =>
                  setItemForm((prev) => ({
                    ...prev,
                    allow_special_instructions: event.target.checked,
                  }))
                }
                className="rounded"
              />
              <Label>Allow special instructions</Label>
            </div>
            <div className="flex items-center justify-between gap-4 rounded-lg border p-4">
              <div className="space-y-1">
                <Label htmlFor="item-is-popular">Popular Pick</Label>
                <p className="text-sm text-muted-foreground">
                  Show this item in the Popular Picks section on the customer menu
                </p>
              </div>
              <Switch
                id="item-is-popular"
                checked={itemForm.is_popular}
                onCheckedChange={(checked) =>
                  setItemForm((prev) => ({ ...prev, is_popular: checked }))
                }
              />
            </div>
            <div>
              <Label>Status</Label>
              <Select
                value={itemForm.status}
                onValueChange={(value: 'available' | 'out_of_stock' | 'hidden') =>
                  setItemForm((prev) => ({ ...prev, status: value }))
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
            <div className="space-y-3 rounded-md border border-border p-3">
              <div className="flex items-center justify-between gap-4">
                <div className="space-y-1">
                  <Label htmlFor="has-addons">Add-ons</Label>
                  <p className="text-sm text-muted-foreground">
                    Optional paid extras customers can add when ordering.
                  </p>
                </div>
                <Switch
                  id="has-addons"
                  checked={itemForm.has_addons}
                  onCheckedChange={(checked) =>
                    setItemForm((prev) => ({
                      ...prev,
                      has_addons: checked,
                      addons: checked && prev.addons.length === 0 ? [{ name: '', price: 0 }] : prev.addons,
                    }))
                  }
                />
              </div>
              {itemForm.has_addons ? (
                <div className="space-y-2">
                  {itemForm.addons.map((addon, index) => (
                    <div key={`addon-${index}`} className="grid grid-cols-12 items-center gap-2">
                      <Input
                        className="col-span-7"
                        placeholder="Add-on name"
                        value={addon.name}
                        onChange={(event) => handleUpdateAddon(index, 'name', event.target.value)}
                      />
                      <Input
                        className="col-span-4"
                        type="number"
                        step="0.01"
                        placeholder="Price"
                        value={Number.isFinite(addon.price) ? addon.price : ''}
                        onChange={(event) => handleUpdateAddon(index, 'price', event.target.value)}
                      />
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="col-span-1"
                        onClick={() => handleRemoveAddon(index)}
                      >
                        <Trash2 className="h-4 w-4 text-red-500" />
                      </Button>
                    </div>
                  ))}
                  <Button type="button" variant="outline" size="sm" onClick={handleAddAddon}>
                    <Plus className="mr-1 h-4 w-4" />
                    Add Add-on
                  </Button>
                </div>
              ) : null}
            </div>
          </TabsContent>

          <TabsContent value="media" className="space-y-4 pt-2">
            <div>
              <Label>Image</Label>
              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  <Input
                    type="file"
                    accept="image/*"
                    onChange={handleImageFileChange}
                    className="cursor-pointer"
                    disabled={uploadingImage || saving}
                  />
                  {imagePreview ? (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={handleRemoveImage}
                      disabled={uploadingImage || saving}
                    >
                      <X className="h-4 w-4" />
                    </Button>
                  ) : null}
                </div>
                <div className="text-center text-sm text-muted-foreground">or</div>
                <Input
                  value={itemForm.image_url}
                  onChange={(event) => {
                    const value = event.target.value
                    setItemForm((prev) => ({ ...prev, image_url: value, imageFile: null }))
                    setImagePreview(value || null)
                  }}
                  placeholder="Enter image URL..."
                  disabled={uploadingImage || saving || !!itemForm.imageFile}
                />
                {imagePreview ? (
                  <div className="relative h-48 w-full overflow-hidden rounded-lg border bg-gray-50">
                    <Image
                      src={imagePreview}
                      alt="Preview"
                      fill
                      style={{
                        objectFit: itemForm.imageFit,
                        objectPosition: itemForm.imagePosition,
                      }}
                    />
                    {uploadingImage ? (
                      <div className="absolute inset-0 flex items-center justify-center bg-black/50">
                        <Loader2 className="h-8 w-8 animate-spin text-white" />
                      </div>
                    ) : null}
                  </div>
                ) : null}
                {itemForm.imageFile ? (
                  <p className="text-xs text-muted-foreground">
                    Selected: {itemForm.imageFile.name} (
                    {(itemForm.imageFile.size / 1024 / 1024).toFixed(2)} MB)
                  </p>
                ) : null}
              </div>
            </div>
            {imagePreview ? (
              <div className="space-y-4">
                <div>
                  <Label>Image Fit</Label>
                  <Select
                    value={itemForm.imageFit}
                    onValueChange={(value: ItemFormState['imageFit']) =>
                      setItemForm((prev) => ({ ...prev, imageFit: value }))
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
                </div>
                <div>
                  <Label>Image Position</Label>
                  <Select
                    value={itemForm.imagePosition}
                    onValueChange={(value: ItemFormState['imagePosition']) =>
                      setItemForm((prev) => ({ ...prev, imagePosition: value }))
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
              </div>
            ) : null}
          </TabsContent>
        </Tabs>

        {inventorySaveError ? (
          <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-3 text-sm text-amber-900">
            <p>
              {itemForm.name} saved successfully. We couldn&apos;t save the inventory ingredients.
            </p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="mt-2"
              onClick={handleRetryInventorySave}
              disabled={saving || uploadingImage}
            >
              Retry
            </Button>
          </div>
        ) : null}

        <div className="flex justify-end gap-2">
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={uploadingImage || saving}
          >
            Cancel
          </Button>
          <Button
            onClick={handleSaveItem}
            className="bg-[#FF6B35] hover:bg-[#e55a28]"
            disabled={uploadingImage || saving}
          >
            {uploadingImage ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Uploading...
              </>
            ) : saving ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Saving...
              </>
            ) : editingItem ? (
              'Update'
            ) : (
              'Create'
            )}
          </Button>
        </div>
    </>
  )
}

export function MenuItemFormModal({
  open,
  onOpenChange,
  editingItem,
  restaurantId,
  categoryId,
  categoryOptions,
  defaultSubCategoryId = '',
  subCategoryOptions,
  existingItems,
  onSaved,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  editingItem: MenuItem | null
  restaurantId: string | null
  categoryId: string | null
  categoryOptions: Array<{ id: string; name: string }>
  defaultSubCategoryId?: string
  subCategoryOptions: Array<{ id: string; name: string; menuCategoryId: string; menuCategoryName: string }>
  existingItems: ExistingMenuItem[]
  onSaved: () => void | Promise<void>
}) {
  const formKey = editingItem?.id ? `edit-${editingItem.id}` : `new-${defaultSubCategoryId}`

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{editingItem ? 'Edit Menu Item' : 'Add Menu Item'}</DialogTitle>
          <DialogDescription>
            {editingItem
              ? 'Modify item details across tabs — your changes are kept while switching tabs.'
              : 'Create a menu item with pricing, options, media, and optional inventory tracking.'}
          </DialogDescription>
        </DialogHeader>

        {open ? (
          <MenuItemFormContent
            key={formKey}
            editingItem={editingItem}
            defaultSubCategoryId={defaultSubCategoryId}
            restaurantId={restaurantId}
            categoryId={categoryId}
            categoryOptions={categoryOptions}
            subCategoryOptions={subCategoryOptions}
            existingItems={existingItems}
            onOpenChange={onOpenChange}
            onSaved={onSaved}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  )
}
