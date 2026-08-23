/**
 * PRODUCTION MIGRATION LEDGER vs ACTUAL SCHEMA — STRICTLY READ-ONLY.
 *
 * The staging backlog inventory closed with: "Whether production's migration ledger matches its
 * actual schema. `76153d8` exists precisely because staging's ledger had drifted from its schema;
 * production has never had the same audit. That audit is the natural next task, and it is a
 * prerequisite for trusting any applied/not-applied answer."
 *
 * This is that audit, to the extent PostgREST permits.
 *
 * WHAT IT DOES
 *   1. Reads the ledger via `list_applied_migration_versions()` — a STABLE, SELECT-only,
 *      service_role-only function (20260714140000). No other route to supabase_migrations exists
 *      from here, and nothing here writes to it.
 *   2. Compares the ledger against the committed migration files on the current checkout.
 *   3. Parses every applied migration for the objects it claims to create, and probes production
 *      for the ones PostgREST can actually see: TABLES and COLUMNS.
 *
 * ONLY GETs, plus the one STABLE RPC. No insert, update, delete, DDL, or migration application.
 *
 * WHAT IT CANNOT ESTABLISH, stated so a green is not over-read:
 *   - INDEXES, CONSTRAINTS (incl. CHECK), RLS POLICIES, GRANTS, TRIGGERS and FUNCTION BODIES are
 *     not exposed by PostgREST. `pg_constraint` and `pg_proc` both return HTTP 404 PGRST205,
 *     measured. Every such object is reported UNVERIFIABLE, never PRESENT.
 *   - A table that exists but is not exposed to PostgREST is indistinguishable from an absent one.
 *     Both read PGRST205, and both are reported NOT_VISIBLE rather than ABSENT.
 *
 * Usage:  node scripts/audit-production-ledger-vs-schema.mjs [--json out.json]
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const ENV_PATH = 'C:/Users/223125318/Desktop/mvp/restaurant-menu-screen/.env.local'
const PROD_REF = 'ihlmmpmolnpchzgwyhgh'
const MIGRATIONS_DIR = join(process.cwd(), 'supabase', 'migrations')

const env = {}
for (const line of readFileSync(ENV_PATH, 'utf8').split(/\r?\n/)) {
  const m = /^([A-Z_0-9]+)=(.*)$/.exec(line.trim())
  if (m) env[m[1]] = m[2]
}
const URL_ = env.NEXT_PUBLIC_SUPABASE_URL
const KEY = env.SUPABASE_SERVICE_ROLE_KEY
if (!URL_ || !URL_.includes(PROD_REF)) {
  throw new Error(`REFUSING: not production — ${URL_}`)
}
if (!KEY) throw new Error('REFUSING: no service-role key')

const H = { apikey: KEY, Authorization: `Bearer ${KEY}` }

// ---------------------------------------------------------------- ledger

async function ledger() {
  const res = await fetch(`${URL_}/rest/v1/rpc/list_applied_migration_versions`, {
    method: 'POST',
    headers: { ...H, 'Content-Type': 'application/json' },
    body: '{}',
  })
  if (!res.ok) throw new Error(`ledger RPC failed: HTTP ${res.status} ${await res.text()}`)
  return (await res.json()).map((r) => String(r.version))
}

function localFiles() {
  return readdirSync(MIGRATIONS_DIR)
    .filter((n) => n.endsWith('.sql'))
    .map((name) => ({ name, version: name.match(/^(\d+)_/)?.[1] }))
    .filter((m) => m.version)
    .sort((a, b) => a.version.localeCompare(b.version))
}

// ---------------------------------------------------------------- parse

/**
 * Deliberately conservative. It claims an object only when the statement is unambiguous, because a
 * false claim here becomes a false ABSENT below — which is the failure mode this audit exists to
 * avoid, not to create.
 */
