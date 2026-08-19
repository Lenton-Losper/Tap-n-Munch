/**
 * FNB ChowNow — every restaurant_users and staff_members row, with linked email, role and
 * created_at. Plus the restaurant's current name and any evidence it was renamed.
 *
 * Production, STRICTLY READ-ONLY. Selects only — no insert, update, delete or rpc. Refuses to run
 * unless SUPABASE_URL is the production project.
 *
 * `select('*')` on the small tables deliberately, rather than naming columns. Two probes tonight
 * failed on a guessed column name (`orders.created_at` does not exist; orders use `placed_at`) and
 * one of them then reported a confident absence built on three failed reads. Asking for everything
 * and printing what is there cannot make that mistake.
 *
 * EVERY READ IS ERROR-CHECKED and a failure VOIDS the section rather than printing an empty list —
 * "no rows" and "the query broke" look identical otherwise.
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

const RID = 'b161c758-582d-4dfa-839a-9fa35c492a49'

const pick = (row: Record<string, unknown>, keys: string[]) =>
  keys.map((k) => (k in row ? `${k}=${JSON.stringify(row[k])}` : null)).filter(Boolean).join('  ')

async function main() {
  console.log(`\nPRODUCTION — staff for restaurant ${RID}. Read-only.\n`)

  const { data: ctl, error: ctlErr } = await admin.from('restaurants').select('id').limit(1)
  if (ctlErr) throw new Error(`control read failed: ${ctlErr.message}`)
  console.log(`  [control] restaurants readable : ${ctl?.length ? 'YES' : 'NO — nothing below means anything'}`)

  // ------------------------------------------------------------------ the restaurant
  const { data: rest, error: restErr } = await admin
    .from('restaurants').select('*').eq('id', RID).maybeSingle()
  if (restErr) {
    console.error(`  restaurants read FAILED: ${restErr.message}`)
    process.exitCode = 1
    return
  }
  if (!rest) {
    console.log(`  NO RESTAURANT with id ${RID}. Nothing else to report.`)
    return
  }

  console.log('\n  THE RESTAURANT')
  console.log(`      name          : ${rest.name}`)
  console.log(`      created_at    : ${rest.created_at ?? '(no column)'}`)
  console.log(`      updated_at    : ${rest.updated_at ?? '(no column)'}`)
  for (const k of ['slug', 'firebase_restaurant_id', 'firebase_id', 'location_type']) {
    if (k in rest) console.log(`      ${k.padEnd(14)}: ${rest[k]}`)
  }

  // ------------------------------------------------------------------ renamed?
  console.log('\n  HAS IT EVER BEEN RENAMED?')
  const { data: audits, error: auditErr } = await admin
    .from('audit_logs')
    .select('action, created_at, metadata, entity_type, entity_id')
    .eq('entity_id', RID)
    .order('created_at', { ascending: true })
  if (auditErr) {
    console.log(`      audit_logs read FAILED: ${auditErr.message} — cannot answer from audit`)
  } else {
    const renameish = (audits ?? []).filter((a) =>
      /rename|name/i.test(String(a.action)) || /name/i.test(JSON.stringify(a.metadata ?? {})),
    )
    console.log(`      audit rows for this entity : ${audits?.length ?? 0}`)
    console.log(`      of those mentioning a name : ${renameish.length}`)
    for (const a of renameish) {
      console.log(`        ${a.created_at}  ${a.action}  ${JSON.stringify(a.metadata).slice(0, 200)}`)
    }
  }

  const created = rest.created_at ? new Date(rest.created_at).getTime() : null
  const updated = rest.updated_at ? new Date(rest.updated_at).getTime() : null
  if (created && updated) {
    const changed = updated - created > 1000
    console.log(`      updated_at is ${changed ? 'LATER than' : 'the same as'} created_at`)
    console.log('      ^ a later updated_at proves SOMETHING changed, not that the NAME did.')
  }
  console.log('      NOTE: there is no name-history column. Unless an audit row records it, a')
  console.log('      previous name is not recoverable from this database.')

  // ------------------------------------------------------------------ restaurant_users
  console.log('\n  restaurant_users')
  const { data: ru, error: ruErr } = await admin
    .from('restaurant_users').select('*').eq('restaurant_id', RID)
  if (ruErr) {
    console.error(`      READ FAILED: ${ruErr.message}`)
  } else if (!ru?.length) {
    console.log('      (no rows)')
  } else {
    const userIds = [...new Set(ru.map((r) => r.user_id).filter(Boolean))]
    const { data: users, error: uErr } = userIds.length
      ? await admin.from('users').select('id, email, full_name').in('id', userIds)
      : { data: [], error: null }
    if (uErr) console.log(`      users join FAILED: ${uErr.message} — emails unavailable`)
    const emailById = new Map((users ?? []).map((u) => [String(u.id), u]))

    console.log(`      ${ru.length} row(s):`)
    for (const r of ru) {
      const u = emailById.get(String(r.user_id))
      console.log(`        ${String(u?.email ?? '(no users row)').padEnd(42)} role=${String(r.role).padEnd(10)} created_at=${r.created_at ?? '(none)'}${r.deleted_at ? `  DELETED_AT=${r.deleted_at}` : ''}`)
      console.log(`            user_id=${r.user_id}  name=${u?.full_name ?? '(none)'}`)
    }
    const live = ru.filter((r) => !r.deleted_at).length
    console.log(`      live (deleted_at null): ${live} of ${ru.length}`)
  }

  // ------------------------------------------------------------------ staff_members
  console.log('\n  staff_members')
  const { data: sm, error: smErr } = await admin
    .from('staff_members').select('*').eq('restaurant_id', RID)
  if (smErr) {
    console.error(`      READ FAILED: ${smErr.message}`)
  } else if (!sm?.length) {
    console.log('      (no rows)')
  } else {
    console.log(`      ${sm.length} row(s):`)
    for (const m of sm) {
      console.log(`        ${pick(m, ['email', 'role', 'created_at', 'active', 'deleted_at', 'user_id', 'id'])}`)
    }
  }
}

main().catch((e) => {
  console.error('FATAL', e?.message ?? e)
  process.exit(1)
})
