import { collection, query, where, orderBy, getDocs, addDoc, updateDoc, doc, getDoc, increment, writeBatch, collectionGroup } from 'firebase/firestore'
import { db } from './config'
import { MenuItem } from './types'
import { getSubCategory } from './sub-categories'
import { getMenuCategories } from './menu-categories'
import { getSubCategories } from './sub-categories'
import { menuItemsPath, menuItemPath } from './paths'
import { serverTimestamp } from 'firebase/firestore'

export interface MenuItemSize {
  name: string
  price_modifier: number
}

export interface MenuItemAddon {
  name: string
  price: number
}

// Get menu items for a restaurant
// NEW: Query all categories, then all subcategories, then all items using hierarchical paths
// NOTE: For cross-subcategory queries, we iterate through the hierarchy
export async function getMenuItems(
  restaurantId: string,
  subCategoryId?: string,
  status?: 'available' | 'out_of_stock' | 'hidden'
): Promise<MenuItem[]> {
  if (!db) throw new Error('Firestore is not initialized')
  
  try {
    // Get all categories
    const categories = await getMenuCategories(restaurantId)
    const allItems: MenuItem[] = []
    
    // Iterate through each category
    for (const category of categories) {
      if (!category.active) continue
      
      // Get all subcategories for this category
      const subcategories = await getSubCategories(restaurantId, category.id)
      
      for (const subcat of subcategories) {
        if (!subcat.active) continue
        
        // Filter by subCategoryId if provided
        if (subCategoryId && subcat.id !== subCategoryId) continue
        
        try {
          // Query items for this subcategory using hierarchical path
          const itemsRef = collection(db, menuItemsPath(restaurantId, category.id, subcat.id))
          const constraints: any[] = []
          
          if (status) {
            constraints.push(where('status', '==', status))
          } else {
            // Exclude hidden items if no status filter
            constraints.push(where('status', '!=', 'hidden'))
          }
          
          constraints.push(orderBy('name', 'asc'))
          
          const q = query(itemsRef, ...constraints)
          const snapshot = await getDocs(q)
          
          const items = snapshot.docs.map(doc => ({
            id: doc.id,
            ...doc.data(),
            // Ensure these fields are set for backward compatibility
            restaurant_id: restaurantId,
            menu_category_id: category.id,
            sub_category_id: subcat.id,
          } as MenuItem))
          
          allItems.push(...items)
        } catch (error: any) {
          // If query fails (e.g., missing index), try without orderBy
          if (error?.code === 'failed-precondition') {
            try {
              const itemsRef = collection(db, menuItemsPath(restaurantId, category.id, subcat.id))
              const fallbackConstraints: any[] = []
              
              if (status) {
                fallbackConstraints.push(where('status', '==', status))
              } else {
                fallbackConstraints.push(where('status', '!=', 'hidden'))
              }
              
              const fallbackQuery = query(itemsRef, ...fallbackConstraints)
              const snapshot = await getDocs(fallbackQuery)
              
              let items = snapshot.docs.map(doc => ({
                id: doc.id,
                ...doc.data(),
                restaurant_id: restaurantId,
                menu_category_id: category.id,
                sub_category_id: subcat.id,
              } as MenuItem))
              
              // Sort in memory
              items.sort((a, b) => a.name.localeCompare(b.name))
              allItems.push(...items)
            } catch (fallbackError: any) {
              console.warn(`Error fetching items for subcategory ${subcat.id}:`, fallbackError.message)
            }
          } else {
            console.warn(`Error fetching items for subcategory ${subcat.id}:`, error.message)
          }
        }
      }
    }
    
    // Final sort by name
    allItems.sort((a, b) => a.name.localeCompare(b.name))
    
    return allItems
  } catch (error: any) {
    console.error('Error fetching menu items:', error)
    return []
  }
}

