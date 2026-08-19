/**
 * PRE-MERGE SNAPSHOT + COLLISION CHECK. Production, strictly READ-ONLY.
 *
 * Two jobs, both of which must happen BEFORE any statement runs:
 *
 *   1. SNAPSHOT every row the merge would change, printed as JSON, so a rollback is a paste rather
 *      than a reconstruction. Includes rows the merge does NOT change but whose meaning depends on
 *      it (restaurant_users, stock_items) -- "unchanged" is a claim that needs a before-value too.
 *
 *   2. THE COLLISION CHECK, which is the one thing the schema will not do for us.
 *      organization_stock_items has NO unique index on (organization_id, name) -- only a plain
 *      index on organization_id. So merging two catalogues that both contain "Coke" does not fail;
 *      it silently produces two identically-named rows in one organisation, and the transfer picker
 *      then offers the user a choice between two things that look the same. A constraint violation
 *      would at least be loud. This is not, so it is checked here.
 *
 * Also emits the ROLLBACK statements, generated from the measured before-values rather than written
 * by hand, so they cannot drift from what was actually there.
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

const SURVIVING_ORG = '5608ba8f-54a7-445b-aca5-80593663670c' // Riviera's organisation
const MOVING_ORG = '1d623c21-8c5e-40fd-b7bc-df654166d412' // FNB ChowNow's organisation
const MOVING_RESTAURANT = 'b161c758-582d-4dfa-839a-9fa35c492a49' // FNB ChowNow
const RIVIERA_RESTAURANT = '01bf27f1-a958-4322-bb3e-cc5240987808'

const dump = (label, rows) => {
  console.log(`\n  --- ${label} (${rows?.length ?? 0} rows)`)
  for (const r of rows ?? []) console.log(`      ${JSON.stringify(r)}`)
}

async function readAll(table, column, values, select) {
  const { data, error } = await admin.from(table).select(select).in(column, values)
  if (error) throw new Error(`${table} read failed: ${error.message}`)
  return data ?? []
}

async function main() {
  console.log('\nPRE-MERGE SNAPSHOT — production, read-only, changes nothing.')
  console.log(`  project ref confirmed in URL: ${PRODUCTION_REF}`)

  const { data: ctl, error: ctlErr } = await admin.from('restaurants').select('id').limit(1)
  if (ctlErr) throw new Error(`control read failed: ${ctlErr.message}`)
  console.log(`  [control] restaurants readable: ${ctl?.length ? 'YES' : 'NO — nothing below means anything'}`)

  // ---------------------------------------------------------------- the rows that CHANGE
  const orgs = await readAll('organizations', 'id', [SURVIVING_ORG, MOVING_ORG], '*')
  dump('organizations (BEFORE)', orgs)

  const rests = await readAll('restaurants', 'id', [MOVING_RESTAURANT, RIVIERA_RESTAURANT],
    'id, name, organization_id, location_type, timezone, currency')
  dump('restaurants (BEFORE) — organization_id is what changes', rests)

  const movingCatalogue = (await readAll('organization_stock_items', 'organization_id', [MOVING_ORG], '*'))
    .sort((a, b) => String(a.name).localeCompare(String(b.name)))
  dump('organization_stock_items to MOVE (BEFORE)', movingCatalogue)

  const survivingCatalogue = (await readAll('organization_stock_items', 'organization_id', [SURVIVING_ORG], '*'))
    .sort((a, b) => String(a.name).localeCompare(String(b.name)))
  dump('organization_stock_items already in the SURVIVING org', survivingCatalogue)

  // ---------------------------------------------------------------- rows that must NOT change
  const orgUsers = await readAll('organization_users', 'organization_id', [SURVIVING_ORG, MOVING_ORG], '*')
  dump('organization_users (BEFORE) — org-level capability', orgUsers)

  const restUsers = await readAll('restaurant_users', 'restaurant_id', [MOVING_RESTAURANT, RIVIERA_RESTAURANT], '*')
  dump('restaurant_users (BEFORE) — staff access, MUST be identical afterwards', restUsers)

  const stockItems = await readAll('stock_items', 'restaurant_id', [MOVING_RESTAURANT, RIVIERA_RESTAURANT],
    'id, restaurant_id, name, organization_stock_item_id, is_active')
  dump('stock_items (BEFORE) — untouched by the merge, but their invariant depends on it', stockItems)

  // ---------------------------------------------------------------- THE COLLISION CHECK
  console.log('\n  ================ CATALOGUE NAME COLLISIONS')
  console.log('  organization_stock_items has NO unique index on (organization_id, name), so a')
  console.log('  collision does not fail -- it silently creates two identical-looking rows.')
  const norm = (n) => String(n ?? '').trim().toLowerCase()
  const survivingNames = new Map(survivingCatalogue.map((r) => [norm(r.name), r]))
  const collisions = movingCatalogue.filter((r) => survivingNames.has(norm(r.name)))
  if (!collisions.length) {
    console.log(`\n  NONE. ${movingCatalogue.length} moving names vs ${survivingCatalogue.length} existing, no overlap.`)
    console.log('  The merged catalogue would have ' + (movingCatalogue.length + survivingCatalogue.length) + ' distinct entries.')
  } else {
    console.log(`\n  *** ${collisions.length} COLLISION(S) — the merge would create duplicates:`)
    for (const c of collisions) {
      const other = survivingNames.get(norm(c.name))
      console.log(`      "${c.name}"  moving ${c.id}  <->  existing ${other.id}`)
      console.log(`          same base_unit? ${String(c.base_unit_id === other.base_unit_id)}   same is_manufactured? ${String(c.is_manufactured === other.is_manufactured)}`)
    }
    console.log('\n  STOP AND RULE ON THESE before merging. Deduplicating after the fact means')
    console.log('  re-pointing stock_items rows, which DOES fire the cross-org trigger.')
  }

  // ---------------------------------------------------------------- generated rollback
  console.log('\n  ================ ROLLBACK (generated from the measured values above)')
  console.log('  BEGIN;')
  for (const r of rests) {
    console.log(`    UPDATE public.restaurants SET organization_id = '${r.organization_id}' WHERE id = '${r.id}';`)
  }
  for (const r of movingCatalogue) {
    console.log(`    UPDATE public.organization_stock_items SET organization_id = '${r.organization_id}' WHERE id = '${r.id}';`)
  }
  for (const o of orgs) {
    console.log(`    UPDATE public.organizations SET name = ${JSON.stringify(o.name).replace(/"/g, "'")} WHERE id = '${o.id}';`)
  }
  console.log('  COMMIT;')
  console.log('\n  ^ Paste-ready. Every value came from a read a moment ago, not from a hand-written guess.')
}

main().catch((e) => {
  console.error('FATAL', e?.message ?? e)
  process.exit(1)
})
