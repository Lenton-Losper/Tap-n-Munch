/**
 * #245 — do the five inline-CHECK constraints actually exist? READ ONLY, both environments.
 *
 * #212's static gate finds migrations attaching a CHECK inline to ADD COLUMN IF NOT EXISTS, where
 * the whole action is skipped if the column already existed — so the constraint is never created
 * and the migration still reports success. The gate cannot see which way it went. pg_constraint can.
 *
 * NO WRITES. The contract records restaurant_terminals_status_check as deliberately unverified
 * because probing it by INSERT would write to the table gating terminal auth on the live estate.
 * Reading the catalog does not touch a row.
 */
import { readFileSync } from 'node:fs'; import { createRequire } from 'node:module'
const require = createRequire('file:///C:/Users/223125~1/AppData/Local/Temp/claude/C--Users-223125318-Desktop-mvp/42cde80a-ddd8-4302-a2d9-e3cb8803244e/scratchpad/pgclient/')
const { Client } = require('pg')
const E='C:/Users/223125318/Desktop/mvp/restaurant-menu-screen/.env.local'
const sec=n=>{for(const l of readFileSync(E,'utf8').split(/\r?\n/)){const m=l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);if(m&&m[1]===n)return m[2].trim().replace(/^["']|["']$/g,'')}return ''}

const TARGETS = [
  ['restaurant_terminals', 'status',        '20260620150000'],
  ['staff_permissions',    'effect',        '20260628110000'],
  ['orders',               'channel',       '20260629120000'],
  ['restaurants',          'location_type', '20260719110000'],
  ['platform_ops_tickets', 'status',        '20260724180000'],
]

async function check(label, cfg) {
  const db = new Client(cfg)
  try { await db.connect() } catch (e) { console.log(`\n${label}: CANNOT CONNECT — ${e.message}`); return }
  const q = async (s,p=[]) => (await db.query(s,p)).rows
  console.log(`\n${'='.repeat(74)}\n${label}\n${'='.repeat(74)}`)
  for (const [table, col, mig] of TARGETS) {
    const exists = await q(`SELECT to_regclass($1) t`, ['public.'+table])
    if (!exists[0].t) { console.log(`  ${table}.${col}`.padEnd(44) + 'TABLE ABSENT'); continue }
    const colRow = await q(`SELECT 1 FROM information_schema.columns
       WHERE table_schema='public' AND table_name=$1 AND column_name=$2`, [table, col])
    const cons = await q(`SELECT conname, pg_get_constraintdef(oid) def FROM pg_constraint
       WHERE conrelid=$1::regclass AND contype='c' AND pg_get_constraintdef(oid) ILIKE '%'||$2||'%'`,
       ['public.'+table, col])
    const verdict = !colRow.length ? 'COLUMN ABSENT'
      : cons.length ? 'CHECK PRESENT' : '*** CHECK MISSING ***'
    console.log(`  ${(table+'.'+col).padEnd(38)} ${mig}  ${verdict}`)
    for (const c of cons) console.log(`      ${c.conname}: ${String(c.def).slice(0,84)}`)
  }
  const ctl = await q(`SELECT count(*)::int n FROM pg_constraint WHERE contype='c' AND connamespace='public'::regnamespace`)
  console.log(`  CONTROL: this database has ${ctl[0].n} CHECK constraints in public — a zero here would mean the query is wrong.`)
  await db.end()
}

await check('PRODUCTION (ihlmmpmolnpchzgwyhgh)', {
  host:'aws-0-eu-west-1.pooler.supabase.com', port:5432,
  user:'postgres.ihlmmpmolnpchzgwyhgh', password:sec('SUPABASE_DB_PASSWORD_PROD'),
  database:'postgres', ssl:{rejectUnauthorized:false},
})

await check('STAGING (mdqjpxwczrhkxkbqatqa)', {
  host:'aws-0-eu-west-1.pooler.supabase.com', port:5432,
  user:'postgres.mdqjpxwczrhkxkbqatqa', password:sec('SUPABASE_DB_PASSWORD_STAGING'),
  database:'postgres', ssl:{rejectUnauthorized:false},
})
