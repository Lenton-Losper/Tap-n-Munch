/**
 * Migration script to move tables from old flat structure to new hierarchical structure
 * 
 * OLD: tables/{tableId} with restaurant_id field
 * NEW: restaurants/{restaurantId}/tables/{tableId} (no restaurant_id field)
 * 
 * Run: npx ts-node scripts/migrate-tables.ts
 */

import { initializeApp } from 'firebase/app'
import { getFirestore, collection, getDocs, doc, setDoc, query, where, writeBatch } from 'firebase/firestore'
import * as dotenv from 'dotenv'
import path from 'path'

// Load environment variables
dotenv.config({ path: path.join(__dirname, '../.env.local') })

const firebaseConfig = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
  storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
}

if (!firebaseConfig.projectId) {
  console.error('❌ Firebase config is missing. Check your .env.local file.')
  process.exit(1)
}

const app = initializeApp(firebaseConfig)
const db = getFirestore(app)

async function migrateTables() {
  console.log('🚀 Starting table migration from flat to hierarchical structure...')
  console.log(`   Project: ${firebaseConfig.projectId}`)
  console.log('')
  
  try {
    // Get all tables from old flat structure
    const tablesSnapshot = await getDocs(collection(db, 'tables'))
    
    console.log(`📊 Found ${tablesSnapshot.size} tables in old structure`)
    
    if (tablesSnapshot.size === 0) {
      console.log('✅ No tables to migrate. All tables are already in hierarchical structure.')
      return
    }
    
    const batch = writeBatch(db)
    let migratedCount = 0
    let skippedCount = 0
    let errorCount = 0
    
    for (const tableDoc of tablesSnapshot.docs) {
      const tableData = tableDoc.data()
      const restaurantId = tableData.restaurant_id
      
      if (!restaurantId) {
        console.log(`⚠️  Skipping table ${tableDoc.id} - no restaurant_id field`)
        skippedCount++
        continue
      }
      
      // Check if table already exists in new structure
      try {
        const newTableRef = doc(db, `restaurants/${restaurantId}/tables/${tableDoc.id}`)
        const newTableSnap = await getDocs(query(
          collection(db, `restaurants/${restaurantId}/tables`),
          where('table_number', '==', tableData.table_number)
        ))
        
        if (!newTableSnap.empty) {
          console.log(`⏭️  Skipping table ${tableData.table_number} - already exists in new structure`)
          skippedCount++
          continue
        }
      } catch (checkError: any) {
        console.warn(`⚠️  Could not check if table exists: ${checkError.message}`)
      }
      
      // Remove restaurant_id from data (it's in the path now)
      const newTableData = { ...tableData }
      delete newTableData.restaurant_id
      
      // Write to new location
      const newTableRef = doc(db, `restaurants/${restaurantId}/tables/${tableDoc.id}`)
      batch.set(newTableRef, newTableData)
      
      console.log(`✅ Queued table ${tableData.table_number} (ID: ${tableDoc.id}) for restaurant ${restaurantId}`)
      migratedCount++
    }
    
    if (migratedCount > 0) {
      console.log('')
      console.log(`📦 Committing ${migratedCount} tables to new structure...`)
      await batch.commit()
      console.log('✅ Migration complete!')
    } else {
      console.log('ℹ️  No tables needed migration')
    }
    
    console.log('')
    console.log('📊 Migration Summary:')
    console.log(`   ✅ Migrated: ${migratedCount}`)
    console.log(`   ⏭️  Skipped: ${skippedCount}`)
    console.log(`   ❌ Errors: ${errorCount}`)
    console.log('')
    console.log('⚠️  NOTE: Old tables in flat structure are NOT deleted.')
    console.log('   You can delete them manually after verifying the migration.')
    
  } catch (error: any) {
    console.error('❌ Migration failed:', error.message)
    console.error(error)
    process.exit(1)
  }
}

// Run migration
migrateTables()
  .then(() => {
    console.log('🎉 Migration script completed')
    process.exit(0)
  })
  .catch((error) => {
    console.error('❌ Migration script failed:', error)
    process.exit(1)
  })

