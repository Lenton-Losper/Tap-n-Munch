/**
 * READ-ONLY: are there duplicate (restaurant_id, table_number) rows in restaurant_tables?
 *
 * There is no database unique constraint on that pair — the only constraint is the primary key
 * on `id` — so duplicates are possible and QR links resolve by number. This must come back clean
 * on an environment before a unique index can be added there.
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

type Row = { id: string; restaurant_id: string; table_number: number | null; table_name: string | null; active: boolean | null; is_kiosk: boolean | null; is_view_only: boolean | null }

async function fetchAll(): Promise<Row[]> {
  const out: Row[] = []
  const PAGE = 1000
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await db
      .from('restaurant_tables')
      .select('id, restaurant_id, table_number, table_name, active, is_kiosk, is_view_only')
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
  console.log(`=== duplicate table_number check — ${env} (${ref}) — READ-ONLY ===\n`)

  const rows = await fetchAll()
  const { data: rests } = await db.from('restaurants').select('id, name')
  const rname = new Map((rests ?? []).map((r) => [String(r.id), String(r.name)]))

  console.log(`Scanned ${rows.length} restaurant_tables row(s) across ${new Set(rows.map((r) => r.restaurant_id)).size} restaurant(s).`)

  const groups = new Map<string, Row[]>()
  for (const r of rows) {
    if (r.table_number == null) continue
    const key = `${r.restaurant_id}|${r.table_number}`
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key)!.push(r)
  }

  const dupes = [...groups.entries()].filter(([, v]) => v.length > 1)

  const nullNumbers = rows.filter((r) => r.table_number == null)
  if (nullNumbers.length > 0) {
    console.log(`\nNOTE: ${nullNumbers.length} row(s) have a NULL table_number (excluded from the pair check).`)
  }

  if (dupes.length === 0) {
    console.log(`\nRESULT: NO DUPLICATES on ${env}. A unique index on (restaurant_id, table_number) would apply cleanly here.`)
    return
  }

  console.log(`\nRESULT: ${dupes.length} DUPLICATED (restaurant_id, table_number) PAIR(S) on ${env}.`)
  console.log('A unique index would FAIL to create until these are resolved.\n')
  for (const [key, list] of dupes) {
    const [rid, num] = key.split('|')
    console.log(`  ${rname.get(rid) ?? rid} — table_number ${num}: ${list.length} rows`)
    for (const r of list) {
      console.log(
        `     id=${r.id} name=${String(r.table_name ?? '(null)')} active=${r.active} kiosk=${r.is_kiosk} view_only=${r.is_view_only}`,
      )
    }
  }
}

main().catch((e) => { console.error('THREW:', e?.message ?? e); process.exit(1) })
