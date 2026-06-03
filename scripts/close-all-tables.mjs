import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'fs'
import { resolve } from 'path'

function loadEnv(file) {
  try {
    const text = readFileSync(resolve(process.cwd(), file), 'utf8')
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) continue
      const eq = trimmed.indexOf('=')
      if (eq === -1) continue
      const key = trimmed.slice(0, eq).trim()
      let value = trimmed.slice(eq + 1).trim()
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1)
      }
      if (!process.env[key]) process.env[key] = value
    }
  } catch {
    // optional file
  }
}

loadEnv('.env.local')
loadEnv('.env')

const url = process.env.NEXT_PUBLIC_SUPABASE_URL
const key = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!url || !key) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY')
  process.exit(1)
}

const restaurantFilter = process.argv[2]?.trim() || null

const supabase = createClient(url, key, { auth: { persistSession: false } })
const nowIso = new Date().toISOString()

let tabsQuery = supabase
  .from('tabs')
  .select('id, restaurant_id, table_number, status')
  .in('status', ['open', 'ready_to_pay'])

if (restaurantFilter) {
  tabsQuery = tabsQuery.eq('restaurant_id', restaurantFilter)
}

const { data: activeTabs, error: tabErr } = await tabsQuery

if (tabErr) {
  console.error('Failed to load active tabs:', tabErr.message)
  process.exit(1)
}

const tabs = activeTabs || []
console.log(`Active tabs before close: ${tabs.length}`)
for (const tab of tabs) {
  console.log(`  - table ${tab.table_number ?? '?'} | ${tab.status} | ${tab.id}`)
}

const tabIds = tabs.map((t) => t.id)
const restaurantIds = [...new Set(tabs.map((t) => t.restaurant_id).filter(Boolean))]

if (tabIds.length > 0) {
  const settlePayload = {
    status: 'settled',
    settled_at: nowIso,
    settled_type: 'manual_close',
  }

  const { error: settleErr } = await supabase.from('tabs').update(settlePayload).in('id', tabIds)

  if (settleErr) {
    console.warn('tabs settle warning:', settleErr.message)
  }
}

for (const restaurantId of restaurantIds) {
  const { error: ordersErr } = await supabase
    .from('orders')
    .update({ is_closed: true, table_closed: true, status: 'completed' })
    .eq('restaurant_id', restaurantId)
    .eq('is_closed', false)

  if (ordersErr) {
    console.warn(`orders update warning (${restaurantId}):`, ordersErr.message)
  }

  const tablePayloads = [
    { session_id: null, current_tab_id: null, status: 'available', updated_at: nowIso },
    { session_id: null, status: 'available', updated_at: nowIso },
    { status: 'available' },
  ]

  for (const tableUpdate of tablePayloads) {
    const { error: tableErr } = await supabase
      .from('restaurant_tables')
      .update(tableUpdate)
      .eq('restaurant_id', restaurantId)

    if (!tableErr) break
    if (tableUpdate === tablePayloads[tablePayloads.length - 1]) {
      console.warn(`restaurant_tables update warning (${restaurantId}):`, tableErr.message)
    }
  }
}

let remainingQuery = supabase
  .from('tabs')
  .select('id', { count: 'exact', head: true })
  .in('status', ['open', 'ready_to_pay'])

if (restaurantFilter) {
  remainingQuery = remainingQuery.eq('restaurant_id', restaurantFilter)
}

const { count, error: countErr } = await remainingQuery

if (countErr) {
  console.warn('count warning:', countErr.message)
}

console.log(`Settled ${tabIds.length} tab(s).`)
console.log(`Active tabs remaining: ${count ?? 0}`)
