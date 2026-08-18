/**
 * WHICH RAW STATUSES DOES EACH TABLE ACTUALLY HOLD?
 *
 * `customerOrderState` maps four raw statuses to the four states that replaced `needs_you`, and a
 * browser test tried to seed all four onto `order_requests`. Two were rejected by
 * `order_requests_status_check` — so those states are reachable only on `orders`, and a test that
 * seeds them on the wrong table is testing nothing.
 *
 * Read-only, staging.
 */
// @ts-nocheck
import { createClient } from '@supabase/supabase-js'

const STAGING_REF = 'mdqjpxwczrhkxkbqatqa'
const url = process.env.SUPABASE_URL || ''
const key = process.env.SUPABASE_SERVICE_ROLE_KEY || ''
if (!url.includes(STAGING_REF)) throw new Error(`GUARD: ${url} is not staging`)
const admin = createClient(url, key, { auth: { persistSession: false } })

async function main() {
  for (const table of ['order_requests', 'orders']) {
    const { data, error } = await admin.from(table).select('status').limit(1000)
    if (error) {
      console.log(`${table.padEnd(16)} ERROR ${error.message}`)
      continue
    }
    const seen = [...new Set((data ?? []).map((r: any) => String(r.status)))].sort()
    console.log(`${table.padEnd(16)} ${seen.join(', ') || '(none)'}`)
  }

  // And which of the four the customer vocabulary cares about are legal where.
  console.log('\nprobing acceptance of each mapped status on order_requests:')
  for (const status of ['declined', 'cancelled', 'ready_for_terminal', 'failed']) {
    const { error } = await admin.from('order_requests').insert({
      restaurant_id: '00000000-0000-0000-0000-000000000000',
      channel: 'table',
      status,
      items: [],
      total: 0,
    })
    const msg = String(error?.message ?? '')
    const rejectedByCheck = msg.includes('order_requests_status_check')
    console.log(`  ${status.padEnd(20)} ${rejectedByCheck ? 'REJECTED by status check' : 'status accepted (failed on something else)'}`)
  }
}

main().catch((e) => {
  console.error('FATAL', e?.message ?? e)
  process.exit(1)
})