function parse(sql) {
  const s = sql.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*--.*$/gm, '')
  const tables = new Set()
  const columns = new Map() // table -> Set(col)
  const unverifiable = []

  const addCol = (t, c) => {
    if (!columns.has(t)) columns.set(t, new Set())
    columns.get(t).add(c)
  }
  // Strip quotes FIRST: a quoted identifier is "public"."orders", so an anchored /^public\./ never
  // matches it and every name stays schema-qualified — which probes as /rest/v1/public.orders and
  // comes back PGRST205, i.e. a whole schema reported NOT_VISIBLE. Then take the last dot-segment,
  // which handles public.x and a bare x alike.
  const bare = (t) => t.replace(/"/g, '').trim().split('.').pop().toLowerCase()

  for (const m of s.matchAll(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([A-Za-z0-9_."]+)/gi)) {
    tables.add(bare(m[1]))
  }
  for (const m of s.matchAll(/CREATE\s+(?:OR\s+REPLACE\s+)?VIEW\s+([A-Za-z0-9_."]+)/gi)) {
    tables.add(bare(m[1]))
  }
  // ALTER TABLE x ADD COLUMN [IF NOT EXISTS] col
  for (const m of s.matchAll(
    /ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?([A-Za-z0-9_."]+)([\s\S]*?);/gi,
  )) {
    const t = bare(m[1])
    for (const c of m[2].matchAll(/ADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?([A-Za-z0-9_"]+)/gi)) {
      addCol(t, c[1].replace(/"/g, '').toLowerCase())
    }
  }
  for (const m of s.matchAll(/CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+NOT\s+EXISTS\s+)?([A-Za-z0-9_."]+)/gi)) {
    unverifiable.push(['INDEX', m[1].replace(/"/g, '')])
  }
  for (const m of s.matchAll(/ADD\s+CONSTRAINT\s+([A-Za-z0-9_."]+)/gi)) {
    unverifiable.push(['CONSTRAINT', m[1].replace(/"/g, '')])
  }
  for (const m of s.matchAll(/CREATE\s+POLICY\s+"?([^"\n]+?)"?\s+ON\s/gi)) {
    unverifiable.push(['POLICY', m[1].trim()])
  }
  for (const m of s.matchAll(/CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+([A-Za-z0-9_."]+)/gi)) {
    unverifiable.push(['FUNCTION', m[1].replace(/"/g, '')])
  }
  for (const m of s.matchAll(/CREATE\s+(?:OR\s+REPLACE\s+)?TRIGGER\s+([A-Za-z0-9_."]+)/gi)) {
    unverifiable.push(['TRIGGER', m[1].replace(/"/g, '')])
  }
  return { tables, columns, unverifiable }
}

// ---------------------------------------------------------------- probe

const tableCache = new Map()

async function probeTable(t) {
  if (tableCache.has(t)) return tableCache.get(t)
  const res = await fetch(`${URL_}/rest/v1/${encodeURIComponent(t)}?select=*&limit=0`, { headers: H })
  let verdict
  if (res.ok) verdict = 'PRESENT'
  else {
    const body = await res.text()
    verdict = body.includes('PGRST205') ? 'NOT_VISIBLE' : `ERROR_${res.status}`
  }
  tableCache.set(t, verdict)
  return verdict
}

async function probeColumns(t, cols) {
  const list = [...cols]
  if (!list.length) return []
  // Fast path: ask for all of them at once. A 200 means every one exists.
  const all = await fetch(
    `${URL_}/rest/v1/${encodeURIComponent(t)}?select=${list.join(',')}&limit=0`,
    { headers: H },
  )
  if (all.ok) return list.map((c) => [c, 'PRESENT'])
  // Slow path: identify which ones are missing.
  const out = []
  for (const c of list) {
    const r = await fetch(`${URL_}/rest/v1/${encodeURIComponent(t)}?select=${c}&limit=0`, {
      headers: H,
    })
    if (r.ok) out.push([c, 'PRESENT'])
    else {
      const b = await r.text()
      out.push([c, b.includes('42703') || b.includes('does not exist') ? 'ABSENT' : `ERROR_${r.status}`])
    }
  }
  return out
}

// ---------------------------------------------------------------- main

async function main() {
  console.log(`PRODUCTION LEDGER vs SCHEMA — ${URL_}`)
  console.log(`migrations read from : ${MIGRATIONS_DIR}`)
  console.log(`checkout             : ${process.env.AUDIT_REF ?? '(set AUDIT_REF to record it)'}\n`)

  const applied = await ledger()
  const files = localFiles()
  const fileVersions = new Set(files.map((f) => f.version))
  const appliedSet = new Set(applied)

  console.log('== 1. LEDGER vs COMMITTED FILES ==')
  console.log(`   ledger rows          : ${applied.length}`)
  console.log(`   committed migrations : ${files.length}`)
  const inLedgerNoFile = applied.filter((v) => !fileVersions.has(v))
  const fileNotApplied = files.filter((f) => !appliedSet.has(f.version))
  console.log(`   applied with no committed file : ${inLedgerNoFile.length}`)
  for (const v of inLedgerNoFile) console.log(`       ${v}`)
  console.log(`   committed but not applied      : ${fileNotApplied.length}`)
  for (const f of fileNotApplied) console.log(`       ${f.name}`)

  console.log('\n== 2. WHAT THE APPLIED MIGRATIONS CLAIM, PROBED ==')
  const claimedTables = new Map() // table -> [versions]
  const claimedCols = new Map() // table -> Map(col -> [versions])
  let unverifiableCount = 0
  const unverifiableByKind = new Map()

  for (const f of files) {
    if (!appliedSet.has(f.version)) continue
    const p = parse(readFileSync(join(MIGRATIONS_DIR, f.name), 'utf8'))
    for (const t of p.tables) {
      if (!claimedTables.has(t)) claimedTables.set(t, [])
      claimedTables.get(t).push(f.version)
    }
    for (const [t, cols] of p.columns) {
      if (!claimedCols.has(t)) claimedCols.set(t, new Map())
      for (const c of cols) {
        const m = claimedCols.get(t)
        if (!m.has(c)) m.set(c, [])
        m.get(c).push(f.version)
      }
    }
    for (const [kind] of p.unverifiable) {
      unverifiableCount++
      unverifiableByKind.set(kind, (unverifiableByKind.get(kind) ?? 0) + 1)
    }
  }

  const allTables = new Set([...claimedTables.keys(), ...claimedCols.keys()])
  console.log(`   distinct tables/views claimed : ${allTables.size}`)
  console.log(`   distinct columns claimed      : ${[...claimedCols.values()].reduce((a, m) => a + m.size, 0)}`)
  console.log(
    `   objects PostgREST cannot see  : ${unverifiableCount}  ` +
      `(${[...unverifiableByKind].map(([k, n]) => `${k}:${n}`).join(', ')})`,
  )

  const results = { tables: [], columns: [], mismatches: [] }

  console.log('\n   -- tables/views --')
  for (const t of [...allTables].sort()) {
    const v = await probeTable(t)
    results.tables.push({ table: t, verdict: v, from: claimedTables.get(t) ?? [] })
    if (v !== 'PRESENT') {
      console.log(`   ${v.padEnd(12)} ${t}   (claimed by ${(claimedTables.get(t) ?? ['<column-only>']).join(', ')})`)
      results.mismatches.push({ kind: 'table', name: t, verdict: v })
    }
  }
  const tPresent = results.tables.filter((r) => r.verdict === 'PRESENT').length
  console.log(`   ${tPresent}/${results.tables.length} present`)

  console.log('\n   -- columns --')
  let cPresent = 0
  let cTotal = 0
  for (const [t, cols] of [...claimedCols.entries()].sort()) {
    if ((await probeTable(t)) !== 'PRESENT') {
      console.log(`   SKIPPED      ${t}.* — table not visible, columns cannot be probed`)
      continue
    }
    for (const [c, verdict] of await probeColumns(t, cols.keys())) {
      cTotal++
      if (verdict === 'PRESENT') cPresent++
      else {
        console.log(`   ${verdict.padEnd(12)} ${t}.${c}   (claimed by ${cols.get(c).join(', ')})`)
        results.mismatches.push({ kind: 'column', name: `${t}.${c}`, verdict, from: cols.get(c) })
      }
      results.columns.push({ table: t, column: c, verdict })
    }
  }
  console.log(`   ${cPresent}/${cTotal} present`)

  console.log('\n== 3. VERDICT ==')
  if (!inLedgerNoFile.length && !fileNotApplied.length) {
    console.log('   LEDGER vs FILES : MATCH — every applied version has a committed file and vice versa.')
  } else {
    console.log('   LEDGER vs FILES : DRIFT — see section 1.')
  }
  console.log(
    `   LEDGER vs SCHEMA: ${results.mismatches.length === 0 ? 'no mismatch found' : `${results.mismatches.length} mismatch(es)`} ` +
      `across ${results.tables.length} tables and ${cTotal} columns.`,
  )
  console.log(
    `   NOT ESTABLISHED : ${unverifiableCount} indexes, constraints, policies, functions and\n` +
      '                     triggers, none of which PostgREST exposes. A clean run above says\n' +
      '                     nothing about any of them.',
  )

  const jsonIdx = process.argv.indexOf('--json')
  if (jsonIdx > -1 && process.argv[jsonIdx + 1]) {
    writeFileSync(process.argv[jsonIdx + 1], JSON.stringify(results, null, 2))
    console.log(`\n   written: ${process.argv[jsonIdx + 1]}`)
  }
}

main().catch((e) => {
  console.error('AUDIT ABORTED:', e)
  process.exitCode = 2
})
