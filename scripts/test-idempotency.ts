/**
 * Database idempotency test for POST /api/orders (tab order)
 * Tests that sending the same request twice returns the same orderId
 * and only creates one order row in Supabase.
 *
 * Usage:
 *   npx tsx scripts/test-idempotency.ts
 */
import { createClient } from '@supabase/supabase-js'
import dotenv from 'dotenv'
import { randomUUID } from 'node:crypto'

dotenv.config({ path: '.env.local' })
dotenv.config({ path: '.env' })

const BASE_URL = 'https://flashtap.app'
const RESTAURANT_ID = '01bf27f1-a958-4322-bb3e-cc5240987808'
const TABLE_NUMBER = 1
const TAB_ID = '777870af-8c25-4e91-a4c1-005c9ff0c448'
const SESSION_TOKEN = '28c9d272-e8c7-44fe-9a7d-3b112dd7f7ba'

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!

if (!supabaseUrl || !supabaseAnonKey) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_ANON_KEY')
  process.exit(1)
}

const supabase = createClient(supabaseUrl, supabaseAnonKey)
const testKey = randomUUID()

const orderPayload = {
  restaurantId: RESTAURANT_ID,
  tableNumber: TABLE_NUMBER,
  tabId: TAB_ID,
  sessionId: `idempotency-test-${testKey}`,
  memberSessionId: `idempotency-test-${testKey}`,
  items: [
    {
      menuItemId: 'test-item',
      name: 'Idempotency Test Item',
      displayName: 'Idempotency Test Item',
      quantity: 1,
      basePrice: 1,
      subtotal: 1,
    },
  ],
  subtotal: 1,
  total: 1,
  paymentMethod: 'cash',
  paymentChannel: 'cash',
  orderInstructions: 'idempotency test — safe to delete',
}

async function postOrder(label: string): Promise<string> {
  console.log(`\n--- ${label} ---`)
  console.log(`x-idempotency-key: ${testKey}`)

  const response = await fetch(`${BASE_URL}/api/orders`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-idempotency-key': testKey,
      'x-session-token': SESSION_TOKEN,
    },
    body: JSON.stringify(orderPayload),
  })

  const data = await response.json().catch(() => ({})) as {
    success?: boolean
    orderId?: string
    error?: string
  }

  console.log(`Status: ${response.status}`)
  console.log('Body:', JSON.stringify(data, null, 2))

  if (!response.ok || !data.orderId) {
    throw new Error(data.error || `Request failed with status ${response.status}`)
  }

  return data.orderId
}

async function countOrdersByIdempotencyKey(): Promise<number> {
  const { data, error, count } = await supabase
    .from('orders')
    .select('id', { count: 'exact' })
    .eq('idempotency_key', testKey)

  if (error) throw new Error(`Supabase query failed: ${error.message}`)

  console.log(`\nSupabase rows with idempotency_key=${testKey}:`, count ?? data?.length ?? 0)
  if (data?.length) {
    console.log('Order IDs:', data.map((r) => r.id).join(', '))
  }

  return count ?? data?.length ?? 0
}

async function main() {
  console.log('=== FlashTap Database Idempotency Test ===')
  console.log('BASE_URL:', BASE_URL)
  console.log('TAB_ID:', TAB_ID)
  console.log('testKey:', testKey)

  const orderId1 = await postOrder('Request 1 (original)')
  console.log('orderId from request 1:', orderId1)

  const orderId2 = await postOrder('Request 2 (duplicate)')
  console.log('orderId from request 2:', orderId2)

  console.log('\n=== Results ===')

  if (orderId1 !== orderId2) {
    console.error('FAIL: orderId mismatch — duplicate order was created')
    console.error(`  request 1: ${orderId1}`)
    console.error(`  request 2: ${orderId2}`)
    process.exit(1)
  }

  console.log('PASS: both requests returned the same orderId:', orderId1)

  const rowCount = await countOrdersByIdempotencyKey()

  if (rowCount !== 1) {
    console.error(`FAIL: expected 1 order row, found ${rowCount}`)
    process.exit(1)
  }

  console.log('PASS: exactly 1 order row exists in Supabase for this key')
  console.log('\nAll checks passed. Database idempotency is working correctly.')
  console.log('\nNOTE: Clean up the test order from Supabase:')
  console.log(`DELETE FROM orders WHERE idempotency_key = '${testKey}';`)
}

main().catch((err) => {
  console.error('\nTest error:', err instanceof Error ? err.message : err)
  process.exit(1)
})
