import { collection, query, where, orderBy, getDocs, addDoc, updateDoc, doc, getDoc, increment, writeBatch } from 'firebase/firestore'
import { db } from './config'
import { MenuItem } from './types'
import { getSubCategory } from './sub-categories'

export interface MenuItemSize {
  name: string
  price_modifier: number
}

export interface MenuItemAddon {
  name: string
  price: number
}

// Get menu items for a restaurant (supports both legacy category_id and new sub_category_id)
export async function getMenuItems(
  restaurantId: string,
  subCategoryId?: string,
  status?: 'available' | 'out_of_stock' | 'hidden'
): Promise<MenuItem[]> {
  if (!db) throw new Error('Firestore is not initialized')
  
  try {
    // Build query constraints
    const constraints: any[] = [
      where('restaurant_id', '==', restaurantId)
    ]
    
    // Add sub-category filter if provided (prefer new field, fallback to legacy)
    if (subCategoryId) {
      // Try new field first, but also support legacy category_id for migration
      constraints.push(where('sub_category_id', '==', subCategoryId))
    }
    
    // Add status filter
    if (status) {
      constraints.push(where('status', '==', status))
    }
    
    // Add ordering
    constraints.push(orderBy('name', 'asc'))
    
    // Build query
    let q = query(collection(db, 'menu_items'), ...constraints)
    
    const snapshot = await getDocs(q)
    let items = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as MenuItem))
    
    // Filter out hidden items in memory (avoids complex index requirements)
    if (!status) {
      items = items.filter(item => item.status !== 'hidden')
    }
    
    return items
  } catch (error: any) {
    // Check if it's a missing index error
    if (error?.code === 'failed-precondition' && error?.message?.includes('index')) {
      const indexUrlMatch = error.message?.match(/https:\/\/[^\s]+/)
      const indexUrl = indexUrlMatch ? indexUrlMatch[0] : null
      console.warn(
        'Firestore index not found. Using fallback query (slower but works without index). ' +
        'Create the index for better performance: ' + (indexUrl || 'see console')
      )
      if (indexUrl) {
        console.warn('Index creation URL:', indexUrl)
      }
      
      // Fallback: fetch all items without orderBy (works without index)
      try {
        const fallbackQuery = query(
          collection(db, 'menu_items'),
          where('restaurant_id', '==', restaurantId)
        )
        const snapshot = await getDocs(fallbackQuery)
        let items = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as MenuItem))
        
        // Filter by status in memory if needed
        if (status) {
          items = items.filter(item => item.status === status)
        } else {
          items = items.filter(item => item.status !== 'hidden')
        }
        
        // Sort in memory
        items.sort((a, b) => a.name.localeCompare(b.name))
        
        return items
      } catch (fallbackError: any) {
        console.error('Fallback query also failed:', fallbackError)
        // Return empty array instead of throwing - allows UI to show empty state
        return []
      }
    }
    console.error('Error fetching menu items:', error)
    // Return empty array instead of throwing - allows UI to show empty state
    return []
  }
}

// Get menu items by sub-category (new function)
export async function getMenuItemsBySubCategory(
  restaurantId: string,
  subCategoryId: string
): Promise<MenuItem[]> {
  if (!db) throw new Error('Firestore is not initialized')
  
  try {
    const q = query(
      collection(db, 'menu_items'),
      where('restaurant_id', '==', restaurantId),
      where('sub_category_id', '==', subCategoryId),
      orderBy('name', 'asc')
    )
    
    const snapshot = await getDocs(q)
    let items = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as MenuItem))
    
    // Filter out hidden items
    items = items.filter(item => item.status !== 'hidden')
    
    return items
  } catch (error: any) {
    // Check if it's a missing index error
    if (error?.code === 'failed-precondition' && error?.message?.includes('index')) {
      console.warn(
        'Firestore index not found. Using fallback query (slower but works without index). ' +
        'Create the index for better performance: ' + (error.message?.match(/https:\/\/[^\s]+/)?.[0] || '')
      )
      
      // Fallback: Query without orderBy (doesn't require index), then sort in memory
      try {
        const fallbackQuery = query(
          collection(db, 'menu_items'),
          where('restaurant_id', '==', restaurantId),
          where('sub_category_id', '==', subCategoryId)
        )
        
        const snapshot = await getDocs(fallbackQuery)
        let items = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as MenuItem))
        
        // Filter out hidden items and sort by name in memory
        items = items.filter(item => item.status !== 'hidden')
        items.sort((a, b) => a.name.localeCompare(b.name))
        
        return items
      } catch (fallbackError: any) {
        console.error('Fallback query also failed:', fallbackError)
        return []
      }
    }
    throw new Error(error.message || 'Failed to fetch menu items')
  }
}

