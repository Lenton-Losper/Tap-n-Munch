/**
 * WHY DOES SETTINGS > BUSINESS > LOCATIONS SHOW ONLY RIVIERA? Production, strictly READ-ONLY.
 *
 * The merge is verified correct at the data layer, so the question is not "did the merge work" but
 * "what does the LIST actually read". Three candidate explanations, and this separates them by
 * measurement rather than by argument:
 *
 *   A. locations are modelled in a separate table the merge never touched
 *   B. the list filters on something other than organization_id (a status, an is_active, a join)
 *   C. RLS hides the row from this specific signed-in user
 *
 * A and B are answered by reading the source, which this script quotes rather than paraphrases.
 * C is what this script MEASURES, by evaluating the policy predicate itself:
 *
 *     Staff can select restaurants they belong to:
 *        id IN (SELECT public.user_restaurant_ids())  OR  owner_id = auth.uid()
 *     user_restaurant_ids() =
 *        SELECT restaurant_id FROM restaurant_users WHERE user_id = auth.uid()
 *        UNION
 *        SELECT id FROM restaurants WHERE owner_id = auth.uid()
 *
 * Note what is NOT in that predicate: organization_id. There is no organisation-wide read path on
 * restaurants at all.
 *
 * The service-role client used here BYPASSES RLS, which is exactly what makes it the right
 * instrument -- it can see the row the user cannot, so the two answers can be compared. A read that
 * came back empty for both would prove nothing.
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

const SURVIVING_ORG = '5608ba8f-54a7-445b-aca5-80593663670c'
const CHOWNOW = 'b161c758-582d-4dfa-839a-9fa35c492a49'
const RIVIERA = '01bf27f1-a958-4322-bb3e-cc5240987808'
const FLASHTAPAPP2 = 'f9bf5348-1c1c-4574-8830-13b249722097'

async function main() {
  console.log('\nWHY IS FNB CHOWNOW MISSING FROM THE LOCATIONS LIST? Read-only.')
  console.log(`  project ref confirmed in URL: ${PRODUCTION_REF}\n`)

  const { data: ctl, error: ctlErr } = await admin.from('restaurants').select('id').limit(1)
  if (ctlErr) throw new Error(`control read failed: ${ctlErr.message}`)
  console.log(`  [control] restaurants readable with service role: ${ctl?.length ? 'YES' : 'NO'}`)

  // ---- what the list's own query returns, WITHOUT RLS
  const { data: asAdmin, error: aErr } = await admin
    .from('restaurants')
    .select('id, name, location_type, address, organization_id, owner_id, deleted_at, is_active')
    .eq('organization_id', SURVIVING_ORG)
    .order('name')
  if (aErr) throw new Error(`org restaurants read failed: ${aErr.message}`)

  console.log(`\n  THE LIST'S QUERY, service role (RLS BYPASSED): ${asAdmin?.length} row(s)`)
  for (const r of asAdmin ?? []) {
    console.log(`      ${String(r.name).padEnd(16)} id=${r.id}`)
    console.log(`          organization_id ${r.organization_id}`)
    console.log(`          owner_id        ${r.owner_id ?? '(null)'}`)
    console.log(`          deleted_at      ${r.deleted_at ?? '(null)'}   is_active ${r.is_active}`)
  }
  console.log('  ^ if BOTH appear here, organization_id is correct and the merge is not the problem.')

  // ---- now evaluate the RLS predicate for this specific user, by hand
  console.log(`\n  THE POLICY PREDICATE, for flashtapapp2@gmail.com (${FLASHTAPAPP2})`)

  const { data: memberships, error: mErr } = await admin
    .from('restaurant_users')
    .select('restaurant_id, role, deleted_at')
    .eq('user_id', FLASHTAPAPP2)
  if (mErr) throw new Error(`restaurant_users read failed: ${mErr.message}`)
  const memberIds = new Set((memberships ?? []).map((m) => String(m.restaurant_id)))
  console.log(`      restaurant_users rows for this user: ${memberships?.length}`)
  for (const m of memberships ?? []) {
    console.log(`          ${m.restaurant_id}  role=${m.role}  deleted_at=${m.deleted_at ?? '(null)'}`)
  }

  const { data: owned, error: oErr } = await admin
    .from('restaurants').select('id, name').eq('owner_id', FLASHTAPAPP2)
  if (oErr) console.log(`      owner_id read FAILED: ${oErr.message}`)
  const ownedIds = new Set((owned ?? []).map((r) => String(r.id)))
  console.log(`      restaurants with owner_id = this user: ${owned?.length ?? 0}`)
  for (const r of owned ?? []) console.log(`          ${r.id}  ${r.name}`)

  console.log('\n  VERDICT PER RESTAURANT — would the policy let this user SELECT it?')
  for (const r of asAdmin ?? []) {
    const byMembership = memberIds.has(String(r.id))
    const byOwner = ownedIds.has(String(r.id))
    const visible = byMembership || byOwner
    console.log(
      `      ${String(r.name).padEnd(16)} ${visible ? 'VISIBLE' : 'HIDDEN '}   ` +
        `membership=${byMembership}  owner_id=${byOwner}`,
    )
  }

  console.log('\n  organization_id does not appear in the policy predicate at all, so moving a')
  console.log('  restaurant between organisations cannot make it visible to anyone new.')

  // ---- is there any separate "locations" table the merge failed to touch?
  console.log('\n  IS THERE A SEPARATE LOCATIONS TABLE THE MERGE MISSED?')
  for (const t of ['organization_locations', 'locations', 'organization_restaurants', 'restaurant_locations']) {
    const { error } = await admin.from(t).select('*').limit(1)
    console.log(`      ${t.padEnd(26)} ${error ? `absent (${error.code})` : '*** EXISTS — investigate'}`)
  }
  console.log('      ^ non-head selects: a head-count returns count=null/error=null for a missing')
  console.log('        table, so it would report every one of these as present (#169/#290).')
}

main().catch((e) => {
  console.error('FATAL', e?.message ?? e)
  process.exit(1)
})
