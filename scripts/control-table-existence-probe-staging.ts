/**
 * Issue #169 — LIVE CONTROL for the table-existence probe. READ-ONLY. Performs no writes.
 *
 *   npx tsx scripts/control-table-existence-probe-staging.ts
 *
 * Runs BOTH idioms against BOTH arms of the control on a real database:
 *
 *   broken  = .select('*', { head: true, count: 'exact' })
 *   correct = .select('*', { count: 'exact' }).limit(1)     (lib/supabase/table-exists.ts)
 *
 *   present arm = a table that certainly exists
 *   absent  arm = a randomised name no schema will ever contain
 *
 * The point is not to show the correct idiom works. It is to show the broken one does NOT — a
 * probe pointed only at things that exist has been confirmed, not tested. This script fails
 * loudly if the broken idiom ever starts discriminating, because then the premise of #169 has
 * changed on this project and the guidance would need revisiting rather than quietly rotting.
 *
 * Staging only (mdqjpxwczrhkxkbqatqa). It refuses to run against production.
 */
import { createClient } from '@supabase/supabase-js'
import { config } from 'dotenv'
import {
  absentControlName,
  calibrateTableProbe,
  probeTable,
  type ProbeableClient,
} from '../lib/supabase/table-exists'

config({ path: '.env.test', override: true })

const STAGING_REF = 'mdqjpxwczrhkxkbqatqa'
const PRODUCTION_REF = 'ihlmmpmolnpchzgwyhgh'
/** A table that certainly exists on staging; the positive arm of every control below. */
const PRESENT_TABLE = 'orders'

const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || ''
if (url.includes(PRODUCTION_REF)) throw new Error('REFUSING: this control is staging-only, got production')
if (!url.includes(STAGING_REF)) throw new Error(`REFUSING: expected staging ref ${STAGING_REF}, got ${url}`)

const db = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY || '', {
  auth: { persistSession: false, autoRefreshToken: false },
})

/** The defective idiom, reproduced verbatim so the comparison is like-for-like. */
async function brokenProbe(table: string) {
  const { error, count } = await db.from(table).select('*', { head: true, count: 'exact' })
  return { code: error?.code ?? 'ok', msg: (error?.message ?? '').slice(0, 70), count: count ?? null }
}

function line(label: string, r: { code: string; msg?: string; count?: number | null }) {
  const count = r.count === null || r.count === undefined ? '-' : String(r.count)
  console.log(`  ${label.padEnd(34)} code=${(r.code ?? 'ok').padEnd(9)} count=${count.padEnd(8)} ${r.msg ?? ''}`)
}

async function main() {
  const absentName = absentControlName()
  console.log(`Target: staging ${STAGING_REF} (read-only)`)
  console.log(`Present arm: '${PRESENT_TABLE}'   Absent arm: '${absentName}'\n`)

  console.log("BROKEN idiom  .select('*', { head: true, count: 'exact' })")
  const bPresent = await brokenProbe(PRESENT_TABLE)
  const bAbsent = await brokenProbe(absentName)
  line('present table', bPresent)
  line('ABSENT table', bAbsent)
  const brokenDiscriminates = bAbsent.code !== 'ok'
  console.log(`  -> discriminates? ${brokenDiscriminates ? 'YES' : 'NO — absent reads exactly like present'}\n`)

  console.log("CORRECT idiom .select('*', { count: 'exact' }).limit(1)")
  const cPresent = await probeTable(db as unknown as ProbeableClient, PRESENT_TABLE)
  const cAbsent = await probeTable(db as unknown as ProbeableClient, absentName)
  line('present table', { code: cPresent.code, msg: cPresent.message.slice(0, 70), count: cPresent.count })
  line('ABSENT table', { code: cAbsent.code, msg: cAbsent.message.slice(0, 70), count: cAbsent.count })
  console.log(`  -> exists flags: present=${cPresent.exists} absent=${cAbsent.exists}`)
  const correctDiscriminates = cPresent.exists && !cAbsent.exists
  console.log(`  -> discriminates? ${correctDiscriminates ? 'YES' : 'NO'}\n`)

  const calibration = await calibrateTableProbe(db as unknown as ProbeableClient, PRESENT_TABLE)
  console.log(`calibrateTableProbe() self-check: sound=${calibration.sound}${calibration.failure ? ` (${calibration.failure})` : ''}\n`)

  const failures: string[] = []
  if (!correctDiscriminates) failures.push('the CORRECT idiom did not discriminate — do not trust any existence report')
  if (!calibration.sound) failures.push(`calibrateTableProbe reported unsound: ${calibration.failure}`)
  if (brokenDiscriminates) {
    failures.push(
      'the BROKEN idiom DID discriminate here — #169 assumed it never does. Re-verify before ' +
        'relying on either form; the platform behaviour may have changed.',
    )
  }

  if (failures.length > 0) {
    console.log('CONTROL FAILED:')
    for (const f of failures) console.log(`  - ${f}`)
    process.exit(1)
  }

  console.log('TABLE_EXISTENCE_PROBE_CONTROL_OK')
  console.log('  broken idiom: cannot tell absent from present (this is the #169 defect, reproduced live)')
  console.log('  correct idiom: present=ok, absent=PGRST205')
}

main().catch((e) => {
  console.error('FAILED:', e)
  process.exit(1)
})