// Get menu items by sub-category
// NEW: Use hierarchical path - need to find the parent category first
export async function getMenuItemsBySubCategory(
  restaurantId: string,
  subCategoryId: string
): Promise<MenuItem[]> {
  if (!db) throw new Error('Firestore is not initialized')
  
  try {
    // Get all categories to find which one contains this subcategory
    const categories = await getMenuCategories(restaurantId)
    
    for (const category of categories) {
      if (!category.active) continue
      
      // Get subcategories for this category
      const subcategories = await getSubCategories(restaurantId, category.id)
      const subcat = subcategories.find(sc => sc.id === subCategoryId)
      
      if (subcat && subcat.active) {
        // Found the subcategory, now query its items using hierarchical path
        const itemsRef = collection(db, menuItemsPath(restaurantId, category.id, subCategoryId))
        
        try {
          const q = query(
            itemsRef,
            where('status', '!=', 'hidden'),
            orderBy('name', 'asc')
          )
          
          const snapshot = await getDocs(q)
          return snapshot.docs.map(doc => ({
            id: doc.id,
            ...doc.data(),
            restaurant_id: restaurantId,
            menu_category_id: category.id,
            sub_category_id: subCategoryId,
          } as MenuItem))
        } catch (error: any) {
          // If query fails (e.g., missing index), try without orderBy
          if (error?.code === 'failed-precondition') {
            const fallbackQuery = query(
              itemsRef,
              where('status', '!=', 'hidden')
            )
            
            const snapshot = await getDocs(fallbackQuery)
            const items = snapshot.docs.map(doc => ({
              id: doc.id,
              ...doc.data(),
              restaurant_id: restaurantId,
              menu_category_id: category.id,
              sub_category_id: subCategoryId,
            } as MenuItem))
            
            // Sort in memory
            items.sort((a, b) => a.name.localeCompare(b.name))
            return items
          }
          throw error
        }
      }
    }
    
    // Subcategory not found
    return []
  } catch (error: any) {
    console.error('Error fetching menu items by subcategory:', error)
    throw new Error(error.message || 'Failed to fetch menu items')
  }
}

// Get menu items by menu category, grouped by sub-category (for customer menu)
// NEW: Query using hierarchical structure - get subcategories for category, then items for each
export async function getMenuItemsByCategory(
  restaurantId: string,
  menuCategoryId: string
): Promise<Record<string, { subcategory: any; items: MenuItem[] }>> {
  if (!db) throw new Error('Firestore is not initialized')
  
  try {
    // NEW: Get all subcategories for this menu category
    const subcategories = await getSubCategories(restaurantId, menuCategoryId)
    
    const grouped: Record<string, { subcategory: any; items: MenuItem[] }> = {}
    
    // For each subcategory, get its items
    for (const subcat of subcategories) {
      if (!subcat.active) continue
      
      try {
        // Use hierarchical path to query items for this subcategory
        const itemsRef = collection(db, menuItemsPath(restaurantId, menuCategoryId, subcat.id))
        const itemsQuery = query(
          itemsRef,
          where('status', '==', 'available'),
          orderBy('name', 'asc')
        )
        
        const snapshot = await getDocs(itemsQuery)
        const items = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as MenuItem))
        
        if (items.length > 0) {
          grouped[subcat.id] = {
            subcategory: subcat,
            items: items
          }
        }
      } catch (error: any) {
        // If query fails (e.g., missing index), try without orderBy
        try {
          const itemsRef = collection(db, menuItemsPath(restaurantId, menuCategoryId, subcat.id))
          const fallbackQuery = query(
            itemsRef,
            where('status', '==', 'available')
          )
          
          const snapshot = await getDocs(fallbackQuery)
          let items = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as MenuItem))
          items.sort((a, b) => a.name.localeCompare(b.name))
          
          if (items.length > 0) {
            grouped[subcat.id] = {
              subcategory: subcat,
              items: items
            }
          }
        } catch (fallbackError: any) {
          console.error(`Error fetching items for subcategory ${subcat.id}:`, fallbackError)
        }
      }
    }
    
    console.log(`Grouped into ${Object.keys(grouped).length} sub-categories for category ${menuCategoryId}`)
    return grouped
  } catch (error: any) {
    console.error('Error fetching menu items by category:', error)
    return {}
  }
}

