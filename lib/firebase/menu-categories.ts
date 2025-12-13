import { collection, query, where, orderBy, getDocs, addDoc, updateDoc, doc, getDoc, writeBatch } from 'firebase/firestore'
import { db } from './config'
import { MenuCategory } from './types'

// Get all menu categories for a restaurant
export async function getMenuCategories(restaurantId: string): Promise<MenuCategory[]> {
  if (!db) throw new Error('Firestore is not initialized')
  
  try {
    const q = query(
      collection(db, 'menu_categories'),
      where('restaurant_id', '==', restaurantId),
      where('active', '==', true),
      orderBy('display_order', 'asc')
    )
    
    const snapshot = await getDocs(q)
    return snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as MenuCategory))
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
          collection(db, 'menu_categories'),
          where('restaurant_id', '==', restaurantId),
          where('active', '==', true)
        )
        
        const snapshot = await getDocs(fallbackQuery)
        const categories = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as MenuCategory))
        
        // Sort by display_order in memory
        return categories.sort((a, b) => (a.display_order || 0) - (b.display_order || 0))
      } catch (fallbackError: any) {
        console.error('Fallback query also failed:', fallbackError)
        return []
      }
    }
    throw new Error(error.message || 'Failed to fetch menu categories')
  }
}

// Check if a menu category with the same name already exists (case-insensitive)
export async function menuCategoryExists(restaurantId: string, categoryName: string): Promise<MenuCategory | null> {
  if (!db) throw new Error('Firestore is not initialized')
  
  try {
    const categories = await getMenuCategories(restaurantId)
    
    // Check for duplicate name (case-insensitive)
    const normalizedName = categoryName.trim().toLowerCase()
    const existing = categories.find(
      cat => cat.name.trim().toLowerCase() === normalizedName && cat.active
    )
    
    return existing || null
  } catch (error: any) {
    console.warn('Could not check for duplicate menu category:', error.message)
    return null
  }
}

// Create a new menu category
export async function createMenuCategory(
  restaurantId: string,
  name: string,
  description?: string
): Promise<string> {
  if (!db) throw new Error('Firestore is not initialized')
  
  try {
    // Check for duplicate name
    const existing = await menuCategoryExists(restaurantId, name)
    if (existing) {
      throw new Error(`A category named "${name}" already exists`)
    }
    
    // Get max display_order
    const categories = await getMenuCategories(restaurantId)
    const maxOrder = categories.length > 0 
      ? Math.max(...categories.map(c => c.display_order))
      : 0
    
    const docRef = await addDoc(collection(db, 'menu_categories'), {
      restaurant_id: restaurantId,
      name: name.trim(),
      description: description?.trim() || null,
      display_order: maxOrder + 1,
      active: true,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    return docRef.id
  } catch (error: any) {
    throw new Error(error.message || 'Failed to create menu category')
  }
}

// Update a menu category
export async function updateMenuCategory(
  categoryId: string,
  data: Partial<MenuCategory>
): Promise<void> {
  if (!db) throw new Error('Firestore is not initialized')
  
  try {
    const docRef = doc(db, 'menu_categories', categoryId)
    await updateDoc(docRef, {
      ...data,
      updated_at: new Date().toISOString(),
    } as any)
  } catch (error: any) {
    throw new Error(error.message || 'Failed to update menu category')
  }
}

// Delete a menu category (soft delete by setting active to false)
export async function deleteMenuCategory(categoryId: string): Promise<void> {
  if (!db) throw new Error('Firestore is not initialized')
  
  try {
    // Check if has sub-categories (import will be added when sub_categories service exists)
    // For now, we'll check in the component
    await updateMenuCategory(categoryId, { active: false })
  } catch (error: any) {
    throw new Error(error.message || 'Failed to delete menu category')
  }
}

// Get a single menu category
export async function getMenuCategory(categoryId: string): Promise<MenuCategory | null> {
  if (!db) throw new Error('Firestore is not initialized')
  
  try {
    const docRef = doc(db, 'menu_categories', categoryId)
    const docSnap = await getDoc(docRef)
    
    if (docSnap.exists()) {
      return { id: docSnap.id, ...docSnap.data() } as MenuCategory
    }
    return null
  } catch (error: any) {
    throw new Error(error.message || 'Failed to fetch menu category')
  }
}

