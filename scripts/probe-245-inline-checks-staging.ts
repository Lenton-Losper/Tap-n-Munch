/**
 * #245 — do the five inline-CHECK constraints actually EXIST?
 *
 * #212's static gate finds five migrations attaching a CHECK inline to `ADD COLUMN IF NOT EXISTS`.
 * When the column already exists the whole action is skipped, constraint and all, and the
 * migration still reports success. So the gate proves the SHAPE is dangerous and says nothing
 * about whether any given constraint is present.
 *
 * THE ISSUE ASSUMES `pg_constraint` IS READABLE. That assumption is tested first rather than
 * relied on — `pg_proc` is NOT readable through PostgREST in this project, and if the catalogue is
 * closed here too then the read-only route the issue proposes does not exist and the answer has to
 * come from behaviour.
 *
 * BEHAVIOURAL FALLBACK, STAGING ONLY. Attempt to write a value the CHECK should reject:
 *
 *   rejected (23514)  -> the constraint is PRESENT
 *   accepted          -> it is ABSENT, and the row is deleted again immediately
 *
 * A control writes a VALID value first. Without it, "rejected" cannot be told apart from "the
 * insert was refused for some unrelated reason" — a NOT NULL, an FK, RLS.
 *
 * THIS PROBE IS DELIBERATELY STAGING-ONLY. The production half of the same question is exactly
 * what agent-operating-contracts records as deliberately unverified, because answering it
 * behaviourally means writing to the table that gates terminal auth on the live estate. Nothing
 * here is safe to point at production, and it refuses to.
 */
// @ts-nocheck
import { createClient } from '@supabase/supabase-js'
import { randomUUID } from 'crypto'

const STAGING_REF = 'mdqjpxwczrhkxkbqatqa'
const url = process.env.SUPABASE_URL || ''
const key = process.env.SUPABASE_SERVICE_ROLE_KEY || ''
if (!url.includes(STAGING_REF)) throw new Error(`GUARD: ${url || '(unset)'} is not staging`)
const admin = createClient(url, key, { auth: { persistSession: false } })

const RID = 'a1999166-ddfa-40d1-ad1f-2f01282a1652'

async function catalogueReadable(): Promise<boolean> {
  const { error } = await admin.from('pg_constraint').select('conname').limit(1)
  if (!error) return true
  console.log(`  pg_constraint via PostgREST: NOT readable (${error.code ?? error.message})`)
  return false
}

type Case = {
  migration: string
  table: string
  column: string
  valid: string
  invalid: string
  /** Extra columns the row needs to satisfy NOT NULLs and FKs. */
  base: Record<string, unknown>
}

const CASES: Case[] = [
  {
    migration: '20260620150000',
    table: 'restaurant_terminals',
    column: 'status',
    valid: 'active',
    invalid: `bogus_${randomUUID().slice(0, 6)}`,
    base: { restaurant_id: RID, device_id: `probe245-${randomUUID().slice(0, 8)}`, name: 'probe245' },
  },
  {
    migration: '20260629120000',
    table: 'orders',
    column: 'channel',
    valid: 'table',
    invalid: `bogus_${randomUUID().slice(0, 6)}`,
    base: {
      restaurant_id: RID, table_number: 0, status: 'pending', payment_status: 'pending',
      items: [], subtotal: 0, tax: 0, total: 0, placed_at: new Date().toISOString(),
    },
  },
  {
    migration: '20260719110000',
    table: 'restaurants',
    column: 'location_type',
    valid: 'RETAIL',
    invalid: `bogus_${randomUUID().slice(0, 6)}`,
    base: { name: `probe245-${randomUUID().slice(0, 6)}` },
  },
]

async function tryInsert(c: Case, value: string) {
  const row = { ...c.base, [c.column]: value }
  const { data, error } = await admin.from(c.table).insert(row).select('id').maybeSingle()
  if (data?.id) await admin.from(c.table).delete().eq('id', data.id)
  return { ok: !error, code: error?.code ?? null, message: error?.message ?? null }
}

async function main() {
  console.log('\nSTAGING — #245: are the five inline CHECKs actually present?\n')

  const readable = await catalogueReadable()
  if (readable) {
    console.log('  pg_constraint IS readable — the read-only route the issue proposes exists.')
    console.log('  (Behavioural probing below is then unnecessary for staging AND usable on production.)')
  }

  console.log('\n  BEHAVIOURAL RESULTS (staging only):')
  for (const c of CASES) {
    const control = await tryInsert(c, c.valid)
    if (!control.ok) {
      console.log(
        `  ${c.table}.${c.column.padEnd(14)} INCONCLUSIVE — the CONTROL insert failed ` +
          `(${control.code}: ${String(control.message).slice(0, 70)}). Cannot tell a CHECK from an unrelated refusal.`,
      )
      continue
    }
    const bad = await tryInsert(c, c.invalid)
    const present = !bad.ok && bad.code === '23514'
    console.log(
      `  ${c.table}.${c.column.padEnd(14)} ${present ? 'CONSTRAINT PRESENT' : bad.ok ? '*** ABSENT — invalid value ACCEPTED ***' : `refused, but not by a CHECK (${bad.code})`}`,
    )
  }

  console.log('\n  NOT COVERED HERE: staff_permissions.effect (20260628110000) and')
  console.log('  platform_ops_tickets.status (20260724180000) — both need a valid parent row this')
  console.log('  probe would have to create, and inventing rows in a permissions table to test a')
  console.log('  constraint is a worse idea than leaving two of five unmeasured. Stated, not hidden.')
  console.log('\n  PRODUCTION IS NOT ANSWERED BY THIS RUN, deliberately. Answering it behaviourally')
  console.log('  means writing to the table that gates terminal auth on the live estate.')
}

main().catch((e) => { console.error('FATAL', e?.message ?? e); process.exit(1) })