// Search menu items
export async function searchMenuItems(
  restaurantId: string,
  searchQuery: string
): Promise<MenuItem[]> {
  if (!db) throw new Error('Firestore is not initialized')
  
  try {
    // Note: Firestore doesn't support full-text search natively
    // This is a simple prefix search - for production, consider Algolia or similar
    // Get all items for this restaurant (excluding hidden)
    const allItems = await getMenuItems(restaurantId, undefined, undefined)
    const queryLower = searchQuery.toLowerCase().trim()
    
    if (!queryLower) {
      return allItems
    }
    
    // Filter items that match the search query
    return allItems.filter(item => {
      // Only show available or out_of_stock items (not hidden)
      if (item.status === 'hidden') {
        return false
      }
      
      // Search in name and description
      return item.name.toLowerCase().includes(queryLower) ||
             item.description?.toLowerCase().includes(queryLower)
    })
  } catch (error: any) {
    console.error('Error searching menu items:', error)
    throw new Error(error.message || 'Failed to search menu items')
  }
}

// Get a single menu item
// NOTE: This uses collectionGroup to find the item by ID across all restaurants
// For better performance, use getMenuItemByPath if you know the full path
export async function getMenuItem(itemId: string, restaurantId?: string): Promise<MenuItem | null> {
  if (!db) throw new Error('Firestore is not initialized')
  
  try {
    // If restaurantId is provided, we can search more efficiently
    if (restaurantId) {
      // Get all items for this restaurant and find by ID
      const allItems = await getMenuItems(restaurantId)
      return allItems.find(item => item.id === itemId) || null
    }
    
    // Otherwise, use collectionGroup to find across all restaurants (slower)
    const q = query(collectionGroup(db, 'items'))
    const snapshot = await getDocs(q)
    
    const item = snapshot.docs
      .find(doc => doc.id === itemId)
    
    if (item) {
      const pathParts = item.ref.path.split('/')
      return {
        id: item.id,
        ...item.data(),
        restaurant_id: pathParts[1] || '',
        menu_category_id: pathParts[5] || '',
        sub_category_id: pathParts[7] || '',
      } as MenuItem
    }
    
    return null
  } catch (error: any) {
    throw new Error(error.message || 'Failed to fetch menu item')
  }
}

// Get a single menu item by full path (more efficient)
export async function getMenuItemByPath(
  restaurantId: string,
  categoryId: string,
  subCategoryId: string,
  itemId: string
): Promise<MenuItem | null> {
  if (!db) throw new Error('Firestore is not initialized')
  
  try {
    const docRef = doc(db, menuItemPath(restaurantId, categoryId, subCategoryId, itemId))
    const docSnap = await getDoc(docRef)
    
    if (docSnap.exists()) {
      return {
        id: docSnap.id,
        ...docSnap.data(),
        restaurant_id: restaurantId,
        menu_category_id: categoryId,
        sub_category_id: subCategoryId,
      } as MenuItem
    }
    return null
  } catch (error: any) {
    throw new Error(error.message || 'Failed to fetch menu item')
  }
}

// Check if a menu item with the same name already exists in the same sub-category (case-insensitive)
// Note: Menu items CAN have duplicate names in different sub-categories (this is allowed)
export async function menuItemExists(restaurantId: string, subCategoryId: string, itemName: string): Promise<MenuItem | null> {
  if (!db) throw new Error('Firestore is not initialized')
  
  try {
    // Get all items for this restaurant and sub-category
    const items = await getMenuItemsBySubCategory(restaurantId, subCategoryId)
    
    // Check for duplicate name (case-insensitive)
    const normalizedName = itemName.trim().toLowerCase()
    const existing = items.find(
      item => item.name.trim().toLowerCase() === normalizedName && item.status !== 'hidden'
    )
    
    return existing || null
  } catch (error: any) {
    // If getMenuItems fails (e.g., missing index), we can't check for duplicates
    // Return null to allow creation (better than blocking)
    console.warn('Could not check for duplicate menu item:', error.message)
    return null
  }
}

