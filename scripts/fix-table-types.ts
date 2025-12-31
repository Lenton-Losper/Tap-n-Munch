/**
 * Fix table_number type if stored as string
 * Only run this if check-table-data.ts shows type issues
 */

import { collection, getDocs, doc, updateDoc } from 'firebase/firestore'
import { db } from '../lib/firebase/config'

if (!db) {
  console.error('❌ Firestore not initialized. Check your Firebase configuration.')
  process.exit(1)
}

async function fixTableTypes(restaurantId: string) {
  console.log('🔧 Fixing table_number types for restaurant:', restaurantId)
  
  try {
    const tablesRef = collection(db, `restaurants/${restaurantId}/tables`)
    const snapshot = await getDocs(tablesRef)
    
    let fixedCount = 0
    
    for (const docSnap of snapshot.docs) {
      const data = docSnap.data()
      
      // Check if table_number is a string
      if (typeof data.table_number === 'string') {
        const tableNumber = Number(data.table_number)
        
        if (!isNaN(tableNumber)) {
          console.log(`  Fixing table ${data.table_number} (ID: ${docSnap.id})`)
          
          const tableRef = doc(db, `restaurants/${restaurantId}/tables/${docSnap.id}`)
          await updateDoc(tableRef, {
            table_number: tableNumber // Convert to Number
          })
          
          fixedCount++
          console.log(`    ✅ Updated to number: ${tableNumber}`)
        } else {
          console.log(`    ⚠️ Skipping table ${data.table_number} - invalid number`)
        }
      }
    }
    
    console.log(`\n✅ Fixed ${fixedCount} table(s)`)
    
  } catch (error: any) {
    console.error('❌ Error fixing tables:', error.message)
    if (error.code === 'permission-denied') {
      console.error('   Permission denied - you must be authenticated as restaurant owner')
    }
  }
}

// Run fix
const restaurantId = process.argv[2] || 'cLBYu7qX0aGfbqwYEpVw'
fixTableTypes(restaurantId).then(() => {
  console.log('\n✅ Fix complete')
  process.exit(0)
}).catch(err => {
  console.error('❌ Script failed:', err)
  process.exit(1)
})

