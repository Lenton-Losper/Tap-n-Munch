import { collection, query, where, orderBy, getDocs, addDoc, updateDoc, doc, deleteDoc, getDoc, writeBatch } from 'firebase/firestore'
import { db } from './config'

export interface Category {
  id: string
  restaurant_id: string
  name: string
  display_order: number
  active: boolean
  created_at: any
}

// Get all categories for a restaurant
export async function getCategories(restaurantId: string): Promise<Category[]> {
  if (!db) throw new Error('Firestore is not initialized')
  
  try {
    // Try the optimized query with index first
    const q = query(
      collection(db, 'categories'),
      where('restaurant_id', '==', restaurantId),
      where('active', '==', true),
      orderBy('display_order', 'asc')
    )
    
    const snapshot = await getDocs(q)
    return snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as Category))
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
          collection(db, 'categories'),
          where('restaurant_id', '==', restaurantId),
          where('active', '==', true)
        )
        
        const snapshot = await getDocs(fallbackQuery)
        const categories = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as Category))
        
        // Sort by display_order in memory
        return categories.sort((a, b) => (a.display_order || 0) - (b.display_order || 0))
      } catch (fallbackError: any) {
        console.error('Fallback query also failed:', fallbackError)
        // If even the fallback fails, return empty array
        return []
      }
    }
    throw new Error(error.message || 'Failed to fetch categories')
  }
}

// Check if a category with the same name already exists (case-insensitive)
export async function categoryExists(restaurantId: string, categoryName: string): Promise<Category | null> {
  if (!db) throw new Error('Firestore is not initialized')
  
  try {
    // Get all categories for the restaurant
    const categories = await getCategories(restaurantId)
    
    // Check for duplicate name (case-insensitive)
    const normalizedName = categoryName.trim().toLowerCase()
    const existing = categories.find(
      cat => cat.name.trim().toLowerCase() === normalizedName && cat.active
    )
    
    return existing || null
  } catch (error: any) {
    // If getCategories fails (e.g., missing index), we can't check for duplicates
    // Return null to allow creation (better than blocking)
    console.warn('Could not check for duplicate category:', error.message)
    return null
  }
}

// Create a new category
export async function createCategory(data: Omit<Category, 'id' | 'created_at'>): Promise<string> {
  if (!db) throw new Error('Firestore is not initialized')
  
  try {
    // Check for duplicate name
    const existing = await categoryExists(data.restaurant_id, data.name)
    if (existing) {
      throw new Error(`A category named "${data.name}" already exists`)
    }
    
    const docRef = await addDoc(collection(db, 'categories'), {
      ...data,
      created_at: new Date().toISOString(),
    })
    return docRef.id
  } catch (error: any) {
    throw new Error(error.message || 'Failed to create category')
  }
}

// Update a category
export async function updateCategory(categoryId: string, data: Partial<Category>): Promise<void> {
  if (!db) throw new Error('Firestore is not initialized')
  
  try {
    const docRef = doc(db, 'categories', categoryId)
    await updateDoc(docRef, data as any)
  } catch (error: any) {
    throw new Error(error.message || 'Failed to update category')
  }
}

// Delete a category (soft delete by setting active to false)
export async function deleteCategory(categoryId: string): Promise<void> {
  if (!db) throw new Error('Firestore is not initialized')
  
  try {
    await updateCategory(categoryId, { active: false })
  } catch (error: any) {
    throw new Error(error.message || 'Failed to delete category')
  }
}

// Delete all categories for a restaurant (soft delete by setting active to false)
export async function deleteAllCategories(restaurantId: string): Promise<number> {
  if (!db) throw new Error('Firestore is not initialized')
  
  try {
    // Get all categories for the restaurant (using fallback query if index doesn't exist)
    const categories = await getCategories(restaurantId)
    
    if (categories.length === 0) {
      return 0
    }
    
    // Soft delete all categories by setting active to false
    const batch = writeBatch(db)
    let count = 0
    
    for (const category of categories) {
      const categoryRef = doc(db, 'categories', category.id)
      batch.update(categoryRef, { active: false })
      count++
    }
    
    await batch.commit()
    return count
  } catch (error: any) {
    throw new Error(error.message || 'Failed to delete categories')
  }
}

