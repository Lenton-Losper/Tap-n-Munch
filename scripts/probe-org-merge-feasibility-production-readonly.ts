/**
 * COULD RIVIERA AND THE CHOWNOWS SHARE ONE ORGANISATION? Production, strictly READ-ONLY.
 *
 * No organisation on production has ever held two restaurants, so this is not a question about a
 * supported flow -- it is a question about what a data change would land on. Measured, not reasoned:
 *
 *   1. the organisations behind each restaurant, and what each is NAMED (names drift after a rename
 *      -- the org name is captured at signup and nothing keeps it in step)
 *   2. owner_user_id on each org, resolved to an email
 *   3. organization_users rows, resolved to emails -- who holds org-level capability today
 *   4. restaurant_users rows -- who holds STAFF access, which is a different table and a different
 *      question, and the one that actually decides who can log in and work
 *   5. what a change to restaurants.organization_id would strand: stock_items pointing at an
 *      organization_stock_items row belonging to the OLD organisation
 *
 * Point 5 is the whole risk. stock_items.organization_stock_item_id is validated by a trigger on
 * STOCK_ITEMS, not on restaurants -- so moving a restaurant between organisations does not re-check
 * anything, and every existing link silently becomes cross-organisation.
 *
 * SELECTS ONLY. No insert, update, delete or rpc.
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

const INTERESTING = /riviera|chownow|chow now/i

async function main() {
  console.log('\nPRODUCTION — organisation merge feasibility. Read-only, changes nothing.\n')

  const { data: ctl, error: ctlErr } = await admin.from('restaurants').select('id').limit(1)
  if (ctlErr) throw new Error(`control read failed: ${ctlErr.message}`)
  console.log(`  [control] restaurants readable : ${ctl?.length ? 'YES' : 'NO'}`)

  const { data: rests, error: rErr } = await admin
    .from('restaurants')
    .select('id, name, organization_id, location_type, created_at')
  if (rErr) throw new Error(`restaurants read failed: ${rErr.message}`)
  const targets = (rests ?? []).filter((r) => INTERESTING.test(String(r.name)))
  console.log(`\n  matched restaurants: ${targets.length} of ${rests?.length ?? 0}`)

  const { data: orgs, error: oErr } = await admin
    .from('organizations')
    .select('id, name, legal_name, owner_user_id, created_at')
  if (oErr) throw new Error(`organizations read failed: ${oErr.message}`)
  const orgById = new Map((orgs ?? []).map((o) => [String(o.id), o]))

  const { data: users, error: uErr } = await admin.from('users').select('id, email, full_name')
  if (uErr) console.log(`  users read FAILED: ${uErr.message} — emails unavailable`)
  const emailOf = (id) =>
    (users ?? []).find((u) => String(u.id) === String(id))?.email ?? `(no users row: ${id})`

  for (const r of targets) {
    const org = orgById.get(String(r.organization_id))
    console.log(`\n  ================ RESTAURANT: ${r.name}`)
    console.log(`      restaurant_id     ${r.id}`)
    console.log(`      created_at        ${r.created_at}`)
    console.log(`      location_type     ${r.location_type}`)
    console.log(`      organization_id   ${r.organization_id}`)
    console.log(`      ORG NAME          ${org?.name ?? '(org row missing)'}`)
    console.log(`      org legal_name    ${org?.legal_name ?? '(null)'}`)
    console.log(`      org created_at    ${org?.created_at}`)
    console.log(`      org owner_user_id ${org?.owner_user_id}  -> ${emailOf(org?.owner_user_id)}`)
    console.log(`      NAME MATCHES RESTAURANT? ${org?.name === r.name ? 'yes' : 'NO — drifted'}`)

    // --- org-level members
    const { data: ou, error: ouErr } = await admin
      .from('organization_users')
      .select('user_id, role, created_at')
      .eq('organization_id', r.organization_id)
    if (ouErr) {
      console.log(`      organization_users READ FAILED: ${ouErr.message}`)
    } else {
      console.log(`      organization_users (${ou?.length ?? 0}):`)
      for (const m of ou ?? []) {
        console.log(`          ${String(emailOf(m.user_id)).padEnd(34)} ${m.role}   ${m.created_at}`)
      }
    }

    // --- staff access, a DIFFERENT table
    const { data: ru, error: ruErr } = await admin
      .from('restaurant_users')
      .select('user_id, role, created_at')
      .eq('restaurant_id', r.id)
    if (ruErr) {
      console.log(`      restaurant_users READ FAILED: ${ruErr.message}`)
    } else {
      console.log(`      restaurant_users (${ru?.length ?? 0})  <-- this is what grants staff access:`)
      for (const m of ru ?? []) {
        console.log(`          ${String(emailOf(m.user_id)).padEnd(34)} ${m.role}   ${m.created_at}`)
      }
    }

    // --- what a move would strand
    const { data: si, error: siErr } = await admin
      .from('stock_items')
      .select('id, name, organization_stock_item_id, is_active')
      .eq('restaurant_id', r.id)
    if (siErr) {
      console.log(`      stock_items READ FAILED: ${siErr.message}`)
    } else {
      const linked = (si ?? []).filter((x) => x.organization_stock_item_id)
      const active = (si ?? []).filter((x) => x.is_active)
      console.log(
        `      stock_items       ${si?.length ?? 0} total, ${active.length} active, ${linked.length} LINKED to an org catalogue item`,
      )
      console.log(`      ^ every linked row points at an organization_stock_items row owned by the`)
      console.log(`        CURRENT organisation. Change organization_id and each becomes cross-org.`)
    }

    const { count: catCount } = await admin
      .from('organization_stock_items')
      .select('id', { count: 'exact', head: true })
      .eq('organization_id', r.organization_id)
    console.log(`      organization_stock_items in this org: ${catCount}`)

    const { count: xferCount } = await admin
      .from('stock_transfers')
      .select('id', { count: 'exact', head: true })
      .eq('organization_id', r.organization_id)
    console.log(`      stock_transfers in this org:          ${xferCount}`)
  }

  // ---- does the destination org already have anything named like a second site?
  console.log('\n  ALL RESTAURANT NAMES (is "ChowNow Nedbank" already created?)')
  for (const r of rests ?? []) {
    console.log(`      ${String(r.name).padEnd(42)} org=${r.organization_id}`)
  }
}

main().catch((e) => {
  console.error('FATAL', e?.message ?? e)
  process.exit(1)
})
