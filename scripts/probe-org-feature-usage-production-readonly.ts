/**
 * HAS THE ORGANISATIONS FEATURE EVER BEEN USED ON PRODUCTION? Read-only, creates nothing.
 *
 * The first probe established that the tables exist and that 12 organisations have rows. That is
 * NOT the same as the feature having been used: every organisation is auto-created by signup
 * (create_restaurant_for_user inserts one per new restaurant), so a row proves someone signed up,
 * not that anyone grouped anything.
 *
 * The questions that actually distinguish those:
 *   1. does any organisation hold MORE THAN ONE restaurant
 *   2. has a stock transfer ever been created
 *   3. does the shared org-level catalogue (organization_stock_items) hold anything
 *   4. does any organisation have more than one member
 *
 * Non-head selects for existence, per #169/#290. Selects only.
 */
// @ts-nocheck
import { createClient } from '@supabase/supabase-js'

const PRODUCTION_REF = 'ihlmmpmolnpchzgwyhgh'
const url = process.env.SUPABASE_URL || ''
const key = process.env.SUPABASE_SERVICE_ROLE_KEY || ''
if (!url.includes(PRODUCTION_REF)) {
  throw new Error(`REFUSING: ${url || '(unset)'} is not the production project`)
}
const admin = createClient(url, key, { auth: { persistSession: false } })

async function main() {
  console.log('\nPRODUCTION — has the organisations feature ever been USED? Read-only.\n')

  const { data: ctl, error: ctlErr } = await admin.from('restaurants').select('id').limit(1)
  if (ctlErr) throw new Error(`control read failed: ${ctlErr.message}`)
  console.log(`  [control] restaurants readable : ${ctl?.length ? 'YES' : 'NO'}`)

  // 1. multi-restaurant organisations
  const { data: rests, error: rErr } = await admin
    .from('restaurants').select('id, name, organization_id, location_type, created_at')
  if (rErr) throw new Error(`restaurants read failed: ${rErr.message}`)
  const byOrg = new Map<string, any[]>()
  for (const r of rests ?? []) {
    const k = String(r.organization_id)
    byOrg.set(k, [...(byOrg.get(k) ?? []), r])
  }
  const multi = [...byOrg.entries()].filter(([, v]) => v.length > 1)
  console.log(`\n  1. ORGANISATIONS HOLDING MORE THAN ONE RESTAURANT: ${multi.length}`)
  for (const [org, v] of multi) console.log(`      ${org}  ${v.map((x) => x.name).join(' | ')}`)
  if (!multi.length) console.log('      None. Every restaurant is alone in its own organisation.')
  console.log(`      location_type values in use: ${[...new Set((rests ?? []).map((r) => r.location_type))].join(', ')}`)

  // 2/3/4. the tables the feature writes to
  for (const t of ['stock_transfers', 'stock_transfer_items', 'organization_stock_items']) {
    const { data, error } = await admin.from(t).select('*').limit(3)
    if (error) { console.log(`\n  ${t.padEnd(26)} absent/unreadable (${error.code})`); continue }
    const { count } = await admin.from(t).select('id', { count: 'exact', head: true })
    console.log(`\n  ${t.padEnd(26)} ${count} row(s)`)
    for (const row of data ?? []) console.log(`      ${JSON.stringify(row).slice(0, 200)}`)
  }

  const { data: members } = await admin.from('organization_users').select('organization_id, role')
  const memberCounts = new Map<string, number>()
  for (const m of members ?? []) memberCounts.set(m.organization_id, (memberCounts.get(m.organization_id) ?? 0) + 1)
  const multiMember = [...memberCounts.entries()].filter(([, n]) => n > 1)
  console.log(`\n  ORGANISATIONS WITH MORE THAN ONE MEMBER: ${multiMember.length}`)
  console.log(`  roles in use: ${[...new Set((members ?? []).map((m) => m.role))].join(', ')}`)
}

main().catch((e) => { console.error('FATAL', e?.message ?? e); process.exit(1) })
