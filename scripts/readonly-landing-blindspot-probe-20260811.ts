/**
 * READ ONLY. Proves the first half of the Create-Tab PIN bypass without writing anything.
 *
 * Claim under test: at a table whose tab is older than 12 hours, the QR landing does not see the
 * tab and therefore renders "Create Tab" instead of "Join Tab".
 *
 * Method: run the landing's OWN query, with the same ANON key the browser uses
 * (app/menu/[restaurantId]/v2/page.tsx:424-442), against a table that a service-role read shows
 * has an open tab. Two clients, one table, opposite answers.
 *
 * STAGING ONLY, allowlisted before any client is constructed. Every call is a .select().
 */
import { config } from 'dotenv'
import { createClient } from '@supabase/supabase-js'

const WORKTREE = 'C:/Users/223125318/Desktop/mvp/sp-qr-state'
config({ path: `${WORKTREE}/.env.test`, override: true })

const STAGING_REF = 'mdqjpxwczrhkxkbqatqa'
const PRODUCTION_REF = 'ihlmmpmolnpchzgwyhgh'

const url = String(process.env.SUPABASE_URL || '').trim()
const serviceKey = String(process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim()
const anonKey = String(process.env.SUPABASE_ANON_KEY || '').trim()
const ref = (url.match(/^https:\/\/([a-z0-9]+)\.supabase\.co/i) || [])[1] || ''

if (!ref) throw new Error(`Could not parse a project ref from SUPABASE_URL (${url || 'unset'})`)
if (ref === PRODUCTION_REF) throw new Error(`REFUSING: SUPABASE_URL points at PRODUCTION (${ref})`)
if (ref !== STAGING_REF) throw new Error(`REFUSING: ref ${ref} is not the allowlisted staging ref ${STAGING_REF}`)
if (!serviceKey || !anonKey) throw new Error('SUPABASE_SERVICE_ROLE_KEY or SUPABASE_ANON_KEY is unset')

console.log(`[guard] ok — staging ref ${ref} (READ ONLY)`)

const admin = createClient(url, serviceKey, { auth: { persistSession: false } })
const anon = createClient(url, anonKey, { auth: { persistSession: false } })

// app/menu/[restaurantId]/v2/page.tsx -- ACTIVE_TAB_STATUSES and the 12h cutoff at :426
const ACTIVE_TAB_STATUSES = ['open', 'ready_to_pay'] as const
const CUTOFF_MS = 12 * 60 * 60 * 1000

async function main() {
  const { data: openTabs, error } = await admin
    .from('tabs')
    .select('id, restaurant_id, table_id, table_number, created_at, pin_required, tab_pin, total')
    .eq('status', 'open')
    .order('created_at', { ascending: true })
  if (error) throw error

  const now = Date.now()
  const stale = (openTabs ?? []).filter((t) => now - new Date(String(t.created_at)).getTime() > CUTOFF_MS)
  if (stale.length === 0) {
    console.log('\nNo open tab older than 12h exists on staging. Nothing to probe; not creating one.')
    return
  }

  const subject = stale[0]
  const ageH = (now - new Date(String(subject.created_at)).getTime()) / 36e5

  console.log(`\nSUBJECT (service-role read — the truth):`)
  console.log(`  tab ${subject.id}`)
  console.log(`  table_number=${subject.table_number}  age=${ageH.toFixed(1)}h  status=open`)
  console.log(`  pin_required=${subject.pin_required}  tab_pin set=${Boolean(subject.tab_pin)}  total=${subject.total}`)

  // The landing's query, verbatim in shape, through the browser's anon client.
  const cutoffIso = new Date(now - CUTOFF_MS).toISOString()
  let landingQuery = anon
    .from('tabs')
    .select('id, table_number, status, total, pin_required, created_at')
    .eq('restaurant_id', subject.restaurant_id)
    .in('status', [...ACTIVE_TAB_STATUSES])
    .gte('created_at', cutoffIso)
  landingQuery = subject.table_id
    ? landingQuery.eq('table_id', subject.table_id)
    : landingQuery.eq('table_number', subject.table_number)

  const { data: landingSees, error: landingErr } = await landingQuery.limit(1)
  if (landingErr) throw landingErr

  // Same anon query WITHOUT the cutoff, to show the anon client is not the limiting factor.
  let noCutoff = anon
    .from('tabs')
    .select('id, table_number, status, total, pin_required, created_at')
    .eq('restaurant_id', subject.restaurant_id)
    .in('status', [...ACTIVE_TAB_STATUSES])
  noCutoff = subject.table_id
    ? noCutoff.eq('table_id', subject.table_id)
    : noCutoff.eq('table_number', subject.table_number)
  const { data: anonWithoutCutoff, error: noCutoffErr } = await noCutoff.limit(1)
  if (noCutoffErr) throw noCutoffErr

  console.log(`\nLANDING'S OWN QUERY (anon key, 12h cutoff at ${cutoffIso}):`)
  console.log(`  rows returned: ${(landingSees ?? []).length}  -> openTab = ${(landingSees ?? []).length ? 'set' : 'null'}`)
  console.log(`  so the landing renders: ${(landingSees ?? []).length ? '"A tab is already open for this table" / Join Tab' : '"Create Tab"'}`)

  console.log(`\nSAME ANON QUERY WITHOUT THE CUTOFF (control):`)
  console.log(`  rows returned: ${(anonWithoutCutoff ?? []).length}  -> anon CAN read this tab; the cutoff is what hides it`)

  // Can anon read the PIN itself? Column grants should refuse.
  const { data: pinProbe, error: pinErr } = await anon.from('tabs').select('id, tab_pin').eq('id', subject.id).limit(1)
  console.log(`\nANON PIN READ (column-grant control):`)
  console.log(pinErr ? `  refused: ${pinErr.message}` : `  RETURNED: ${JSON.stringify(pinProbe)}`)
}

main().catch((e) => {
  console.error('FAILED:', e)
  process.exit(1)
})
