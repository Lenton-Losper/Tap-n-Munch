import { collection, query, where, orderBy, getDocs, addDoc, updateDoc, doc, getDoc } from 'firebase/firestore'
import { db } from './config'
import { SubCategory } from './types'

// Get all sub-categories for a menu category
export async function getSubCategories(
  restaurantId: string,
  menuCategoryId: string
): Promise<SubCategory[]> {
  if (!db) throw new Error('Firestore is not initialized')
  
  try {
    const q = query(
      collection(db, 'sub_categories'),
      where('restaurant_id', '==', restaurantId),
      where('menu_category_id', '==', menuCategoryId),
      where('active', '==', true),
      orderBy('display_order', 'asc')
    )
    
    const snapshot = await getDocs(q)
    return snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as SubCategory))
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
          collection(db, 'sub_categories'),
          where('restaurant_id', '==', restaurantId),
          where('menu_category_id', '==', menuCategoryId),
          where('active', '==', true)
        )
        
        const snapshot = await getDocs(fallbackQuery)
        const subcategories = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as SubCategory))
        
        // Sort by display_order in memory
        return subcategories.sort((a, b) => (a.display_order || 0) - (b.display_order || 0))
      } catch (fallbackError: any) {
        console.error('Fallback query also failed:', fallbackError)
        return []
      }
    }
    throw new Error(error.message || 'Failed to fetch sub-categories')
  }
}

// Check if a sub-category with the same name already exists within parent category (case-insensitive)
export async function subCategoryExists(
  restaurantId: string,
  menuCategoryId: string,
  subCategoryName: string
): Promise<SubCategory | null> {
  if (!db) throw new Error('Firestore is not initialized')
  
  try {
    const subcategories = await getSubCategories(restaurantId, menuCategoryId)
    
    // Check for duplicate name (case-insensitive)
    const normalizedName = subCategoryName.trim().toLowerCase()
    const existing = subcategories.find(
      subcat => subcat.name.trim().toLowerCase() === normalizedName && subcat.active
    )
    
    return existing || null
  } catch (error: any) {
    console.warn('Could not check for duplicate sub-category:', error.message)
    return null
  }
}

// Create a new sub-category
export async function createSubCategory(
  restaurantId: string,
  menuCategoryId: string,
  name: string,
  description?: string
): Promise<string> {
  if (!db) throw new Error('Firestore is not initialized')
  
  try {
    // Check for duplicate name within parent category
    const existing = await subCategoryExists(restaurantId, menuCategoryId, name)
    if (existing) {
      throw new Error(`A sub-category named "${name}" already exists in this category`)
    }
    
    // Get max display_order within parent category
    const subcategories = await getSubCategories(restaurantId, menuCategoryId)
    const maxOrder = subcategories.length > 0 
      ? Math.max(...subcategories.map(s => s.display_order))
      : 0
    
    const docRef = await addDoc(collection(db, 'sub_categories'), {
      restaurant_id: restaurantId,
      menu_category_id: menuCategoryId,
      name: name.trim(),
      description: description?.trim() || null,
      display_order: maxOrder + 1,
      active: true,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    return docRef.id
  } catch (error: any) {
    throw new Error(error.message || 'Failed to create sub-category')
  }
}

// Update a sub-category
export async function updateSubCategory(
  subCategoryId: string,
  data: Partial<SubCategory>
): Promise<void> {
  if (!db) throw new Error('Firestore is not initialized')
  
  try {
    const docRef = doc(db, 'sub_categories', subCategoryId)
    await updateDoc(docRef, {
      ...data,
      updated_at: new Date().toISOString(),
    } as any)
  } catch (error: any) {
    throw new Error(error.message || 'Failed to update sub-category')
  }
}

// Delete a sub-category (soft delete by setting active to false)
export async function deleteSubCategory(subCategoryId: string): Promise<void> {
  if (!db) throw new Error('Firestore is not initialized')
  
  try {
    // Check if has menu items will be done in component
    await updateSubCategory(subCategoryId, { active: false })
  } catch (error: any) {
    throw new Error(error.message || 'Failed to delete sub-category')
  }
}

// Get a single sub-category
export async function getSubCategory(subCategoryId: string): Promise<SubCategory | null> {
  if (!db) throw new Error('Firestore is not initialized')
  
  try {
    const docRef = doc(db, 'sub_categories', subCategoryId)
    const docSnap = await getDoc(docRef)
    
    if (docSnap.exists()) {
      return { id: docSnap.id, ...docSnap.data() } as SubCategory
    }
    return null
  } catch (error: any) {
    throw new Error(error.message || 'Failed to fetch sub-category')
  }
}

