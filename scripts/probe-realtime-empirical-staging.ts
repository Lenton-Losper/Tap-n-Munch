/**
 * Empirical check: does supabase_realtime actually broadcast orders / order_requests?
 * Subscribes, inserts a row, waits for the event. No pg_catalog access required.
 */
import { createClient } from '@supabase/supabase-js'

const url =
  process.env.NEXT_PUBLIC_SUPABASE_URL ||
  process.env.STAGING_SUPABASE_URL ||
  process.env.SUPABASE_URL ||
  ''
const key =
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.STAGING_SUPABASE_SERVICE_ROLE_KEY || ''

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg)
}

async function probeTable(table: 'orders' | 'order_requests') {
  const supabase = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  })

  const { data: restaurant } = await supabase.from('restaurants').select('id').limit(1).maybeSingle()
  assert(restaurant?.id, 'need restaurant')

  const { data: tableRow } = await supabase
    .from('restaurant_tables')
    .select('id, table_number, restaurant_id')
    .eq('restaurant_id', restaurant.id)
    .gt('table_number', 0)
    .limit(1)
    .maybeSingle()

  // Prefer any table if restaurant has none
  const tbl =
    tableRow ||
    (
      await supabase
        .from('restaurant_tables')
        .select('id, table_number, restaurant_id')
        .gt('table_number', 0)
        .limit(1)
        .maybeSingle()
    ).data
  assert(tbl?.id, 'need a table row')

  let gotEvent = false
  let eventPayload: unknown = null

  const channel = supabase
    .channel(`probe-${table}-${Date.now()}`)
    .on(
      'postgres_changes',
      { event: 'INSERT', schema: 'public', table },
      (payload) => {
        gotEvent = true
        eventPayload = payload.new
      },
    )

  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`subscribe timeout for ${table}`)), 15000)
    channel.subscribe((status) => {
      if (status === 'SUBSCRIBED') {
        clearTimeout(t)
        resolve()
      }
      if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
        clearTimeout(t)
        reject(new Error(`subscribe ${status} for ${table}`))
      }
    })
  })

  let insertedId: string | null = null
  try {
    if (table === 'orders') {
      const { data, error } = await supabase
        .from('orders')
        .insert({
          restaurant_id: tbl.restaurant_id,
          table_id: tbl.id,
          table_number: tbl.table_number,
          session_id: `sess_rt_probe_${Date.now()}`,
          status: 'pending',
          payment_status: 'pending',
          channel: 'table',
          items: [],
          subtotal: 0,
          tax: 0,
          total: 0,
          is_closed: false,
          order_number: 999002,
        })
        .select('id')
        .single()
      assert(!error && data?.id, `orders insert failed: ${error?.message}`)
      insertedId = data.id
    } else {
      const { data, error } = await supabase
        .from('order_requests')
        .insert({
          restaurant_id: tbl.restaurant_id,
          table_id: tbl.id,
          table_number: tbl.table_number,
          session_id: `sess_rt_probe_${Date.now()}`,
          channel: 'table',
          status: 'waiting_review',
          items: [],
          subtotal: 0,
          tax: 0,
          total: 0,
        })
        .select('id')
        .single()
      assert(!error && data?.id, `order_requests insert failed: ${error?.message}`)
      insertedId = data.id
    }

    const deadline = Date.now() + 10000
    while (!gotEvent && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 200))
    }
  } finally {
    await supabase.removeChannel(channel)
    if (insertedId) {
      await supabase.from(table).delete().eq('id', insertedId)
    }
  }

  return { table, gotEvent, insertedId, eventPayload }
}

async function main() {
  assert(url && key, 'need supabase url+service role')

  const { data: applied } = await createClient(url, key, {
    auth: { persistSession: false },
  }).rpc('list_applied_migration_versions')
  const migrationApplied = (applied ?? []).some(
    (r: { version: string }) => String(r.version) === '20260726110000',
  )
  console.log('migration 20260726110000 in schema_migrations:', migrationApplied)

  const orders = await probeTable('orders')
  console.log('orders realtime INSERT received:', orders.gotEvent, 'id', orders.insertedId)

  const requests = await probeTable('order_requests')
  console.log(
    'order_requests realtime INSERT received:',
    requests.gotEvent,
    'id',
    requests.insertedId,
  )

  console.log(
    JSON.stringify(
      {
        orders_in_publication_empirically: orders.gotEvent,
        order_requests_in_publication_empirically: requests.gotEvent,
        sql_paste_needed: !(orders.gotEvent && requests.gotEvent),
      },
      null,
      2,
    ),
  )

  if (!orders.gotEvent || !requests.gotEvent) {
    throw new Error('Realtime INSERT events missing — tables likely not in supabase_realtime')
  }
  console.log('PROBE_REALTIME_EMPIRICAL_OK')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