// Create a new menu item
export async function createMenuItem(
  data: Omit<MenuItem, 'id' | 'times_ordered' | 'total_revenue' | 'created_at' | 'updated_at' | 'menu_category_id' | 'restaurant_id'>
): Promise<string> {
  if (!db) throw new Error('Firestore is not initialized')
  
  try {
    // Validate required fields
    if (!data.restaurant_id) {
      throw new Error('restaurant_id is required')
    }
    if (!data.sub_category_id) {
      throw new Error('sub_category_id is required')
    }
    
    // Get sub-category to find parent menu_category_id
    // Need to search through categories to find which one contains this subcategory
    const categories = await getMenuCategories(data.restaurant_id)
    let foundCategoryId: string | null = null
    
    for (const category of categories) {
      const subcategories = await getSubCategories(data.restaurant_id, category.id)
      const subcat = subcategories.find(sc => sc.id === data.sub_category_id)
      
      if (subcat) {
        foundCategoryId = category.id
        break
      }
    }
    
    if (!foundCategoryId) {
      throw new Error('Sub-category not found')
    }
    
    // Use hierarchical path to create the item
    const itemsRef = collection(db, menuItemsPath(data.restaurant_id, foundCategoryId, data.sub_category_id))
    
    // Prepare item data (remove restaurant_id from document as it's in path)
    // Keep sub_category_id in document for collectionGroup queries if needed
    const { restaurant_id, ...itemData } = data
    
    const docRef = await addDoc(itemsRef, {
      ...itemData,
      times_ordered: 0,
      total_revenue: 0,
      created_at: serverTimestamp(),
      updated_at: serverTimestamp(),
    })
    
    return docRef.id
  } catch (error: any) {
    throw new Error(error.message || 'Failed to create menu item')
  }
}

// Update a menu item
// NOTE: This requires the full path. If you only have itemId, use updateMenuItemById which uses collectionGroup
export async function updateMenuItem(
  restaurantId: string,
  categoryId: string,
  subCategoryId: string,
  itemId: string,
  data: Partial<MenuItem>
): Promise<void> {
  if (!db) throw new Error('Firestore is not initialized')
  
  try {
    const docRef = doc(db, menuItemPath(restaurantId, categoryId, subCategoryId, itemId))
    
    // Remove fields that are in the path
    const { restaurant_id, menu_category_id, sub_category_id, ...updateData } = data
    
    await updateDoc(docRef, {
      ...updateData,
      updated_at: serverTimestamp(),
    } as any)
  } catch (error: any) {
    throw new Error(error.message || 'Failed to update menu item')
  }
}

// Update a menu item by ID only (uses collectionGroup to find it)
export async function updateMenuItemById(
  itemId: string,
  data: Partial<MenuItem>,
  restaurantId?: string
): Promise<void> {
  if (!db) throw new Error('Firestore is not initialized')
  
  try {
    // If restaurantId is provided, get the item first to find its path
    if (restaurantId) {
      const item = await getMenuItem(itemId, restaurantId)
      if (!item) {
        throw new Error('Menu item not found')
      }
      
      // Find the category and subcategory by searching
      const categories = await getMenuCategories(restaurantId)
      for (const category of categories) {
        const subcategories = await getSubCategories(restaurantId, category.id)
        const subcat = subcategories.find(sc => sc.id === item.sub_category_id)
        
        if (subcat) {
          return updateMenuItem(restaurantId, category.id, item.sub_category_id, itemId, data)
        }
      }
      
      throw new Error('Menu item path not found')
    }
    
    // Otherwise, use collectionGroup to find the item
    const q = query(collectionGroup(db, 'items'))
    const snapshot = await getDocs(q)
    const itemDoc = snapshot.docs.find(doc => doc.id === itemId)
    
    if (!itemDoc) {
      throw new Error('Menu item not found')
    }
    
    const pathParts = itemDoc.ref.path.split('/')
    const restaurantIdFromPath = pathParts[1]
    const categoryIdFromPath = pathParts[5]
    const subCategoryIdFromPath = pathParts[7]
    
    return updateMenuItem(restaurantIdFromPath, categoryIdFromPath, subCategoryIdFromPath, itemId, data)
  } catch (error: any) {
    throw new Error(error.message || 'Failed to update menu item')
  }
}

