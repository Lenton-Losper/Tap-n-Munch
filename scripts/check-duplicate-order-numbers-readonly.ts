/**
 * READ-ONLY: are there duplicate (firebase_restaurant_id, order_number) rows in `orders`?
 *
 * There is no database unique constraint on that pair (#127) — the only unique indexes on
 * `orders` are firebase_id, idempotency_key and paycloud_merchant_order_no — and both allocation
 * sites derive the number from `SELECT count(*) + 1`, which is racy AND collides outright once a
 * row is ever deleted. This must come back clean on an environment before a unique index can be
 * added there.
 *
 * Run against either environment by pointing the env file at it. Paginates explicitly: PostgREST
 * caps at 1000 rows and a silent truncation here would under-report duplicates.
 */
import { createClient } from '@supabase/supabase-js'

const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || ''
const REFS: Record<string, string> = {
  ihlmmpmolnpchzgwyhgh: 'PRODUCTION',
  mdqjpxwczrhkxkbqatqa: 'staging',
}
const ref = url.match(/https:\/\/([a-z0-9]+)\.supabase\.co/i)?.[1] ?? ''
const env = REFS[ref]
if (!env) throw new Error(`Unrecognised project ref in SUPABASE_URL: ${ref || '(none)'}`)

const db = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY || '', {
  auth: { persistSession: false, autoRefreshToken: false },
})

type Row = {
  id: string
  firebase_restaurant_id: string | null
  order_number: number | null
  channel: string | null
  status: string | null
  payment_status: string | null
  placed_at: string | null
}

async function fetchAll(): Promise<Row[]> {
  const out: Row[] = []
  const PAGE = 1000
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await db
      .from('orders')
      .select('id, firebase_restaurant_id, order_number, channel, status, payment_status, placed_at')
      .order('id')
      .range(from, from + PAGE - 1)
    if (error) throw new Error(error.message)
    const batch = (data ?? []) as Row[]
    out.push(...batch)
    if (batch.length < PAGE) break
  }
  return out
}

async function main() {
  console.log(`=== duplicate order_number check — ${env} (${ref}) — READ-ONLY ===\n`)

  const rows = await fetchAll()
  console.log(
    `Scanned ${rows.length} orders row(s) across ` +
      `${new Set(rows.map((r) => r.firebase_restaurant_id)).size} firebase_restaurant_id value(s).`,
  )

  const nullScope = rows.filter((r) => r.firebase_restaurant_id == null)
  const nullNumber = rows.filter((r) => r.order_number == null)
  if (nullScope.length > 0) {
    console.log(`\nNOTE: ${nullScope.length} row(s) have a NULL firebase_restaurant_id.`)
  }
  if (nullNumber.length > 0) {
    console.log(`NOTE: ${nullNumber.length} row(s) have a NULL order_number.`)
  }

  const groups = new Map<string, Row[]>()
  for (const r of rows) {
    if (r.firebase_restaurant_id == null || r.order_number == null) continue
    const key = `${r.firebase_restaurant_id}|${r.order_number}`
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key)!.push(r)
  }

  const dupes = [...groups.entries()].filter(([, v]) => v.length > 1)
  const dupeRows = dupes.reduce((n, [, v]) => n + v.length, 0)

  // Per-restaurant high-water marks: what a max()+1 allocator would hand out next, and how far
  // count(*)+1 currently is from it. A gap means count(*)+1 is already re-issuing used numbers.
  const perScope = new Map<string, { count: number; max: number }>()
  for (const r of rows) {
    if (r.firebase_restaurant_id == null) continue
    const cur = perScope.get(r.firebase_restaurant_id) ?? { count: 0, max: 0 }
    cur.count += 1
    if (r.order_number != null && r.order_number > cur.max) cur.max = r.order_number
    perScope.set(r.firebase_restaurant_id, cur)
  }
  console.log('\nPer-restaurant allocation state (count+1 = what the code issues now, max+1 = safe next):')
  for (const [scope, v] of [...perScope.entries()].sort()) {
    const flag = v.count + 1 <= v.max ? '  <-- count(*)+1 REISSUES AN EXISTING NUMBER' : ''
    console.log(`  ${scope}: rows=${v.count} max=${v.max} count+1=${v.count + 1} max+1=${v.max + 1}${flag}`)
  }

  if (dupes.length === 0) {
    console.log(
      `\nRESULT: NO DUPLICATES on ${env}. A unique index on (firebase_restaurant_id, order_number) ` +
        `would apply cleanly here.`,
    )
    return
  }

  // Non-zero so an apply script can gate on this rather than on a human reading the output.
  process.exitCode = 1
  console.log(`\nRESULT: ${dupes.length} DUPLICATED (firebase_restaurant_id, order_number) PAIR(S) on ${env}, ${dupeRows} row(s) involved.`)
  console.log('A unique index would FAIL to create until these are resolved.\n')
  for (const [key, list] of dupes) {
    const [scope, num] = key.split('|')
    console.log(`  ${scope} — order_number ${num}: ${list.length} rows`)
    for (const r of list) {
      console.log(
        `     id=${r.id} channel=${String(r.channel)} status=${String(r.status)} ` +
          `payment=${String(r.payment_status)} placed=${String(r.placed_at)}`,
      )
    }
  }
}

main().catch((e) => { console.error('THREW:', e?.message ?? e); process.exit(1) })
