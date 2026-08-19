/**
 * DEPLOY 1's REDACTION, RE-VERIFIED AGAINST THE LIVE PRODUCTION WORKER. Read-only.
 *
 * Standing rule: re-verify this after every production deploy. #262's seam is
 * GET /api/tabs/[tabId]/view -- deliberately unauthenticated, so it is the one route where a
 * regression leaks other diners' session_id to anyone holding a tab id.
 *
 * WHY THIS IS NOT A curl FOR A 4xx. Hitting the route with a bogus tab id and observing "no
 * session_id in the body" proves nothing: a 400 has no body to leak, a dead route 404s, and a
 * worker that failed to boot 500s -- all three look identical to "correctly redacting". That is
 * the closed-versus-dead confusion the standing rule exists to prevent.
 *
 * SO THE CHECK IS TWO-SIDED:
 *   POSITIVE CONTROL  a REAL tab id + restaurantId must return 200 with a populated members array.
 *                     If that fails, the redaction result is VOID and this exits non-zero -- we
 *                     have measured nothing, not measured safety.
 *   THE ASSERTION     that same successful body must contain no `session_id` in any shape.
 *
 * Reads production Supabase to find a real tab (select only), then talks to the deployed worker
 * over HTTP. Writes nothing anywhere.
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

const HOSTS = ['https://flashtap.app', 'https://riviera.flashtap.app']

async function main() {
  console.log('\nDEPLOY 1 REDACTION — live production worker, with a positive control.\n')

  // ---- find a real tab the route will actually SERVE
  //
  // Three conditions, and the first two were each learned by a void run rather than reasoned:
  //
  //   `members` IS A JSONB COLUMN ON `tabs`, not a table. The first version counted rows in a
  //   `tab_members` table that does not exist, and PostgREST answers {head:true,count:'exact'} on a
  //   missing table with count=null and error=null (#169/#290) -- so it found zero members on every
  //   tab and never errored.
  //
  //   THE TAB MUST STILL BE THE TABLE'S CURRENT SESSION. The route refuses with 410 when
  //   tabs.session_version != restaurant_tables.current_session_version (the session boundary that
  //   stops a phone reading the previous party's figures). Almost every historical tab is stale, so
  //   "newest with members" picked one the route is correct to refuse.
  //
  //   AND IT MUST HAVE MEMBERS, or there is nothing to redact and the assertion is vacuous.
  const { data: tabs, error: tabErr } = await admin
    .from('tabs')
    .select('id, restaurant_id, table_id, session_version, members, created_at')
    .order('created_at', { ascending: false })
    .limit(400)
  if (tabErr) throw new Error(`tabs read failed: ${tabErr.message}`)
  if (!tabs?.length) throw new Error('no tabs on production — cannot build a positive control')

  const withMembers = tabs.filter((t) => Array.isArray(t.members) && t.members.length > 0)

  const { data: tables, error: tblErr } = await admin
    .from('restaurant_tables')
    .select('id, current_session_version')
  if (tblErr) throw new Error(`restaurant_tables read failed: ${tblErr.message}`)
  const currentVersionOf = new Map((tables ?? []).map((t) => [String(t.id), Number(t.current_session_version)]))

  const subject = withMembers.find((t) => {
    const tableId = String(t.table_id ?? '').trim()
    if (!tableId) return true // a tab with no table cannot have been reset by a table close
    return currentVersionOf.get(tableId) === Number(t.session_version)
  })

  if (!subject) {
    // NOT the same as a pass, and not the same as a leak. Say which.
    console.error(
      `
  NOT RUNNABLE — of the newest ${tabs.length} tabs, ${withMembers.length} have members and none is
` +
        '  still its table's current session. The route would correctly 410 every one of them, so there
' +
        '  is no body to inspect. This is a check that did not run; it is not evidence of safety.',
    )
    process.exit(2)
  }
  console.log(
    `  subject tab ${subject.id}  restaurant ${subject.restaurant_id}  members ${subject.members.length}  session_version ${subject.session_version}`,
  )

  let failed = false
  for (const host of HOSTS) {
    const target = `${host}/api/tabs/${subject.id}/view?restaurantId=${subject.restaurant_id}&cb=${subject.id.slice(0, 8)}`
    const res = await fetch(target, { headers: { 'cache-control': 'no-cache' } })
    const text = await res.text()

    let body = null
    try {
      body = JSON.parse(text)
    } catch {
      /* left null — reported below */
    }
    // The route answers `{ tab: { ..., members: [...] } }` -- its own docblock says so. Accepting
    // a top-level `members` too, so a shape change surfaces as a redaction result rather than as
    // a void control that reads like an outage.
    const raw = body?.tab?.members ?? body?.members
    const members = Array.isArray(raw) ? raw : null

    // ---- POSITIVE CONTROL first. Without it, "no session_id" is not a finding.
    const controlPassed = res.status === 200 && !!members && members.length > 0
    console.log(`\n  ${host}`)
    console.log(`      http                 ${res.status}`)
    console.log(`      members returned     ${members ? members.length : '(none / not an array)'}`)
    console.log(`      POSITIVE CONTROL     ${controlPassed ? 'PASS — the route is alive and answering' : 'FAIL — result is VOID'}`)
    if (!controlPassed) {
      console.log(`      body: ${text.slice(0, 220)}`)
      failed = true
      continue
    }

    // ---- the assertion, on a body we have proven is real
    const leaked = /session_id|sessionId/.test(text)
    console.log(`      session_id present   ${leaked ? 'YES *** LEAK ***' : 'no'}`)
    console.log(`      member keys          ${JSON.stringify(Object.keys(members[0] ?? {}))}`)
    if (leaked) failed = true
  }

  if (failed) {
    console.error('\n  REDACTION CHECK FAILED OR WAS VOID. Treat this as a blocked deploy.')
    process.exit(1)
  }
  console.log('\n  Redaction intact on every production hostname, proven against a live 200.')
}

main().catch((e) => {
  console.error('FATAL', e?.message ?? e)
  process.exit(1)
})
