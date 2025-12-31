/**
 * Quick script to check table data structure
 * Run this to verify table_number is stored as Number (not String)
 */

import { collection, getDocs } from 'firebase/firestore'
import { db } from '../lib/firebase/config'

if (!db) {
  console.error('❌ Firestore not initialized. Check your Firebase configuration.')
  process.exit(1)
}

async function checkTableData(restaurantId: string) {
  console.log('🔍 Checking table data for restaurant:', restaurantId)
  
  try {
    const tablesRef = collection(db, `restaurants/${restaurantId}/tables`)
    const snapshot = await getDocs(tablesRef)
    
    console.log(`\n📊 Found ${snapshot.size} table(s):\n`)
    
    snapshot.docs.forEach((doc, index) => {
      const data = doc.data()
      console.log(`Table ${index + 1}:`)
      console.log(`  Document ID: ${doc.id}`)
      console.log(`  table_number: ${data.table_number} (type: ${typeof data.table_number})`)
      console.log(`  table_name: ${data.table_name || 'N/A'}`)
      console.log(`  active: ${data.active} (type: ${typeof data.active})`)
      console.log(`  location: ${data.location || 'N/A'}`)
      console.log('')
    })
    
    // Check for type issues
    const typeIssues = snapshot.docs.filter(doc => {
      const data = doc.data()
      return typeof data.table_number !== 'number'
    })
    
    if (typeIssues.length > 0) {
      console.log('⚠️ WARNING: Found tables with table_number as STRING (should be NUMBER):')
      typeIssues.forEach(doc => {
        const data = doc.data()
        console.log(`  - Table ${data.table_number} (ID: ${doc.id})`)
      })
      console.log('\n💡 Fix: Update these tables to use Number type')
    } else {
      console.log('✅ All tables have table_number as Number type - data is correct!')
    }
    
  } catch (error: any) {
    console.error('❌ Error checking tables:', error.message)
    if (error.code === 'permission-denied') {
      console.error('   Permission denied - check Firestore rules')
    }
  }
}

// Run check
const restaurantId = process.argv[2] || 'cLBYu7qX0aGfbqwYEpVw'
checkTableData(restaurantId).then(() => {
  console.log('\n✅ Check complete')
  process.exit(0)
}).catch(err => {
  console.error('❌ Script failed:', err)
  process.exit(1)
})

