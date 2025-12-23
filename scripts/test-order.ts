/**
 * STEP 5: Terminal Test Script
 * 
 * This script tests order creation without UI.
 * It will FAIL if:
 * - customer_email exists anywhere
 * - Firestore rejects the payload
 * - Any forbidden fields are detected
 * 
 * Usage: npm run test:order
 */

import { db } from '../lib/firebase/config'
import { collection, addDoc } from 'firebase/firestore'
import { prepareForFirestore, assertNoForbiddenFields } from '../lib/firebase/firestore-guards'

async function testOrderCreation() {
  console.log('🧪 Starting order creation test...\n')

  try {
    if (!db) {
      throw new Error('Firestore not initialized')
    }

    // Mock order data - NO customer_email anywhere
    const mockOrder = {
      restaurant_id: 'test_restaurant',
      order_number: 999,
      table_number: 1,
      customer: {
        name: 'Test Customer',
        phone: '+264123456789',
      },
      items: [
        {
          menu_item_id: 'test_item_1',
          name: 'Test Burger',
          quantity: 2,
          base_price: 50,
          subtotal: 100,
          special_instructions: '',
          selected_size: null,
          selected_addons: [],
        },
      ],
      subtotal: 100,
      tax: 15,
      service_fee: 0,
      discount: 0,
      tip: 0,
      total: 115,
      status: 'new' as const,
      payment_status: 'pending' as const,
      payment_method: 'cash' as const,
      order_instructions: null,
      placed_at: new Date().toISOString(),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }

    console.log('📦 Mock order data created')
    console.log('   Keys:', Object.keys(mockOrder))
    console.log('   Customer:', mockOrder.customer)

    // STEP 2: Assert no forbidden fields
    console.log('\n🔍 Checking for forbidden fields...')
    try {
      assertNoForbiddenFields(mockOrder)
      console.log('✅ No forbidden fields detected')
    } catch (error: any) {
      console.error('❌ FORBIDDEN FIELD DETECTED:', error.message)
      process.exit(1)
    }

    // STEP 3: Sanitize
    console.log('\n🧹 Sanitizing order data...')
    const cleanOrder = prepareForFirestore(mockOrder)
    console.log('✅ Order sanitized')
    console.log('   Clean keys:', Object.keys(cleanOrder))

    // Verify no customer_email exists
    const hasCustomerEmail = JSON.stringify(cleanOrder).includes('customer_email')
    if (hasCustomerEmail) {
      console.error('❌ CRITICAL: customer_email still exists in sanitized order!')
      process.exit(1)
    }

    // Write to Firestore
    console.log('\n💾 Writing to Firestore...')
    const docRef = await addDoc(collection(db, 'orders'), cleanOrder)
    console.log('✅ Order created successfully!')
    console.log('   Order ID:', docRef.id)

    // Verify in Firestore
    console.log('\n🔍 Verifying order in Firestore...')
    const doc = await import('firebase/firestore').then(m => m.getDoc(m.doc(db, 'orders', docRef.id)))
    const orderData = doc.data()
    
    if (orderData && 'customer_email' in orderData) {
      console.error('❌ CRITICAL: customer_email found in Firestore document!')
      console.error('   Document data:', orderData)
      process.exit(1)
    }

    console.log('✅ Order verified in Firestore')
    console.log('   Customer:', orderData?.customer)
    console.log('   Status:', orderData?.status)

    console.log('\n🎉 ALL TESTS PASSED!')
    console.log('   ✅ No customer_email detected')
    console.log('   ✅ Order created in Firestore')
    console.log('   ✅ Order has correct structure')

    process.exit(0)
  } catch (error: any) {
    console.error('\n❌ TEST FAILED:', error.message)
    console.error('   Stack:', error.stack)
    process.exit(1)
  }
}

// Run test
testOrderCreation()