// Get menu items by menu category, grouped by sub-category (for customer menu)
export async function getMenuItemsByCategory(
  restaurantId: string,
  menuCategoryId: string
): Promise<Record<string, { subcategory: any; items: MenuItem[] }>> {
  if (!db) throw new Error('Firestore is not initialized')
  
  try {
    // Try query without status filter first (to avoid index requirement)
    // We'll filter status in memory
    const q = query(
      collection(db, 'menu_items'),
      where('restaurant_id', '==', restaurantId),
      where('menu_category_id', '==', menuCategoryId)
    )
    
    const snapshot = await getDocs(q)
    let items = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as MenuItem))
    
    // Filter by status in memory (only show available items)
    items = items.filter(item => item.status === 'available' && item.status !== 'hidden')
    
    console.log(`Query returned ${items.length} available items for category ${menuCategoryId}`)
    
    // Group by sub-category
    const grouped: Record<string, { subcategory: any; items: MenuItem[] }> = {}
    const subCategoryCache = new Map<string, any>()
    
    // Sort items by sub_category_id and name in memory
    items.sort((a, b) => {
      if (a.sub_category_id !== b.sub_category_id) {
        return (a.sub_category_id || '').localeCompare(b.sub_category_id || '')
      }
      return a.name.localeCompare(b.name)
    })
    
    for (const item of items) {
      if (!item.sub_category_id) {
        console.warn('Menu item missing sub_category_id:', item.id, item.name)
        continue
      }
      
      if (!grouped[item.sub_category_id]) {
        // Fetch sub-category if not cached
        if (!subCategoryCache.has(item.sub_category_id)) {
          try {
            const subcat = await getSubCategory(item.sub_category_id)
            if (subcat && subcat.active) {
              subCategoryCache.set(item.sub_category_id, subcat)
            } else {
              console.warn('Sub-category not found or inactive:', item.sub_category_id)
              continue
            }
          } catch (err) {
            console.error('Error fetching sub-category:', item.sub_category_id, err)
            continue
          }
        }
        
        const subcat = subCategoryCache.get(item.sub_category_id)
        if (subcat) {
          grouped[item.sub_category_id] = {
            subcategory: subcat,
            items: []
          }
        }
      }
      
      if (grouped[item.sub_category_id]) {
        grouped[item.sub_category_id].items.push(item)
      }
    }
    
    return grouped
  } catch (error: any) {
    // Check if it's a missing index error
    if (error?.code === 'failed-precondition' && error?.message?.includes('index')) {
      console.warn(
        'Firestore index not found. Using fallback query (slower but works without index). ' +
        'Create the index for better performance: ' + (error.message?.match(/https:\/\/[^\s]+/)?.[0] || '')
      )
    } else {
      console.warn('Query failed, using fallback:', error.message)
    }
    
    // Fallback: fetch all items and filter/group in memory
    try {
      // Get all items for restaurant (without status filter to avoid index requirement)
      const allItemsQuery = query(
        collection(db, 'menu_items'),
        where('restaurant_id', '==', restaurantId)
      )
      
      const snapshot = await getDocs(allItemsQuery)
      let allItems = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as MenuItem))
      
      // Filter by menu_category_id and status in memory
      const filtered = allItems.filter(item => {
        const matchesCategory = item.menu_category_id === menuCategoryId
        const isAvailable = item.status === 'available'
        const notHidden = item.status !== 'hidden'
        
        if (!matchesCategory && item.menu_category_id) {
          console.log(`Item ${item.id} (${item.name}) has menu_category_id: ${item.menu_category_id}, expected: ${menuCategoryId}`)
        }
        if (!item.menu_category_id) {
          console.warn(`Item ${item.id} (${item.name}) is missing menu_category_id`)
        }
        
        return matchesCategory && isAvailable && notHidden
      })
      
      console.log(`Found ${filtered.length} items for category ${menuCategoryId} (from ${allItems.length} total items)`)
      if (filtered.length === 0 && allItems.length > 0) {
        console.warn('No items matched the filter. Sample items:', allItems.slice(0, 3).map(item => ({
          id: item.id,
          name: item.name,
          menu_category_id: item.menu_category_id,
          sub_category_id: item.sub_category_id,
          status: item.status
        })))
      }
      
      const grouped: Record<string, { subcategory: any; items: MenuItem[] }> = {}
      const subCategoryCache = new Map<string, any>()
      
      // Sort items by sub_category_id and name
      filtered.sort((a, b) => {
        if (a.sub_category_id !== b.sub_category_id) {
          return (a.sub_category_id || '').localeCompare(b.sub_category_id || '')
        }
        return a.name.localeCompare(b.name)
      })
      
      for (const item of filtered) {
        if (!item.sub_category_id) {
          console.warn('Menu item missing sub_category_id:', item.id, item.name)
          continue
        }
        
        if (!grouped[item.sub_category_id]) {
          if (!subCategoryCache.has(item.sub_category_id)) {
            try {
              const subcat = await getSubCategory(item.sub_category_id)
              if (subcat && subcat.active) {
                subCategoryCache.set(item.sub_category_id, subcat)
              } else {
                console.warn('Sub-category not found or inactive:', item.sub_category_id)
                continue
              }
            } catch (err) {
              console.error('Error fetching sub-category:', item.sub_category_id, err)
              continue
            }
          }
          
          const subcat = subCategoryCache.get(item.sub_category_id)
          if (subcat) {
            grouped[item.sub_category_id] = {
              subcategory: subcat,
              items: []
            }
          }
        }
        
        if (grouped[item.sub_category_id]) {
          grouped[item.sub_category_id].items.push(item)
        }
      }
      
      console.log(`Grouped into ${Object.keys(grouped).length} sub-categories`)
      return grouped
    } catch (fallbackError: any) {
      console.error('Fallback query also failed:', fallbackError)
      return {}
    }
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
export async function getMenuItem(itemId: string): Promise<MenuItem | null> {
  if (!db) throw new Error('Firestore is not initialized')
  
  try {
    const docRef = doc(db, 'menu_items', itemId)
    const docSnap = await getDoc(docRef)
    
    if (docSnap.exists()) {
      return { id: docSnap.id, ...docSnap.data() } as MenuItem
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
  data: Omit<MenuItem, 'id' | 'times_ordered' | 'total_revenue' | 'created_at' | 'updated_at' | 'menu_category_id'>
): Promise<string> {
  if (!db) throw new Error('Firestore is not initialized')
  
  try {
    // Validate sub_category_id is provided
    if (!data.sub_category_id) {
      throw new Error('sub_category_id is required')
    }
    
    // Get sub-category to find parent menu_category_id
    const subcat = await getSubCategory(data.sub_category_id)
    if (!subcat) {
      throw new Error('Sub-category not found')
    }
    
    // Check for duplicate name in the same sub-category (optional - items can have duplicate names)
    // Uncomment if you want to prevent duplicates within same sub-category
    // const existing = await menuItemExists(data.restaurant_id, data.sub_category_id, data.name)
    // if (existing) {
    //   throw new Error(`A menu item named "${data.name}" already exists in this sub-category`)
    // }
    
    const docRef = await addDoc(collection(db, 'menu_items'), {
      ...data,
      menu_category_id: subcat.menu_category_id, // Denormalized for quick filtering
      times_ordered: 0,
      total_revenue: 0,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    return docRef.id
  } catch (error: any) {
    throw new Error(error.message || 'Failed to create menu item')
  }
}

// Update a menu item
export async function updateMenuItem(itemId: string, data: Partial<MenuItem>): Promise<void> {
  if (!db) throw new Error('Firestore is not initialized')
  
  try {
    const docRef = doc(db, 'menu_items', itemId)
    await updateDoc(docRef, {
      ...data,
      updated_at: new Date().toISOString(),
    } as any)
  } catch (error: any) {
    throw new Error(error.message || 'Failed to update menu item')
  }
}

// Update menu item analytics (when order is placed)
export async function updateMenuItemStats(
  itemId: string,
  quantity: number,
  revenue: number
): Promise<void> {
  if (!db) throw new Error('Firestore is not initialized')
  
  try {
    const docRef = doc(db, 'menu_items', itemId)
    await updateDoc(docRef, {
      times_ordered: increment(quantity),
      total_revenue: increment(revenue),
      updated_at: new Date().toISOString(),
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
export async function deleteMenuItem(itemId: string): Promise<void> {
  if (!db) throw new Error('Firestore is not initialized')
  
  try {
    await updateMenuItem(itemId, { status: 'hidden' })
  } catch (error: any) {
    throw new Error(error.message || 'Failed to delete menu item')
  }
}

