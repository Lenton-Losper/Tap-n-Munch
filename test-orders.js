#!/usr/bin/env node

/**
 * Order API Test Script
 * 
 * Tests:
 * 1. Isolation test route (GET /api/orders/test)
 * 2. Main API route (POST /api/orders)
 * 
 * Usage:
 *   node test-orders.js
 *   OR
 *   npm run test:orders
 * 
 * Prerequisites:
 *   - Next.js dev server must be running (npm run dev)
 *   - Firebase must be configured
 */

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3000'

// Colors for terminal output
const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
}

function log(message, color = 'reset') {
  console.log(`${colors[color]}${message}${colors.reset}`)
}

function logSection(title) {
  console.log('\n' + '='.repeat(60))
  log(title, 'cyan')
  console.log('='.repeat(60))
}

async function testIsolationRoute() {
  logSection('TEST 1: Isolation Route (GET /api/orders/test)')
  
  try {
    log(`\n📡 Calling: ${BASE_URL}/api/orders/test`, 'blue')
    
    const response = await fetch(`${BASE_URL}/api/orders/test`, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
      },
    })

    const data = await response.json()

    if (response.ok) {
      log(`\n✅ SUCCESS: Test order created!`, 'green')
      log(`   Order ID: ${data.orderId}`, 'green')
      log(`   Message: ${data.message}`, 'green')
      return { success: true, orderId: data.orderId }
    } else {
      log(`\n❌ FAILED: ${response.status} ${response.statusText}`, 'red')
      log(`   Error: ${data.error || 'Unknown error'}`, 'red')
      return { success: false, error: data.error }
    }
  } catch (error) {
    log(`\n❌ ERROR: ${error.message}`, 'red')
    log(`   Make sure the dev server is running: npm run dev`, 'yellow')
    return { success: false, error: error.message }
  }
}

async function testMainAPIRoute(restaurantId = 'test_restaurant') {
  logSection('TEST 2: Main API Route (POST /api/orders)')
  
  // Sample order payload - ONLY required fields
  const orderPayload = {
    restaurantId: restaurantId,
    tableNumber: 1,
    items: [
      {
        menuItemId: 'test_item_1',
        name: 'Test Burger',
        quantity: 2,
        basePrice: 50,
        subtotal: 100,
        size: null,
        addons: [],
        specialInstructions: 'No onions',
      },
    ],
    subtotal: 100,
    tax: 15,
    total: 115,
    paymentMethod: 'cash',
    notes: 'Test order from terminal',
  }

  // Verify payload has no undefined values
  const hasUndefined = Object.values(orderPayload).some(v => v === undefined)
  const forbiddenFields = ['customer_email', 'customerName', 'customerPhone', 'customer_name', 'customer_phone']
  const foundForbidden = forbiddenFields.filter(field => field in orderPayload)

  log(`\n📦 Payload:`, 'blue')
  log(`   Keys: ${Object.keys(orderPayload).join(', ')}`, 'blue')
  log(`   Has undefined? ${hasUndefined}`, hasUndefined ? 'red' : 'green')
  log(`   Forbidden fields? ${foundForbidden.length > 0 ? foundForbidden.join(', ') : 'None'}`, foundForbidden.length > 0 ? 'red' : 'green')

  if (hasUndefined) {
    log(`\n❌ FAILED: Payload contains undefined values!`, 'red')
    return { success: false, error: 'Payload contains undefined values' }
  }

  if (foundForbidden.length > 0) {
    log(`\n❌ FAILED: Payload contains forbidden customer fields!`, 'red')
    return { success: false, error: 'Payload contains forbidden customer fields' }
  }

  try {
    log(`\n📡 Calling: ${BASE_URL}/api/orders`, 'blue')
    
    const response = await fetch(`${BASE_URL}/api/orders`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(orderPayload),
    })

    const data = await response.json()

    if (response.ok) {
      log(`\n✅ SUCCESS: Order created!`, 'green')
      log(`   Order ID: ${data.orderId}`, 'green')
      return { success: true, orderId: data.orderId }
    } else {
      log(`\n❌ FAILED: ${response.status} ${response.statusText}`, 'red')
      log(`   Error: ${data.error || 'Unknown error'}`, 'red')
      return { success: false, error: data.error }
    }
  } catch (error) {
    log(`\n❌ ERROR: ${error.message}`, 'red')
    log(`   Make sure the dev server is running: npm run dev`, 'yellow')
    return { success: false, error: error.message }
  }
}

async function runAllTests() {
  log('\n🚀 Starting Order API Tests...', 'cyan')
  log(`   Base URL: ${BASE_URL}`, 'blue')
  log(`   Make sure your dev server is running!`, 'yellow')

  const results = {
    isolation: null,
    mainAPI: null,
  }

  // Test 1: Isolation route
  results.isolation = await testIsolationRoute()

  // Wait a bit between tests
  await new Promise(resolve => setTimeout(resolve, 1000))

  // Test 2: Main API route
  results.mainAPI = await testMainAPIRoute()

  // Summary
  logSection('TEST SUMMARY')
  
  const allPassed = results.isolation?.success && results.mainAPI?.success

  if (results.isolation?.success) {
    log('✅ Isolation Route: PASSED', 'green')
  } else {
    log('❌ Isolation Route: FAILED', 'red')
    log(`   Error: ${results.isolation?.error || 'Unknown'}`, 'red')
  }

  if (results.mainAPI?.success) {
    log('✅ Main API Route: PASSED', 'green')
  } else {
    log('❌ Main API Route: FAILED', 'red')
    log(`   Error: ${results.mainAPI?.error || 'Unknown'}`, 'red')
  }

  console.log('\n' + '='.repeat(60))
  
  if (allPassed) {
    log('\n🎉 ALL TESTS PASSED!', 'green')
    log('   Orders should now appear in Firestore.', 'green')
    process.exit(0)
  } else {
    log('\n⚠️  SOME TESTS FAILED', 'yellow')
    log('   Check the errors above and fix the issues.', 'yellow')
    process.exit(1)
  }
}

// Run tests
runAllTests().catch(error => {
  log(`\n💥 FATAL ERROR: ${error.message}`, 'red')
  console.error(error)
  process.exit(1)
})

