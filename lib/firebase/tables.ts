import { collection, query, where, orderBy, getDocs, addDoc, updateDoc, doc, getDoc, deleteDoc } from 'firebase/firestore'
import { db } from './config'
import { tablesPath, tablePath } from './paths'

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
    // We use a simple query first. If it fails due to index, we fall back to manual sort.
    const q = query(collection(db, tablesPath(restaurantId)), where('active', '==', true))
    const snapshot = await getDocs(q)
    
    const tables = snapshot.docs.map(doc => ({
      id: doc.id,
      restaurant_id: restaurantId,
      ...doc.data()
    } as Table))

    // Sort in memory to avoid needing a Composite Index
    return tables.sort((a, b) => a.table_number - b.table_number)
  } catch (error: any) {
    console.error('Error fetching tables:', error.message)
    return []
  }
}

// Get a table by restaurant ID and table number
// SIMPLIFIED: Single query with no orderBy or complex filters to avoid index requirements
export async function getTableByNumber(
  restaurantId: string,
  tableNumber: number | string
): Promise<Table | null> {
  if (!db) throw new Error('Firestore is not initialized')
  
  // Convert to Number immediately for type-safe query
  const parsedNumber = typeof tableNumber === 'number' ? tableNumber : Number(tableNumber)
  
  if (isNaN(parsedNumber) || parsedNumber <= 0) {
    console.error('❌ Invalid table number provided:', tableNumber)
    return null
  }

  try {
    console.log(`🔍 [TABLE LOOKUP] Searching for table ${parsedNumber} (type: ${typeof parsedNumber})`)
    
    // SIMPLIFIED QUERY: Only query by table_number - no orderBy, no active filter
    // This avoids composite index requirements that cause permission errors
    const q = query(
      collection(db, tablesPath(restaurantId)), 
      where('table_number', '==', parsedNumber)
    )
    
    const snapshot = await getDocs(q)
    
    if (snapshot.empty) {
      console.warn(`⚠️ No table found with number ${parsedNumber}`)
      return null
    }

    // Check active status in memory (after fetch) to avoid index requirements
    const tableDoc = snapshot.docs[0]
    const data = tableDoc.data()
    
    if (data.active !== true) {
      console.warn(`⚠️ Table ${parsedNumber} found but is INACTIVE`)
      return null
    }

    return {
      id: tableDoc.id,
      restaurant_id: restaurantId,
      ...data
    } as Table

  } catch (error: any) {
    // Return null instead of throwing - let caller handle gracefully
    console.error(`❌ [TABLE LOOKUP] Error:`, error.code, error.message)
    return null
  }
}

// Create a new table
export async function createTable(data: Omit<Table, 'id' | 'created_at'>): Promise<string> {
  if (!db) throw new Error('Firestore is not initialized')
  
  const cleanData = {
    table_number: Number(data.table_number), // Force Number type for DB consistency
    table_name: data.table_name,
    qr_code_url: data.qr_code_url,
    active: data.active,
    created_at: new Date().toISOString(),
    location: data.location?.trim() || ""
  }
  
  const docRef = await addDoc(collection(db, 'restaurants', data.restaurant_id, 'tables'), cleanData)
  return docRef.id
}

// Update a table
export async function updateTable(restaurantId: string, tableId: string, data: Partial<Table>): Promise<void> {
  if (!db) throw new Error('Firestore is not initialized')
  const docRef = doc(db, 'restaurants', restaurantId, 'tables', tableId)
  await updateDoc(docRef, data as any)
}

// Delete a table (HARD DELETE)
export async function deleteTable(restaurantId: string, tableId: string): Promise<void> {
  if (!db) throw new Error('Firestore is not initialized')
  
  try {
    const tableRef = doc(db, 'restaurants', restaurantId, 'tables', tableId)
    await deleteDoc(tableRef)
    console.log('✅ Table Hard Deleted:', tableId)
  } catch (error: any) {
    console.error('❌ Delete failed:', error.message)
    throw error
  }
}