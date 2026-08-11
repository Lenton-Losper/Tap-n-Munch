/**
 * READ ONLY audit for the Create-Tab PIN bypass and #215's population.
 *
 * Every database call in this file is a `.select()`. There is no insert, update, delete, upsert
 * or rpc anywhere in it, and none may be added -- it is pointed at PRODUCTION deliberately.
 *
 * Target is chosen by argv and allowlisted by project ref BEFORE any client is constructed:
 *   npx tsx scripts/readonly-pin-and-accepting-audit-20260811.ts staging
 *   npx tsx scripts/readonly-pin-and-accepting-audit-20260811.ts production
 *
 * Answers, per target:
 *   1. #215 -- how many order_requests rows are stuck in 'accepting', all-time.
 *   2. PIN bypass -- which restaurants require a tab PIN at all (tab_pin_required), so we know
 *      for whom the bypass is moot.
 *   3. PIN bypass reachability -- open tabs older than the QR landing's 12-hour lookup window
 *      (app/menu/[restaurantId]/v2/page.tsx:426), which is the window that makes a normal
 *      customer fall into it by accident.
 */
import { config } from 'dotenv'
import { createClient } from '@supabase/supabase-js'

const WORKTREE = 'C:/Users/223125318/Desktop/mvp/sp-qr-state'

const TARGETS = {
  staging: { ref: 'mdqjpxwczrhkxkbqatqa', envFile: '.env.test', urlVar: 'SUPABASE_URL' },
  production: { ref: 'ihlmmpmolnpchzgwyhgh', envFile: '.env.local', urlVar: 'NEXT_PUBLIC_SUPABASE_URL' },
} as const

const targetName = String(process.argv[2] || '').trim() as keyof typeof TARGETS
if (!(targetName in TARGETS)) {
  throw new Error(`REFUSING: target must be one of ${Object.keys(TARGETS).join(' | ')}, got "${process.argv[2] ?? ''}"`)
}
const target = TARGETS[targetName]

config({ path: `${WORKTREE}/${target.envFile}`, override: true })

const url = String(process.env[target.urlVar] || '').trim()
const key = String(process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim()
const ref = (url.match(/^https:\/\/([a-z0-9]+)\.supabase\.co/i) || [])[1] || ''

if (!ref) throw new Error(`Could not parse a project ref from ${target.urlVar} (${url || 'unset'})`)
if (ref !== target.ref) {
  throw new Error(`REFUSING: ${target.envFile} resolved to ref ${ref}, which is not the allowlisted ${targetName} ref ${target.ref}`)
}
if (!key) throw new Error('SUPABASE_SERVICE_ROLE_KEY is unset')

console.log(`[guard] ok — target=${targetName} ref=${ref} (READ ONLY)`)

const supabase = createClient(url, key, { auth: { persistSession: false } })

const TWELVE_HOURS_MS = 12 * 60 * 60 * 1000

async function main() {
  // ---- 1. #215: order_requests stuck in 'accepting' -------------------------------------
  const { data: accepting, error: acceptingErr } = await supabase
    .from('order_requests')
    .select('id, restaurant_id, table_number, channel, placed_at, idempotency_key')
    .eq('status', 'accepting')
    .order('placed_at', { ascending: true })
  if (acceptingErr) throw acceptingErr

  console.log(`\n=== #215 — order_requests in 'accepting' ===`)
  console.log(`RESULT: ${(accepting ?? []).length}`)
  for (const r of accepting ?? []) {
    const ageH = (Date.now() - new Date(String(r.placed_at)).getTime()) / 36e5
    console.log(`  ${r.id}  placed_at=${r.placed_at}  age=${ageH.toFixed(1)}h  table=${r.table_number}  channel=${r.channel}`)
  }

  const { data: allRequests, error: allReqErr } = await supabase.from('order_requests').select('status')
  if (allReqErr) throw allReqErr
  const reqByStatus = new Map<string, number>()
  for (const r of allRequests ?? []) reqByStatus.set(String(r.status), (reqByStatus.get(String(r.status)) ?? 0) + 1)
  console.log(`  denominator: ${(allRequests ?? []).length} rows total — ${[...reqByStatus].map(([s, n]) => `${s}:${n}`).join(', ') || 'none'}`)

  // ---- 2. PIN bypass: who requires a tab PIN at all -------------------------------------
  const { data: restaurants, error: restErr } = await supabase.from('restaurants').select('id, name')
  if (restErr) throw restErr
  const nameById = new Map((restaurants ?? []).map((r) => [String(r.id), String(r.name)]))

  const { data: settings, error: settingsErr } = await supabase
    .from('restaurant_settings')
    .select('restaurant_id, tab_pin_required')
  if (settingsErr) throw settingsErr

  console.log(`\n=== PIN policy — restaurant_settings.tab_pin_required ===`)
  console.log(`(route reads it as \`settingsRow?.tab_pin_required !== false\`, so NULL / no row => PIN REQUIRED)`)
  const settingByRestaurant = new Map((settings ?? []).map((s) => [String(s.restaurant_id), s.tab_pin_required]))
  for (const [id, name] of nameById) {
    const raw = settingByRestaurant.has(id) ? settingByRestaurant.get(id) : '<no settings row>'
    const effective = raw === false ? 'PIN NOT required' : 'PIN REQUIRED'
    console.log(`  ${name.padEnd(28)} tab_pin_required=${String(raw).padEnd(16)} -> ${effective}`)
  }

  // ---- 3. PIN bypass reachability: open tabs, and how old they are ----------------------
  const { data: openTabs, error: tabsErr } = await supabase
    .from('tabs')
    .select('id, restaurant_id, table_number, status, total, created_at, pin_required, settled_at')
    .eq('status', 'open')
    .order('created_at', { ascending: true })
  if (tabsErr) throw tabsErr

  const now = Date.now()
  const stale = (openTabs ?? []).filter((t) => now - new Date(String(t.created_at)).getTime() > TWELVE_HOURS_MS)

  console.log(`\n=== Open tabs (status='open') ===`)
  console.log(`  total open: ${(openTabs ?? []).length}`)
  console.log(`  with pin_required=true: ${(openTabs ?? []).filter((t) => t.pin_required !== false).length}`)
  console.log(`  OLDER THAN THE 12h LANDING WINDOW: ${stale.length}   <-- accidental-path reproduction candidates`)
  for (const t of stale) {
    const ageH = (now - new Date(String(t.created_at)).getTime()) / 36e5
    console.log(
      `    ${t.id}  ${nameById.get(String(t.restaurant_id)) ?? t.restaurant_id}  table=${t.table_number}  age=${ageH.toFixed(1)}h  total=${t.total}  pin_required=${t.pin_required}  settled_at=${t.settled_at ?? 'null'}`,
    )
  }
}

main().catch((e) => {
  console.error('FAILED:', e)
  process.exit(1)
})
