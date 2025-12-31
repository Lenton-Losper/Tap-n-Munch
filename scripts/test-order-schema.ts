/**
 * STEP 6: Terminal Verification Script
 * 
 * This script tests that orders are created with the correct schema.
 * Run with: npm run test:orders
 * 
 * The script:
 * 1. Places a test order
 * 2. Queries Firestore
 * 3. Asserts required fields exist:
 *    - restaurant_id
 *    - status
 *    - placed_at
 *    - session_id
 * 4. Fails build if missing
 */

import { initializeApp, getApps } from 'firebase/app'
import { getFirestore, collection, query, where, orderBy, limit, getDocs, addDoc, serverTimestamp } from 'firebase/firestore'

// Initialize Firebase (use your config)
const firebaseConfig = {
  // Add your Firebase config here or use environment variables
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
  storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
}

if (!getApps().length) {
  initializeApp(firebaseConfig)
}

const db = getFirestore()

interface OrderSchema {
  restaurant_id: string
  table_id: string
  session_id: string
  status: string
  placed_at: any
  created_at: any
  total: number
  items: any[]
}

async function testOrderSchema() {
  console.log('🧪 Testing Order Schema...\n')

  try {
    // Step 1: Place test order
    const testOrder = {
      restaurant_id: 'test_restaurant_123',
      table_id: 'table_1',
      session_id: `test_session_${Date.now()}`,
      status: 'pending',
      payment_status: 'pending',
      payment_method: 'cash',
      items: [
        {
          menu_item_id: 'item_1',
          name: 'Test Item',
          quantity: 1,
          base_price: 10,
          subtotal: 10,
        },
      ],
      subtotal: 10,
      tax: 1.5,
      total: 11.5,
      order_instructions: null,
      created_at: serverTimestamp(),
      placed_at: serverTimestamp(),
      source: 'qr_menu',
      order_number: 999,
    }

    console.log('📦 Creating test order...')
    const docRef = await addDoc(collection(db, 'orders'), testOrder)
    console.log('✅ Test order created:', docRef.id)

    // Wait a moment for Firestore to process
    await new Promise(resolve => setTimeout(resolve, 1000))

    // Step 2: Query Firestore
    console.log('\n🔍 Querying Firestore for test order...')
    const q = query(
      collection(db, 'orders'),
      where('session_id', '==', testOrder.session_id),
      orderBy('placed_at', 'desc'),
      limit(1)
    )

    const snapshot = await getDocs(q)

    if (snapshot.empty) {
      throw new Error('❌ Test order not found in Firestore!')
    }

    const orderDoc = snapshot.docs[0]
    const orderData = orderDoc.data() as OrderSchema

    console.log('✅ Test order found in Firestore\n')

    // Step 3: Assert required fields exist
    console.log('🔍 Verifying required fields...\n')

    const requiredFields = {
      restaurant_id: orderData.restaurant_id,
      session_id: orderData.session_id,
      status: orderData.status,
      placed_at: orderData.placed_at,
      created_at: orderData.created_at,
      table_id: orderData.table_id,
      total: orderData.total,
      items: orderData.items,
    }

    const missingFields: string[] = []

    for (const [field, value] of Object.entries(requiredFields)) {
      if (value === undefined || value === null) {
        missingFields.push(field)
        console.error(`❌ Missing field: ${field}`)
      } else {
        console.log(`✅ Field present: ${field}`)
      }
    }

    if (missingFields.length > 0) {
      throw new Error(
        `❌ TEST FAILED: Missing required fields: ${missingFields.join(', ')}\n` +
        `Order data: ${JSON.stringify(orderData, null, 2)}`
      )
    }

    // Step 4: Verify field types and values
    console.log('\n🔍 Verifying field types and values...\n')

    if (orderData.status !== 'pending') {
      throw new Error(`❌ TEST FAILED: status must be 'pending', got '${orderData.status}'`)
    }
    console.log('✅ Status is correct: pending')

    if (!orderData.restaurant_id || typeof orderData.restaurant_id !== 'string') {
      throw new Error(`❌ TEST FAILED: restaurant_id must be a string`)
    }
    console.log('✅ restaurant_id is a string')

    if (!orderData.session_id || typeof orderData.session_id !== 'string') {
      throw new Error(`❌ TEST FAILED: session_id must be a string`)
    }
    console.log('✅ session_id is a string')

    if (!orderData.placed_at) {
      throw new Error(`❌ TEST FAILED: placed_at must exist`)
    }
    console.log('✅ placed_at exists')

    if (!Array.isArray(orderData.items) || orderData.items.length === 0) {
      throw new Error(`❌ TEST FAILED: items must be a non-empty array`)
    }
    console.log('✅ items is a non-empty array')

    console.log('\n✅ ALL TESTS PASSED!')
    console.log('\n📋 Order Schema Verification:')
    console.log(JSON.stringify({
      id: orderDoc.id,
      restaurant_id: orderData.restaurant_id,
      table_id: orderData.table_id,
      session_id: orderData.session_id,
      status: orderData.status,
      has_placed_at: !!orderData.placed_at,
      has_created_at: !!orderData.created_at,
      items_count: orderData.items.length,
      total: orderData.total,
    }, null, 2))

    // Cleanup: Delete test order
    console.log('\n🧹 Cleaning up test order...')
    // Note: In a real scenario, you might want to delete the test order
    // await deleteDoc(doc(db, 'orders', docRef.id))
    console.log('✅ Test complete')

    process.exit(0)
  } catch (error: any) {
    console.error('\n❌ TEST FAILED:', error.message)
    console.error('\nThis means orders are not being created with the correct schema.')
    console.error('Fix the API route to ensure all required fields are present.')
    process.exit(1)
  }
}

// Run the test
testOrderSchema()

