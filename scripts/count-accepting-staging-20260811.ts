/**
 * #215 measurement — READ ONLY. Counts order_requests rows stuck in 'accepting'.
 *
 * STAGING ONLY. The ref is allowlisted and production is denied by name BEFORE any
 * client is constructed, so a mis-set env aborts rather than connecting.
 * No insert, update, delete or RPC is performed anywhere in this file.
 */
import { config } from 'dotenv'
import { createClient } from '@supabase/supabase-js'

const WORKTREE = 'C:/Users/223125318/Desktop/mvp/sp-qr-state'
config({ path: `${WORKTREE}/.env.test`, override: true })

const STAGING_REF = 'mdqjpxwczrhkxkbqatqa'
const PRODUCTION_REF = 'ihlmmpmolnpchzgwyhgh'

const url = String(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '').trim()
const key = String(process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim()

const ref = (url.match(/^https:\/\/([a-z0-9]+)\.supabase\.co/i) || [])[1] || ''

if (!ref) throw new Error(`Could not parse a project ref from SUPABASE_URL (${url || 'unset'})`)
if (ref === PRODUCTION_REF) throw new Error(`REFUSING: SUPABASE_URL points at PRODUCTION (${ref})`)
if (ref !== STAGING_REF) throw new Error(`REFUSING: ref ${ref} is not the allowlisted staging ref ${STAGING_REF}`)
if (!key) throw new Error('SUPABASE_SERVICE_ROLE_KEY is unset')

console.log(`[guard] ok — staging ref ${ref}`)

const supabase = createClient(url, key, { auth: { persistSession: false } })

async function main() {
  const { data, error } = await supabase
    .from('order_requests')
    .select('id, restaurant_id, table_number, channel, status, placed_at, decided_at, accepted_order_id, idempotency_key')
    .eq('status', 'accepting')
    .order('placed_at', { ascending: true })

  if (error) throw error

  const rows = data ?? []
  console.log(`\nRESULT: ${rows.length} row(s) with status='accepting' on staging\n`)

  for (const r of rows) {
    const ageH = (Date.now() - new Date(String(r.placed_at)).getTime()) / 36e5
    console.log(
      `  ${r.id}  placed_at=${r.placed_at}  age=${ageH.toFixed(1)}h  table=${r.table_number}  channel=${r.channel}  idem=${r.idempotency_key ?? 'null'}  accepted_order_id=${r.accepted_order_id ?? 'null'}`,
    )
  }

  // Context: the whole-table status distribution, so a zero can be read against a populated table.
  const { data: all, error: allErr } = await supabase
    .from('order_requests')
    .select('status, placed_at')
  if (allErr) throw allErr

  const byStatus = new Map<string, number>()
  for (const r of all ?? []) byStatus.set(String(r.status), (byStatus.get(String(r.status)) ?? 0) + 1)
  console.log(`\nWhole-table distribution (${(all ?? []).length} rows):`)
  for (const [s, n] of [...byStatus].sort((a, b) => b[1] - a[1])) console.log(`  ${s}: ${n}`)
}

main().catch((e) => {
  console.error('FAILED:', e)
  process.exit(1)
})
