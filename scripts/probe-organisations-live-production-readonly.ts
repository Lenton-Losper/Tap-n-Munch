/**
 * IS THE ORGANISATIONS LAYER ACTUALLY LIVE ON PRODUCTION?
 *
 * Three separate questions, because they have different answers and conflating them is how notes
 * end up contradicting each other:
 *
 *   1. do the TABLES exist on the production database
 *   2. has any organisation ever been CREATED
 *   3. do any restaurants carry an organisation_id
 *
 * A table existing proves a migration ran. It does not prove the feature works, and it certainly
 * does not prove anyone has used it.
 *
 * TABLE EXISTENCE IS TESTED WITH A NON-HEAD SELECT, deliberately. `{head:true, count:'exact'}`
 * returns error=null and count=NULL for a table that does not exist (#169/#290), so the idiom that
 * looks like an existence check silently reports absent tables as present. A plain select errors
 * PGRST205 instead, which is an answer.
 *
 * Production, STRICTLY READ-ONLY. Selects only. Creates nothing.
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

const CANDIDATES = [
  'organizations',
  'organisations',
  'organization_users',
  'organisation_users',
  'organization_members',
]

async function tableState(table: string) {
  // NOT head:true — see the docblock.
  const { data, error } = await admin.from(table).select('*').limit(5)
  if (error) return { exists: false, code: error.code, message: error.message, rows: 0, sample: [] }
  return { exists: true, code: null, message: null, rows: data?.length ?? 0, sample: data ?? [] }
}

async function main() {
  console.log('\nPRODUCTION — is the organisations layer live? Read-only, creates nothing.\n')

  const { data: ctl, error: ctlErr } = await admin.from('restaurants').select('id').limit(1)
  if (ctlErr) throw new Error(`control read failed: ${ctlErr.message}`)
  console.log(`  [control] restaurants readable : ${ctl?.length ? 'YES' : 'NO — nothing below means anything'}`)

  // ------------------------------------------------------------- 1. do the tables exist?
  console.log('\n  1. TABLES')
  const present: string[] = []
  for (const t of CANDIDATES) {
    const st = await tableState(t)
    if (st.exists) {
      present.push(t)
      console.log(`      ${t.padEnd(22)} EXISTS   rows in first page: ${st.rows}`)
    } else {
      console.log(`      ${t.padEnd(22)} absent   (${st.code})`)
    }
  }

  // ------------------------------------------------------------- 2. has one ever been created?
  console.log('\n  2. HAS ANY ORGANISATION EVER BEEN CREATED?')
  if (!present.length) {
    console.log('      No organisation table exists. The answer is no, and cannot be otherwise.')
  }
  for (const t of present) {
    const { count, error } = await admin.from(t).select('id', { count: 'exact', head: true })
    if (error) {
      console.log(`      ${t}: count FAILED ${error.message}`)
      continue
    }
    console.log(`      ${t.padEnd(22)} ${count} row(s)`)
    if (count && count > 0) {
      const { data } = await admin.from(t).select('*').limit(10)
      for (const row of data ?? []) console.log(`          ${JSON.stringify(row).slice(0, 220)}`)
    }
  }

  // ------------------------------------------------------------- 3. is anything WIRED to one?
  console.log('\n  3. DO ANY RESTAURANTS CARRY AN organization_id?')
  const { data: rests, error: restErr } = await admin
    .from('restaurants')
    .select('id, name, organization_id, location_type')
  if (restErr) {
    console.log(`      restaurants read FAILED: ${restErr.message}`)
    console.log('      (if the column does not exist, that is itself the answer)')
  } else {
    const withOrg = (rests ?? []).filter((r) => r.organization_id)
    console.log(`      restaurants total          : ${rests?.length ?? 0}`)
    console.log(`      with a non-null org id     : ${withOrg.length}`)
    for (const r of withOrg) console.log(`          ${r.name} -> ${r.organization_id}`)
    if (!withOrg.length) {
      console.log('      Every restaurant has organization_id NULL. Nothing is grouped today.')
    }
  }

  console.log('\n  READING THIS: a table existing means a migration ran. Zero rows means the')
  console.log('  feature has never been used, whatever the UI offers. Those are different claims')
  console.log('  and only the second one tells you whether it is safe to be first.')
}

main().catch((e) => {
  console.error('FATAL', e?.message ?? e)
  process.exit(1)
})
