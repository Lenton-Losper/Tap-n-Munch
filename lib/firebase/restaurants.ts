import { doc, getDoc, setDoc, updateDoc, serverTimestamp } from 'firebase/firestore'
import { db } from './config'
import type { Restaurant } from './types'

// Re-export for backward compatibility
export type { Restaurant }

// Get restaurant by ID
export async function getRestaurant(restaurantId: string): Promise<Restaurant | null> {
  if (!db) throw new Error('Firestore is not initialized')
  
  try {
    const docRef = doc(db, 'restaurants', restaurantId)
    const docSnap = await getDoc(docRef)
    
    if (docSnap.exists()) {
      return { id: docSnap.id, ...docSnap.data() } as Restaurant
    }
    return null
  } catch (error: any) {
    throw new Error(error.message || 'Failed to fetch restaurant')
  }
}

// Create or update restaurant
export async function saveRestaurant(
  restaurantId: string,
  data: Partial<Restaurant>
): Promise<void> {
  if (!db) throw new Error('Firestore is not initialized')
  
  try {
    const docRef = doc(db, 'restaurants', restaurantId)
    const docSnap = await getDoc(docRef)
    
    if (docSnap.exists()) {
      await updateDoc(docRef, {
        ...data,
        updated_at: serverTimestamp(),
      })
    } else {
      await setDoc(docRef, {
        ...data,
        created_at: serverTimestamp(),
        updated_at: serverTimestamp(),
      })
    }
  } catch (error: any) {
    throw new Error(error.message || 'Failed to save restaurant')
  }
}

// Update restaurant settings
export async function updateRestaurantSettings(
  restaurantId: string,
  settings: Partial<Restaurant>
): Promise<void> {
  if (!db) throw new Error('Firestore is not initialized')
  
  try {
    const docRef = doc(db, 'restaurants', restaurantId)
    await updateDoc(docRef, {
      ...settings,
      updated_at: serverTimestamp(),
    })
  } catch (error: any) {
    throw new Error(error.message || 'Failed to update restaurant settings')
  }
}

