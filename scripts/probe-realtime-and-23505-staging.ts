/**
 * One-shot staging probes:
 * 1) pg_publication_tables for orders + order_requests under supabase_realtime
 * 2) Real hosted-path 23505 retry: pre-seed order with checkoutUrl, POST same
 *    idempotency key on legacy (non-table/kiosk) channel, assert full payload.
 *
 * Marker: PROBE_REALTIME_AND_23505_OK
 */
import { createClient } from '@supabase/supabase-js'
import { writeFileSync, unlinkSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  STAGING_PROJECT_REF,
  runShellCommand,
} from './lib/safe-supabase-linked'

const WORKER =
  process.env.STAGING_WORKER_URL || 'https://flashtap-staging.llosperofficial.workers.dev'
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

function log(label: string, value: unknown) {
  console.log(`== ${label} ==`)
  console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2))
}

async function queryPublicationViaLinked(): Promise<string[] | null> {
  const hasToken = Boolean(process.env.SUPABASE_ACCESS_TOKEN)
  const pw = process.env.STAGING_SUPABASE_DB_PASSWORD || process.env.SUPABASE_DB_PASSWORD || ''
  if (!hasToken && !pw) {
    console.log('No SUPABASE_ACCESS_TOKEN / STAGING_SUPABASE_DB_PASSWORD — cannot run linked SQL')
    return null
  }

  try {
    if (pw) {
      runShellCommand(
        `npx supabase link --project-ref ${STAGING_PROJECT_REF} -p "${pw.replace(/"/g, '\\"')}" --yes`,
      )
    } else {
      runShellCommand(`npx supabase link --project-ref ${STAGING_PROJECT_REF} --yes`)
    }

    const sqlPath = join(tmpdir(), `pub-probe-${Date.now()}.sql`)
    writeFileSync(
      sqlPath,
      `SELECT tablename
       FROM pg_publication_tables
       WHERE pubname = 'supabase_realtime'
         AND schemaname = 'public'
         AND tablename IN ('orders', 'order_requests')
       ORDER BY tablename;`,
    )
    try {
      // Capture stdout from linked query
      const { execSync } = await import('child_process')
      const out = execSync(`npx supabase db query --linked -f "${sqlPath}"`, {
        encoding: 'utf8',
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      log('pg_publication_tables raw', out)
      const tables: string[] = []
      for (const line of out.split('\n')) {
        const t = line.trim()
        if (t === 'orders' || t === 'order_requests') tables.push(t)
        // table-formatted rows sometimes look like: | orders |
        if (/\borders\b/.test(t) && !t.includes('tablename')) tables.push('orders')
        if (/\border_requests\b/.test(t) && !t.includes('tablename')) tables.push('order_requests')
      }
      return [...new Set(tables)]
    } finally {
      try {
        unlinkSync(sqlPath)
      } catch {
        /* ignore */
      }
    }
  } catch (e) {
    console.error('linked publication probe failed:', e instanceof Error ? e.message : e)
    return null
  }
}

async function queryPublicationViaExecSql(
  supabase: { rpc: (...args: any[]) => unknown },
): Promise<string[] | null> {
  for (const arg of [
    {
      sql: `SELECT tablename FROM pg_publication_tables WHERE pubname='supabase_realtime' AND tablename IN ('orders','order_requests') ORDER BY tablename`,
    },
    {
      query: `SELECT tablename FROM pg_publication_tables WHERE pubname='supabase_realtime' AND tablename IN ('orders','order_requests') ORDER BY tablename`,
    },
  ]) {
    const { data, error } = await (supabase as any).rpc('exec_sql', arg)
    if (!error) {
      log('exec_sql publication result', data)
      const rows = Array.isArray(data) ? data : []
      return rows
        .map((r: { tablename?: string }) => String(r.tablename || ''))
        .filter((t) => t === 'orders' || t === 'order_requests')
    }
    console.log('exec_sql unavailable/failed:', error.message)
  }
  return null
}

async function main() {
  assert(url && key, 'Need staging SUPABASE_URL + SERVICE_ROLE_KEY')
  const supabase = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } })

  // --- 1) Realtime publication state ---
  const { data: applied, error: appliedErr } = await supabase.rpc('list_applied_migration_versions')
  if (appliedErr) throw appliedErr
  const versions = (applied ?? []).map((r: { version: string }) => String(r.version))
  const migrationApplied = versions.includes('20260726110000')
  log('migration 20260726110000 applied?', migrationApplied)

  let publicationTables = await queryPublicationViaLinked()
  if (!publicationTables) {
    publicationTables = await queryPublicationViaExecSql(supabase)
  }

  if (publicationTables) {
    log('supabase_realtime contains', publicationTables)
    const hasOrders = publicationTables.includes('orders')
    const hasRequests = publicationTables.includes('order_requests')
    log('publication verdict', {
      orders: hasOrders ? 'PRESENT' : 'MISSING',
      order_requests: hasRequests ? 'PRESENT' : 'MISSING',
      sql_paste_needed: !(hasOrders && hasRequests),
    })
  } else {
    log('publication verdict', {
      note: 'Could not query pg_publication_tables directly (no DB password/access token and no exec_sql).',
      migration_file_applied_in_schema_migrations: migrationApplied,
    })
  }

  // --- 2) Hosted-path 23505 full payload ---
  // Pre-seed an orders row with checkoutUrl, then POST same idempotency key on a
  // non-table/non-kiosk channel so the Worker hits the legacy 23505 branch.
  const { data: table } = await supabase
    .from('restaurant_tables')
    .select('id, table_number, restaurant_id, is_kiosk, is_view_only, active')
    .eq('active', true)
    .eq('is_view_only', false)
    .gt('table_number', 0)
    .limit(1)
    .maybeSingle()
  assert(table?.id, 'need an active non-view-only table')

  // Ensure an open tab so legacy (non-kiosk) path passes the open-tab gate.
  const { data: openTab } = await supabase
    .from('tabs')
    .select('id')
    .eq('restaurant_id', table.restaurant_id)
    .eq('table_number', table.table_number)
    .eq('status', 'open')
    .maybeSingle()

  let tabId = openTab?.id as string | undefined
  let createdTab = false
  if (!tabId) {
    const { data: created, error: tabErr } = await supabase
      .from('tabs')
      .insert({
        restaurant_id: table.restaurant_id,
        table_id: table.id,
        table_number: table.table_number,
        status: 'open',
        total: 0,
        members: [],
      })
      .select('id')
      .single()
    assert(!tabErr && created?.id, `failed to open tab: ${tabErr?.message}`)
    tabId = created.id
    createdTab = true
  }

  const idem = `verify-23505-${Date.now()}-${Math.random().toString(16).slice(2)}`
  const seededCheckout = `https://verify-23505.test/checkout/${idem}`
  const seededMerchant = `FT-VERIFY-23505-${Date.now()}`

  const { data: seeded, error: seedErr } = await supabase
    .from('orders')
    .insert({
      restaurant_id: table.restaurant_id,
      table_id: table.id,
      table_number: table.table_number,
      session_id: `sess_23505_${Date.now()}`,
      status: 'pending',
      payment_status: 'pending',
      payment_method: 'card',
      payment_channel: 'hosted',
      channel: 'online',
      items: [],
      subtotal: 10,
      tax: 0,
      total: 10,
      is_closed: false,
      idempotency_key: idem,
      payment_checkout_url: seededCheckout,
      paycloud_merchant_order_no: seededMerchant,
      order_number: 999001,
    })
    .select('id, payment_checkout_url, paycloud_merchant_order_no')
    .single()
  assert(!seedErr && seeded?.id, `seed order failed: ${seedErr?.message}`)
  log('seeded order for 23505', seeded)

  const { data: menuItem } = await supabase
    .from('menu_items')
    .select('id')
    .eq('restaurant_id', table.restaurant_id)
    .in('status', ['available', 'active'])
    .limit(1)
    .maybeSingle()

  const items = menuItem?.id
    ? [{ menuItemId: menuItem.id, quantity: 1, name: 'verify-item' }]
    : []

  // First (and only) HTTP call — conflicts with seeded row → 23505 handler.
  const res1 = await fetch(`${WORKER}/api/orders`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-idempotency-key': idem,
    },
    body: JSON.stringify({
      restaurantId: table.restaurant_id,
      tableNumber: table.table_number,
      channel: 'online',
      paymentMethod: 'card',
      paymentChannel: 'hosted',
      session_id: `sess_23505_http_${Date.now()}`,
      items,
      subtotal: 10,
      total: 10,
    }),
  })
  const body1 = await res1.json().catch(() => ({}))
  log('23505 retry HTTP status', res1.status)
  log('23505 retry HTTP body', body1)

  // Cleanup before asserts so failures don't leave orphan rows
  await supabase.from('orders').delete().eq('id', seeded.id)
  if (createdTab && tabId) {
    await supabase.from('tabs').delete().eq('id', tabId)
  }

  assert(res1.ok, `expected 2xx on 23505 retry, got ${res1.status}`)
  assert(body1.success === true, 'expected success:true')
  assert(String(body1.orderId) === String(seeded.id), 'expected existing orderId')
  assert(
    String(body1.checkoutUrl || '') === seededCheckout,
    `expected checkoutUrl=${seededCheckout}, got ${body1.checkoutUrl}`,
  )
  assert(
    String(body1.merchantOrderNo || '') === seededMerchant,
    `expected merchantOrderNo=${seededMerchant}, got ${body1.merchantOrderNo}`,
  )
  assert(body1.paymentStatus != null, 'expected paymentStatus in full payload')
  assert(body1.restaurantId != null, 'expected restaurantId in full payload')

  log('23505 verdict', {
    verified: true,
    returnedCheckoutUrl: body1.checkoutUrl,
    returnedMerchantOrderNo: body1.merchantOrderNo,
    returnedOrderId: body1.orderId,
  })

  console.log('PROBE_REALTIME_AND_23505_OK')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
