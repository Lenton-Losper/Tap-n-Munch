/**
 * POST-MERGE VERIFICATION, measured independently of the SQL that did the work.
 *
 * 02-verify-merge.sql runs inside the same `db query` session as the merge and proves the trigger
 * two-sidedly (accept + a cross-org control) in a rolled-back transaction. This runs afterwards,
 * through the ordinary PostgREST client -- a different connection, a different code path -- and
 * re-measures the committed result. Two independent instruments, because a check that shares its
 * plumbing with the thing it checks can fail in the same direction.
 *
 * IT ATTEMPTS A REAL WRITE. The cross-organisation invariant is enforced by a trigger that fires
 * only on a write to stock_items, and nothing in the merge fires it -- so reading rows back cannot
 * tell you the invariant holds. The write is a self-assignment: setting organization_stock_item_id
 * to the value it already has. Naming the column in the update is what makes
 * `BEFORE UPDATE OF organization_stock_item_id` fire, so the guard is genuinely exercised while the
 * data is unchanged.
 *
 * The destructive half of the control (a cross-org write that MUST be refused) is deliberately NOT
 * repeated here: if the guard were dead, that attempt would COMMIT a bad value through a client
 * that cannot roll back. It belongs where it already is -- inside 02's transaction.
 *
 * Everything else is a select.
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
const EMPTIED_ORG = '1d623c21-8c5e-40fd-b7bc-df654166d412'
const CHOWNOW = 'b161c758-582d-4dfa-839a-9fa35c492a49'
const RIVIERA = '01bf27f1-a958-4322-bb3e-cc5240987808'

let failures = 0
const check = (label, pass, detail) => {
  if (!pass) failures += 1
  console.log(`  [${pass ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}

async function main() {
  console.log('\nPOST-MERGE VERIFICATION — production, measured independently.')
  console.log(`  project ref confirmed in URL: ${PRODUCTION_REF}\n`)

  const { data: ctl, error: ctlErr } = await admin.from('restaurants').select('id').limit(1)
  if (ctlErr) throw new Error(`control read failed: ${ctlErr.message}`)
  console.log(`  [control] restaurants readable: ${ctl?.length ? 'YES' : 'NO'}\n`)

  // ---- 1. both restaurants report the surviving organisation
  const { data: rests, error: rErr } = await admin
    .from('restaurants').select('id, name, organization_id').in('id', [CHOWNOW, RIVIERA])
  if (rErr) throw new Error(`restaurants read failed: ${rErr.message}`)
  for (const r of rests ?? []) {
    check(`${r.name} is in the surviving organisation`, r.organization_id === SURVIVING_ORG, r.organization_id)
  }
  check('both restaurants found', (rests ?? []).length === 2, `${rests?.length} found`)

  // ---- the organisation is renamed
  const { data: org } = await admin.from('organizations').select('id, name, owner_user_id').eq('id', SURVIVING_ORG).maybeSingle()
  check('organisation renamed to "Gosto Investment CC"', org?.name === 'Gosto Investment CC', org?.name)

  // ---- 2. all stock_items link to catalogue rows in that org
  const { data: items, error: iErr } = await admin
    .from('stock_items').select('id, name, restaurant_id, organization_stock_item_id').in('restaurant_id', [CHOWNOW, RIVIERA])
  if (iErr) throw new Error(`stock_items read failed: ${iErr.message}`)
  const catIds = [...new Set((items ?? []).map((i) => i.organization_stock_item_id).filter(Boolean))]
  const { data: cats, error: cErr } = await admin
    .from('organization_stock_items').select('id, name, organization_id').in('id', catIds)
  if (cErr) throw new Error(`catalogue read failed: ${cErr.message}`)
  const orgOfCat = new Map((cats ?? []).map((c) => [String(c.id), String(c.organization_id)]))
  const crossOrg = (items ?? []).filter(
    (i) => i.organization_stock_item_id && orgOfCat.get(String(i.organization_stock_item_id)) !== SURVIVING_ORG,
  )
  check(`all ${items?.length} stock_items link into the surviving org`, crossOrg.length === 0,
    crossOrg.length ? `${crossOrg.length} cross-org: ${crossOrg.map((i) => i.name).join(', ')}` : '0 cross-org')

  const { count: leftBehind } = await admin
    .from('organization_stock_items').select('id', { count: 'exact', head: true }).eq('organization_id', EMPTIED_ORG)
  check('no catalogue rows left in the emptied organisation', leftBehind === 0, `${leftBehind} remaining`)

  const { count: merged } = await admin
    .from('organization_stock_items').select('id', { count: 'exact', head: true }).eq('organization_id', SURVIVING_ORG)
  check('merged catalogue holds 10 items', merged === 10, `${merged} items`)

  // ---- 3. THE WRITE. The invariant is only observable by attempting one.
  const subject = (items ?? []).find((i) => i.restaurant_id === CHOWNOW && i.organization_stock_item_id)
  if (!subject) {
    check('a moved stock_items row exists to write to', false, 'none found')
  } else {
    const { error: wErr } = await admin
      .from('stock_items')
      .update({ organization_stock_item_id: subject.organization_stock_item_id })
      .eq('id', subject.id)
    check(`the trigger ACCEPTS a write to moved row "${subject.name}"`, !wErr, wErr ? wErr.message : 'accepted')

    const { data: after } = await admin
      .from('stock_items').select('organization_stock_item_id').eq('id', subject.id).maybeSingle()
    check('the row is unchanged by the probe write', after?.organization_stock_item_id === subject.organization_stock_item_id)
  }

  // ---- 4. staff access unchanged
  const { data: staff, error: sErr } = await admin
    .from('restaurant_users').select('restaurant_id, user_id, role, deleted_at').in('restaurant_id', [CHOWNOW, RIVIERA])
  if (sErr) throw new Error(`restaurant_users read failed: ${sErr.message}`)
  const live = (staff ?? []).filter((s) => !s.deleted_at)
  check('4 live restaurant_users rows, as before the merge', live.length === 4, `${live.length} live of ${staff?.length}`)
  for (const s of live) console.log(`        ${s.restaurant_id.slice(0, 8)}  ${s.user_id.slice(0, 8)}  ${s.role}`)

  // ---- 5. the owner can reach Add Location / view-all-locations
  //         authorizeOrganization reads organization_users, OWNER rows only, on the org the
  //         caller's restaurant belongs to. This is that lookup, for BOTH restaurants.
  const { data: owners, error: oErr } = await admin
    .from('organization_users').select('user_id, role').eq('organization_id', SURVIVING_ORG).eq('role', 'OWNER')
  if (oErr) throw new Error(`organization_users read failed: ${oErr.message}`)
  const { data: users } = await admin.from('users').select('id, email').in('id', (owners ?? []).map((o) => o.user_id))
  const emails = (owners ?? []).map((o) => (users ?? []).find((u) => u.id === o.user_id)?.email)
  check('exactly one OWNER on the surviving organisation', (owners ?? []).length === 1, emails.join(', '))
  check('that owner is flashtapapp2@gmail.com', emails[0] === 'flashtapapp2@gmail.com', String(emails[0]))
  console.log('        ^ both restaurants now resolve to this org, so this account holds')
  console.log('          create_location and view_all_locations for BOTH sites.')

  const { data: strandedOwners } = await admin
    .from('organization_users').select('user_id').eq('organization_id', EMPTIED_ORG)
  console.log(`\n  note: ${strandedOwners?.length ?? 0} OWNER row(s) remain on the emptied organisation`)
  console.log('        (flashtaptestacc1@gmail.com — no org capability now, restaurant access untouched)')

  console.log(`\n  ${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`)
  if (failures) process.exit(1)
}

main().catch((e) => {
  console.error('FATAL', e?.message ?? e)
  process.exit(1)
})
