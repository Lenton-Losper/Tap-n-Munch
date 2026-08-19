/**
 * WHAT DID Add Location ACTUALLY CREATE, AND WHAT DOES THE NEW SITE STILL LACK? Read-only.
 *
 * ChowNow Nedbank is the first restaurant ever created through create_organization_location on
 * production. Two questions:
 *
 *   1. did it create a restaurant_users row for the creator, or only the restaurants row --
 *      because restaurant_users is the ONLY thing that grants access to a restaurant
 *   2. what does a working site need that this one has not got
 *
 * Question 2 is asked table by table rather than by reading the RPC, because the RPC is what we
 * would be checking against and a missing INSERT looks the same in both. The tax_rates row matters
 * most: menu_items.tax_rate_id is nullable and null means "the restaurant's default rate, or 0% if
 * there is no default" -- a site with no tax_rates rows at all prices everything at zero VAT.
 *
 * SELECTS ONLY.
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

const ORG = '5608ba8f-54a7-445b-aca5-80593663670c'
const RIVIERA = '01bf27f1-a958-4322-bb3e-cc5240987808'
const CHOWNOW = 'b161c758-582d-4dfa-839a-9fa35c492a49'
const FLASHTAPAPP2 = 'f9bf5348-1c1c-4574-8830-13b249722097'

async function countFor(table: string, column: string, id: string) {
  const { data, error } = await admin.from(table).select('*').eq(column, id).limit(1)
  if (error) return { n: null, err: error.message, code: error.code }
  const { count, error: cErr } = await admin
    .from(table).select('id', { count: 'exact', head: true }).eq(column, id)
  if (cErr) return { n: null, err: cErr.message, code: cErr.code }
  return { n: count ?? 0, sample: data?.[0] ?? null }
}

async function main() {
  console.log('\nNEW LOCATION READINESS — production, read-only.')
  console.log(`  project ref confirmed in URL: ${PRODUCTION_REF}\n`)

  const { data: ctl, error: ctlErr } = await admin.from('restaurants').select('id').limit(1)
  if (ctlErr) throw new Error(`control read failed: ${ctlErr.message}`)
  console.log(`  [control] restaurants readable: ${ctl?.length ? 'YES' : 'NO'}`)

  // ---- find the new site
  const { data: orgRests, error: oErr } = await admin
    .from('restaurants')
    .select('id, name, organization_id, location_type, timezone, currency, is_active, owner_id, created_at')
    .eq('organization_id', ORG)
    .order('created_at')
  if (oErr) throw new Error(`org restaurants read failed: ${oErr.message}`)
  console.log(`\n  RESTAURANTS IN Gosto Investment CC: ${orgRests?.length}`)
  for (const r of orgRests ?? []) {
    console.log(`      ${String(r.name).padEnd(20)} ${r.id}  created ${r.created_at}`)
    console.log(`          location_type=${r.location_type}  tz=${r.timezone}  ccy=${r.currency}  is_active=${r.is_active}  owner_id=${r.owner_id ?? '(null)'}`)
  }

  const fresh = (orgRests ?? []).find((r) => r.id !== RIVIERA && r.id !== CHOWNOW)
  if (!fresh) {
    console.error('\n  NEW LOCATION NOT FOUND — cannot answer anything below.')
    process.exit(1)
  }
  console.log(`\n  NEW SITE: ${fresh.name}  ${fresh.id}`)

  // ---- Q1: does the creator have access?
  console.log('\n  1. ACCESS — restaurant_users is the ONLY thing that grants it')
  const { data: ru, error: ruErr } = await admin
    .from('restaurant_users').select('user_id, role, invite_accepted, deleted_at, created_at').eq('restaurant_id', fresh.id)
  if (ruErr) {
    console.log(`      READ FAILED: ${ruErr.message}`)
  } else {
    console.log(`      rows: ${ru?.length}`)
    for (const m of ru ?? []) {
      const mine = String(m.user_id) === FLASHTAPAPP2
      console.log(`          ${m.user_id}  role=${m.role}  accepted=${m.invite_accepted}  deleted_at=${m.deleted_at ?? '(null)'}${mine ? '   <-- flashtapapp2@gmail.com' : ''}`)
    }
    const has = (ru ?? []).some((m) => String(m.user_id) === FLASHTAPAPP2 && !m.deleted_at)
    console.log(`      flashtapapp2 has a live row: ${has ? 'YES' : 'NO — the site is unreachable'}`)
  }

  // ---- how many restaurants does that account now belong to?
  const { data: mine } = await admin
    .from('restaurant_users').select('restaurant_id, role').eq('user_id', FLASHTAPAPP2).is('deleted_at', null)
  console.log(`\n      flashtapapp2 now belongs to ${mine?.length} restaurant(s):`)
  for (const m of mine ?? []) {
    const r = (orgRests ?? []).find((x) => x.id === m.restaurant_id)
    console.log(`          ${m.restaurant_id}  role=${m.role}  ${r?.name ?? '(other org)'}`)
  }
  const ownerRows = (mine ?? []).filter((m) => m.role === 'owner').length
  console.log(`      of which role='owner': ${ownerRows}`)
  console.log('      ^ the session bootstrap sorts owner rows first and takes [0]. With more than')
  console.log('        one owner row the tie-break does not disambiguate, so which site the app')
  console.log('        opens on falls back to unordered query output.')

  // ---- Q4: what is missing
  console.log('\n  2. WHAT THE NEW SITE HAS, VERSUS THE TWO ESTABLISHED ONES')
  const TABLES: Array<[string, string]> = [
    ['tax_rates', 'restaurant_id'],
    ['restaurant_tables', 'restaurant_id'],
    ['menu_categories', 'restaurant_id'],
    ['menu_items', 'restaurant_id'],
    ['stock_items', 'restaurant_id'],
    ['restaurant_roles', 'restaurant_id'],
    ['restaurant_setup_status', 'restaurant_id'],
    ['restaurant_settings', 'restaurant_id'],
    ['terminals', 'restaurant_id'],
    ['printer_configs', 'restaurant_id'],
  ]
  console.log(`      ${'table'.padEnd(26)} ${'NEW'.padStart(6)} ${'Riviera'.padStart(8)} ${'ChowNow'.padStart(8)}`)
  for (const [t, col] of TABLES) {
    const a = await countFor(t, col, fresh.id)
    const b = await countFor(t, col, RIVIERA)
    const c = await countFor(t, col, CHOWNOW)
    if (a.n === null && a.code) {
      console.log(`      ${t.padEnd(26)} table absent/unreadable (${a.code})`)
      continue
    }
    const flag = a.n === 0 && ((b.n ?? 0) > 0 || (c.n ?? 0) > 0) ? '   <-- EMPTY on the new site' : ''
    console.log(`      ${t.padEnd(26)} ${String(a.n).padStart(6)} ${String(b.n).padStart(8)} ${String(c.n).padStart(8)}${flag}`)
  }

  // ---- the VAT question specifically
  console.log('\n  3. VAT — the one that reaches a receipt')
  for (const [label, id] of [['NEW SITE', fresh.id], ['Riviera', RIVIERA], ['FNB ChowNow', CHOWNOW]]) {
    const { data: rates } = await admin
      .from('tax_rates').select('name, percentage, is_inclusive, is_default').eq('restaurant_id', id)
    console.log(`      ${String(label).padEnd(12)} ${rates?.length ?? 0} rate(s): ${(rates ?? []).map((r) => `${r.name} ${r.percentage}%${r.is_default ? ' DEFAULT' : ''}${r.is_inclusive ? ' incl' : ' excl'}`).join(' | ') || '(none)'}`)
  }
  console.log('      menu_items.tax_rate_id is nullable; null means the restaurant default, or 0%')
  console.log('      when there is no default. A site with zero tax_rates rows charges no VAT.')
}

main().catch((e) => {
  console.error('FATAL', e?.message ?? e)
  process.exit(1)
})
