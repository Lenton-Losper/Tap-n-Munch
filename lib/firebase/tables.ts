import { collection, query, where, orderBy, getDocs, addDoc, updateDoc, doc, getDoc } from 'firebase/firestore'
import { db } from './config'

export interface Table {
  id: string
  restaurant_id: string
  table_number: number
  table_name: string
  location?: string
  qr_code_url: string
  qr_code_image?: string
  active: boolean
  created_at: any
}

// Get all tables for a restaurant
export async function getTables(restaurantId: string): Promise<Table[]> {
  if (!db) throw new Error('Firestore is not initialized')
  
  try {
    const q = query(
      collection(db, 'tables'),
      where('restaurant_id', '==', restaurantId),
      where('active', '==', true),
      orderBy('table_number', 'asc')
    )
    
    const snapshot = await getDocs(q)
    return snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as Table))
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
      
      // Fallback: fetch all tables without orderBy (works without index)
      try {
        const fallbackQuery = query(
          collection(db, 'tables'),
          where('restaurant_id', '==', restaurantId),
          where('active', '==', true)
        )
        const snapshot = await getDocs(fallbackQuery)
        let tables = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as Table))
        
        // Sort in memory
        tables.sort((a, b) => a.table_number - b.table_number)
        
        return tables
      } catch (fallbackError: any) {
        console.error('Fallback query also failed:', fallbackError)
        // Return empty array instead of throwing - allows UI to show empty state
        return []
      }
    }
    console.error('Error fetching tables:', error)
    // Return empty array instead of throwing - allows UI to show empty state
    return []
  }
}

// Get a table by restaurant ID and table number
export async function getTableByNumber(
  restaurantId: string,
  tableNumber: number
): Promise<Table | null> {
  if (!db) throw new Error('Firestore is not initialized')
  
  try {
    const q = query(
      collection(db, 'tables'),
      where('restaurant_id', '==', restaurantId),
      where('table_number', '==', tableNumber),
      where('active', '==', true)
    )
    
    const snapshot = await getDocs(q)
    if (snapshot.empty) return null
    
    const doc = snapshot.docs[0]
    return { id: doc.id, ...doc.data() } as Table
  } catch (error: any) {
    throw new Error(error.message || 'Failed to fetch table')
  }
}

// Create a new table
export async function createTable(data: Omit<Table, 'id' | 'created_at'>): Promise<string> {
  if (!db) throw new Error('Firestore is not initialized')
  
  try {
    // Remove undefined values (Firestore doesn't allow undefined)
    const cleanData: any = {
      restaurant_id: data.restaurant_id,
      table_number: data.table_number,
      table_name: data.table_name,
      qr_code_url: data.qr_code_url,
      active: data.active,
      created_at: new Date().toISOString(),
    }
    
    // Only include location if it's provided and not empty
    if (data.location && data.location.trim() !== '') {
      cleanData.location = data.location.trim()
    }
    
    // Include qr_code_image if provided
    if (data.qr_code_image) {
      cleanData.qr_code_image = data.qr_code_image
    }
    
    const docRef = await addDoc(collection(db, 'tables'), cleanData)
    return docRef.id
  } catch (error: any) {
    throw new Error(error.message || 'Failed to create table')
  }
}

// Update a table
export async function updateTable(tableId: string, data: Partial<Table>): Promise<void> {
  if (!db) throw new Error('Firestore is not initialized')
  
  try {
    const docRef = doc(db, 'tables', tableId)
    await updateDoc(docRef, data as any)
  } catch (error: any) {
    throw new Error(error.message || 'Failed to update table')
  }
}

// Delete a table (soft delete by setting active to false)
export async function deleteTable(tableId: string): Promise<void> {
  if (!db) throw new Error('Firestore is not initialized')
  
  try {
    await updateTable(tableId, { active: false })
  } catch (error: any) {
    throw new Error(error.message || 'Failed to delete table')
  }
}