// Update menu item analytics (when order is placed)
export async function updateMenuItemStats(
  restaurantId: string,
  categoryId: string,
  subCategoryId: string,
  itemId: string,
  quantity: number,
  revenue: number
): Promise<void> {
  if (!db) throw new Error('Firestore is not initialized')
  
  try {
    const docRef = doc(db, menuItemPath(restaurantId, categoryId, subCategoryId, itemId))
    await updateDoc(docRef, {
      times_ordered: increment(quantity),
      total_revenue: increment(revenue),
      updated_at: serverTimestamp(),
    })
  } catch (error: any) {
    throw new Error(error.message || 'Failed to update menu item stats')
  }
}

// Find and remove duplicate menu items (keeps the first one, soft-deletes the rest)
// Groups by sub_category_id and name (case-insensitive)
export async function removeDuplicateMenuItems(restaurantId: string, subCategoryId?: string): Promise<{ removed: number; duplicates: Array<{ name: string; subcategory: string; count: number }> }> {
  if (!db) throw new Error('Firestore is not initialized')
  
  try {
    const items = subCategoryId 
      ? await getMenuItemsBySubCategory(restaurantId, subCategoryId)
      : await getMenuItems(restaurantId)
    
    // Group by sub_category_id and normalized name (case-insensitive)
    const itemMap = new Map<string, MenuItem[]>()
    items.forEach(item => {
      const key = `${item.sub_category_id || item.category_id}:${item.name.trim().toLowerCase()}`
      if (!itemMap.has(key)) {
        itemMap.set(key, [])
      }
      itemMap.get(key)!.push(item)
    })
    
    // Find duplicates (groups with more than one item)
    const duplicates: Array<{ name: string; subcategory: string; count: number }> = []
    const toDelete: MenuItem[] = []
    
    itemMap.forEach((items, key) => {
      if (items.length > 1) {
        // Keep the first one (by name or oldest), delete the rest
        const sorted = items.sort((a, b) => {
          // Sort by name first, then by created_at
          const nameCompare = a.name.localeCompare(b.name)
          if (nameCompare !== 0) return nameCompare
          
          const aTime = a.created_at?.toMillis?.() || new Date(a.created_at).getTime()
          const bTime = b.created_at?.toMillis?.() || new Date(b.created_at).getTime()
          return aTime - bTime
        })
        
        duplicates.push({ 
          name: sorted[0].name, 
          subcategory: sorted[0].sub_category_id || sorted[0].category_id || 'unknown', 
          count: sorted.length 
        })
        // Mark all except the first for deletion
        toDelete.push(...sorted.slice(1))
      }
    })
    
    // Soft delete duplicates
    if (toDelete.length > 0) {
      const batch = writeBatch(db)
      toDelete.forEach(item => {
        const itemRef = doc(db, 'menu_items', item.id)
        batch.update(itemRef, { status: 'hidden' })
      })
      await batch.commit()
    }
    
    return { removed: toDelete.length, duplicates }
  } catch (error: any) {
    throw new Error(error.message || 'Failed to remove duplicate menu items')
  }
}

// Delete a menu item (soft delete by setting status to hidden)
export async function deleteMenuItem(
  restaurantId: string,
  categoryId: string,
  subCategoryId: string,
  itemId: string
): Promise<void> {
  if (!db) throw new Error('Firestore is not initialized')
  
  try {
    await updateMenuItem(restaurantId, categoryId, subCategoryId, itemId, { status: 'hidden' })
  } catch (error: any) {
    throw new Error(error.message || 'Failed to delete menu item')
  }
}

// Delete a menu item by ID only (uses collectionGroup to find it)
export async function deleteMenuItemById(itemId: string, restaurantId?: string): Promise<void> {
  if (!db) throw new Error('Firestore is not initialized')
  
  try {
    await updateMenuItemById(itemId, { status: 'hidden' }, restaurantId)
  } catch (error: any) {
    throw new Error(error.message || 'Failed to delete menu item')
  }
}

