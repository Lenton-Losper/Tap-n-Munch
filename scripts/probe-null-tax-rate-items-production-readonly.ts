/**
 * HOW MANY MENU ITEMS HAVE NO TAX RATE SET? Production, strictly read-only.
 *
 * Ruled 2026-08-18: a menu item cannot be saved without an explicitly chosen tax rate. Zero-rating
 * stays available, but as a deliberate selection rather than a silent fallback — because a
 * forgotten rate reached a paid receipt at 0% VAT (order #10, coffee at NAD 50.00).
 *
 * EXISTING rows are NOT touched. Assigning a rate changes what a customer is charged, so the
 * decision is the owner's. This counts them and names the restaurants, and nothing else.
 *
 * Selects only. No writes, no fixture.
 */
// @ts-nocheck
import { createClient } from '@supabase/supabase-js'

const PRODUCTION_REF = 'ihlmmpmolnpchzgwyhgh'
const url = process.env.SUPABASE_URL || ''
const key = process.env.SUPABASE_SERVICE_ROLE_KEY || ''
if (!url.includes(PRODUCTION_REF)) throw new Error(`REFUSING: ${url || '(unset)'} is not production`)
const admin = createClient(url, key, { auth: { persistSession: false } })

async function main() {
  console.log('\nPRODUCTION — menu items with no tax rate set, read-only\n')

  const { count: total, error: ctlErr } = await admin
    .from('menu_items')
    .select('id', { count: 'exact', head: true })
  if (ctlErr) throw new Error(`control read failed: ${ctlErr.message}`)
  console.log(`  [control] menu_items readable, total rows : ${total}`)
  if (!total) {
    console.log('  NO ROWS — nothing below would mean anything')
    return
  }

  const { count: nullRate } = await admin
    .from('menu_items')
    .select('id', { count: 'exact', head: true })
    .is('tax_rate_id', null)
  console.log(`  tax_rate_id IS NULL                      : ${nullRate}  of ${total}`)

  // Per restaurant, with the restaurant's own default so the effective rate is visible.
  const { data: rows } = await admin
    .from('menu_items')
    .select('id, name, restaurant_id, status')
    .is('tax_rate_id', null)
    .limit(5000)

  const byRestaurant = new Map()
  for (const r of rows ?? []) {
    const k = String(r.restaurant_id)
    if (!byRestaurant.has(k)) byRestaurant.set(k, [])
    byRestaurant.get(k).push(r)
  }

  const ids = [...byRestaurant.keys()]
  const names = new Map()
  for (let i = 0; i < ids.length; i += 100) {
    const { data } = await admin.from('restaurants').select('id, name').in('id', ids.slice(i, i + 100))
    for (const r of data ?? []) names.set(String(r.id), r.name)
  }
  const defaults = new Map()
  for (let i = 0; i < ids.length; i += 100) {
    const { data } = await admin
      .from('tax_rates')
      .select('restaurant_id, name, percentage, is_default')
      .in('restaurant_id', ids.slice(i, i + 100))
    for (const r of data ?? []) {
      if (r.is_default) defaults.set(String(r.restaurant_id), `${r.name} ${r.percentage}%`)
    }
  }

  console.log('\n  BY RESTAURANT (items with no rate / that restaurant’s default rate)')
  const sorted = [...byRestaurant.entries()].sort((a, b) => b[1].length - a[1].length)
  for (const [rid, items] of sorted) {
    const available = items.filter((i) => String(i.status) === 'available').length
    console.log(
      `    ${String(items.length).padStart(5)} items (${available} available)  ` +
        `default=${defaults.get(rid) ?? 'NONE SET'}  ${names.get(rid) ?? '(unknown)'}  ${rid}`,
    )
  }

  console.log(
    '\n  NOTHING HAS BEEN CHANGED. Assigning a rate to an existing item changes what a customer\n' +
      '  is charged, so which of these become Standard, which become an explicit zero, and which\n' +
      '  are retired is the owner’s decision.',
  )
}

main().catch((e) => {
  console.error('FATAL', e?.message ?? e)
  process.exit(1)
})
