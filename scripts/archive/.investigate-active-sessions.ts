/**
 * READ-ONLY: active orders / table sessions / tabs for Riviera and FNB ChowNow.
 * Corrected column names per actual schema (orders/tabs have no updated_at;
 * orders: placed_at/accepted_at/preparing_at/ready_at/completed_at/paid_at,
 * tabs: created_at/settled_at, table_sessions: created_at/closed_at).
 */
import { resolve } from 'path'
import { createClient } from '@supabase/supabase-js'
import { config } from 'dotenv'

config({ path: resolve(__dirname, '../.env.production.local'), override: true })

const PROD_REF = 'ihlmmpmolnpchzgwyhgh'
const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || ''
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || ''

if (!SUPABASE_URL.includes(PROD_REF) || !SERVICE_KEY) {
  throw new Error('Refusing: production Supabase credentials missing/mismatched')
}

const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { autoRefreshToken: false, persistSession: false } })

const RESTAURANTS = [
  { id: '01bf27f1-a958-4322-bb3e-cc5240987808', name: 'Riviera' },
  { id: 'b161c758-582d-4dfa-839a-9fa35c492a49', name: 'FNB ChowNow' },
]

async function main() {
  const nowIso = new Date().toISOString()
  const thirtyMinAgoIso = new Date(Date.now() - 30 * 60 * 1000).toISOString()
  console.log(`Now: ${nowIso}`)
  console.log(`30 min ago: ${thirtyMinAgoIso}\n`)

  for (const r of RESTAURANTS) {
    console.log('='.repeat(80))
    console.log(`${r.name} (${r.id})`)

    // ALL non-terminal orders, any age (most reliable "is anything open" signal)
    const { data: anyOpenOrders, error: anyOpenErr } = await admin
      .from('orders')
      .select('id, status, channel, placed_at, accepted_at, preparing_at, ready_at, completed_at, paid_at, is_closed, table_closed, table_id')
      .eq('restaurant_id', r.id)
      .not('status', 'in', '(completed,cancelled)')
    console.log(`  ALL non-terminal orders (any age): count=${anyOpenErr ? 'ERROR: ' + anyOpenErr.message : anyOpenOrders?.length ?? 0}`)
    if (anyOpenOrders?.length) console.log('    ' + JSON.stringify(anyOpenOrders, null, 2).replace(/\n/g, '\n    '))

    // Subset placed/touched within last 30 min
    const recentTouch = (anyOpenOrders ?? []).filter((o: any) => {
      const timestamps = [o.placed_at, o.accepted_at, o.preparing_at, o.ready_at, o.completed_at, o.paid_at].filter(Boolean)
      const mostRecent = timestamps.sort().pop()
      return mostRecent && mostRecent > thirtyMinAgoIso
    })
    console.log(`  Of those, touched (any lifecycle timestamp) in last 30 min: count=${recentTouch.length}`)

    const { data: sessions, error: sessErr } = await admin
      .from('table_sessions')
      .select('*')
      .eq('restaurant_id', r.id)
      .is('closed_at', null)
    console.log(`  table_sessions with closed_at IS NULL (open sessions): ${sessErr ? sessErr.message : JSON.stringify(sessions)}`)

    const { data: allSessions, error: allSessErr } = await admin
      .from('table_sessions')
      .select('id, status, created_at, closed_at')
      .eq('restaurant_id', r.id)
    console.log(`  table_sessions ALL rows (any status): count=${allSessErr ? allSessErr.message : allSessions?.length ?? 0}`)

    const { data: tabs, error: tabsErr } = await admin
      .from('tabs')
      .select('id, status, created_at, settled_at, table_id')
      .eq('restaurant_id', r.id)
      .is('settled_at', null)
    console.log(`  open tabs (settled_at IS NULL): ${tabsErr ? tabsErr.message : JSON.stringify(tabs)}`)
  }
}
main().catch((e) => { console.error('FAILED:', e); process.exit(1) })