// Find and remove duplicate categories (keeps the first one, soft-deletes the rest)
export async function removeDuplicateCategories(restaurantId: string): Promise<{ removed: number; duplicates: Array<{ name: string; count: number }> }> {
  if (!db) throw new Error('Firestore is not initialized')
  
  try {
    const categories = await getCategories(restaurantId)
    
    // Group by normalized name (case-insensitive)
    const nameMap = new Map<string, Category[]>()
    categories.forEach(cat => {
      const normalizedName = cat.name.trim().toLowerCase()
      if (!nameMap.has(normalizedName)) {
        nameMap.set(normalizedName, [])
      }
      nameMap.get(normalizedName)!.push(cat)
    })
    
    // Find duplicates (groups with more than one category)
    const duplicates: Array<{ name: string; count: number }> = []
    const toDelete: Category[] = []
    
    nameMap.forEach((cats, normalizedName) => {
      if (cats.length > 1) {
        // Keep the first one (lowest display_order or oldest), delete the rest
        const sorted = cats.sort((a, b) => {
          if (a.display_order !== b.display_order) {
            return a.display_order - b.display_order
          }
          // If same order, keep the one with earlier created_at
          const aTime = a.created_at?.toMillis?.() || new Date(a.created_at).getTime()
          const bTime = b.created_at?.toMillis?.() || new Date(b.created_at).getTime()
          return aTime - bTime
        })
        
        duplicates.push({ name: sorted[0].name, count: sorted.length })
        // Mark all except the first for deletion
        toDelete.push(...sorted.slice(1))
      }
    })
    
    // Soft delete duplicates
    if (toDelete.length > 0) {
      const batch = writeBatch(db)
      toDelete.forEach(cat => {
        const catRef = doc(db, 'categories', cat.id)
        batch.update(catRef, { active: false })
      })
      await batch.commit()
    }
    
    return { removed: toDelete.length, duplicates }
  } catch (error: any) {
    throw new Error(error.message || 'Failed to remove duplicate categories')
  }
}

// Create default categories for a restaurant
export async function createDefaultCategories(restaurantId: string): Promise<void> {
  console.log('🔵 createDefaultCategories called with restaurantId:', restaurantId)
  
  if (!db) {
    console.error('❌ Firestore db is not initialized')
    throw new Error('Firestore is not initialized')
  }
  
  console.log('✅ Firestore db is initialized')
  
  try {
    const defaultCategories = [
      { name: 'Starters', display_order: 1 },
      { name: 'Mains', display_order: 2 },
      { name: 'Drinks', display_order: 3 },
      { name: 'Desserts', display_order: 4 },
    ]
    
    console.log('📋 Creating', defaultCategories.length, 'default categories')
    
    // Create all categories (checking for duplicates)
    const categoryIds = []
    const skipped: string[] = []
    
    for (let i = 0; i < defaultCategories.length; i++) {
      const cat = defaultCategories[i]
      console.log(`📝 Creating category ${i + 1}/${defaultCategories.length}: ${cat.name}`)
      
      try {
        // Check if category already exists
        const existing = await categoryExists(restaurantId, cat.name)
        if (existing) {
          console.log(`⏭️  Category "${cat.name}" already exists, skipping`)
          skipped.push(cat.name)
          continue
        }
        
        const categoryId = await createCategory({
          restaurant_id: restaurantId,
          name: cat.name,
          display_order: cat.display_order,
          active: true,
        })
        categoryIds.push(categoryId)
        console.log(`✅ Created category: ${cat.name} (ID: ${categoryId})`)
      } catch (catError: any) {
        // If it's a duplicate error, skip it
        if (catError.message?.includes('already exists')) {
          console.log(`⏭️  Category "${cat.name}" already exists, skipping`)
          skipped.push(cat.name)
          continue
        }
        console.error(`❌ Failed to create category ${cat.name}:`, catError)
        throw catError
      }
    }
    
    console.log('🎉 Successfully created', categoryIds.length, 'categories:', categoryIds)
    if (skipped.length > 0) {
      console.log('⏭️  Skipped', skipped.length, 'existing categories:', skipped)
    }
  } catch (error: any) {
    console.error('❌ Error in createDefaultCategories:', error)
    console.error('Error details:', {
      message: error.message,
      code: error.code,
      stack: error.stack
    })
    throw new Error(error.message || 'Failed to create default categories')
  }
}

