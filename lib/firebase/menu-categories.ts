import { collection, query, where, orderBy, getDocs, addDoc, updateDoc, doc, getDoc, writeBatch, setDoc, serverTimestamp } from 'firebase/firestore'
import { db } from './config'
import { MenuCategory } from './types'
import { menuCategoriesPath, menuCategoryPath, menuDocumentPath } from './paths'

// Ensure menu/data document exists (required for hierarchical structure)
// This is a best-effort function - it won't block queries if it fails
async function ensureMenuDocumentExists(restaurantId: string): Promise<void> {
  if (!db) return // Silently fail - query can proceed without this document
  
  try {
    const menuDocRef = doc(db, menuDocumentPath(restaurantId))
    const menuDocSnap = await getDoc(menuDocRef)
    
    if (!menuDocSnap.exists()) {
      // Try to create the menu/data document if it doesn't exist
      // This might fail if user doesn't have write permissions, but that's OK
      // The collection can still be read even if parent document doesn't exist
      try {
        await setDoc(menuDocRef, {
          created_at: serverTimestamp(),
          version: 1,
        })
        console.log('✅ Created menu/data document for restaurant:', restaurantId)
      } catch (createError: any) {
        // Silently fail - parent document not required for reading subcollections
        console.log('⚠️ Could not create menu/data document (may not have permissions):', createError.message)
      }
    }
  } catch (error: any) {
    // Silently fail - don't block queries
    console.log('⚠️ Could not check menu/data document:', error.message)
  }
}

// Get all menu categories for a restaurant
export async function getMenuCategories(restaurantId: string): Promise<MenuCategory[]> {
  if (!db) throw new Error('Firestore is not initialized')
  
  // Try to ensure menu/data document exists (non-blocking)
  ensureMenuDocumentExists(restaurantId).catch(() => {
    // Ignore errors - document creation is optional
  })
  
  try {
    // NEW: Use hierarchical path - restaurant_id is in the path, no need to filter
    const q = query(
      collection(db, menuCategoriesPath(restaurantId)),
      where('active', '==', true),
      orderBy('display_order', 'asc')
    )
    
    const snapshot = await getDocs(q)
    return snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as MenuCategory))
  } catch (error: any) {
    // Check if it's a permission error
    if (error?.code === 'permission-denied') {
      console.error('Permission denied when fetching menu categories. This usually means:')
      console.error('1. Firestore rules need to be deployed: firebase deploy --only firestore:rules')
      console.error('2. The menu/data document may need to be created')
      console.error('3. Check that the security rules allow reading from restaurants/{id}/menu/data/categories')
      throw new Error('Missing or insufficient permissions. Please ensure Firestore rules are deployed and allow reading menu categories.')
    }
    
    // Check if it's a missing index error
    if (error?.code === 'failed-precondition' && error?.message?.includes('index')) {
      console.warn(
        'Firestore index not found. Using fallback query (slower but works without index). ' +
        'Create the index for better performance: ' + (error.message?.match(/https:\/\/[^\s]+/)?.[0] || '')
      )
      
      // Fallback: Query without orderBy (doesn't require index), then sort in memory
      try {
        const fallbackQuery = query(
          collection(db, menuCategoriesPath(restaurantId)),
          where('active', '==', true)
        )
        
        const snapshot = await getDocs(fallbackQuery)
        const categories = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as MenuCategory))
        
        // Sort by display_order in memory
        return categories.sort((a, b) => (a.display_order || 0) - (b.display_order || 0))
      } catch (fallbackError: any) {
        if (fallbackError?.code === 'permission-denied') {
          throw new Error('Missing or insufficient permissions. Please ensure Firestore rules are deployed.')
        }
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
    // Ensure menu/data document exists first
    await ensureMenuDocumentExists(restaurantId)
    
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
    
    // NEW: Use hierarchical path - remove restaurant_id from document (it's in the path)
    const docRef = await addDoc(collection(db, menuCategoriesPath(restaurantId)), {
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
  restaurantId: string,
  categoryId: string,
  data: Partial<MenuCategory>
): Promise<void> {
  if (!db) throw new Error('Firestore is not initialized')
  
  try {
    // NEW: Use hierarchical path
    const docRef = doc(db, menuCategoryPath(restaurantId, categoryId))
    await updateDoc(docRef, {
      ...data,
      updated_at: new Date().toISOString(),
    } as any)
  } catch (error: any) {
    throw new Error(error.message || 'Failed to update menu category')
  }
}

// Delete a menu category (soft delete by setting active to false)
export async function deleteMenuCategory(restaurantId: string, categoryId: string): Promise<void> {
  if (!db) throw new Error('Firestore is not initialized')
  
  try {
    // Check if has sub-categories (import will be added when sub_categories service exists)
    // For now, we'll check in the component
    await updateMenuCategory(restaurantId, categoryId, { active: false })
  } catch (error: any) {
    throw new Error(error.message || 'Failed to delete menu category')
  }
}

// Get a single menu category
export async function getMenuCategory(restaurantId: string, categoryId: string): Promise<MenuCategory | null> {
  if (!db) throw new Error('Firestore is not initialized')
  
  try {
    // NEW: Use hierarchical path
    const docRef = doc(db, menuCategoryPath(restaurantId, categoryId))
    const docSnap = await getDoc(docRef)
    
    if (docSnap.exists()) {
      return { id: docSnap.id, ...docSnap.data() } as MenuCategory
    }
    return null
  } catch (error: any) {
    throw new Error(error.message || 'Failed to fetch menu category')
  }
}

