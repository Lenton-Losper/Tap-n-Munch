/**
 * #169 -- run the schema probes against STAGING and print the four controls.
 *
 * Read-only: it selects one row and one column. It writes nothing.
 *
 * This is the script that makes the unit test mean something. `schema-probe-calibration.test.ts`
 * uses a stub that reproduces the asymmetry #169 documented; this asks the real database whether
 * that asymmetry is real, by probing a table that certainly exists and one that certainly does
 * not. If the controls come back indistinguishable, no result from any existence probe on this
 * deployment can be trusted, and the script says so and exits non-zero.
 */
import { config } from 'dotenv'
import { createClient } from '@supabase/supabase-js'
import {
  calibrateSchemaProbes,
  probeTable,
  ABSENT_CONTROL_TABLE,
  type ProbeClient,
} from '../lib/supabase/schema-probe'

config({ path: '.env.test' })

const STAGING_REF = 'mdqjpxwczrhkxkbqatqa'
const url = process.env.SUPABASE_URL || ''
const key = process.env.SUPABASE_SERVICE_ROLE_KEY || ''

if (!url.includes(STAGING_REF)) {
  throw new Error(`REFUSING: expected staging ref ${STAGING_REF}, got ${url}`)
}

const db = createClient(url, key, {
  auth: { persistSession: false, autoRefreshToken: false },
}) as unknown as ProbeClient

async function main() {
  console.log(`=== #169 CONTROLS -- staging ${STAGING_REF} ===`)
  console.log('')
  const cal = await calibrateSchemaProbes(db, 'orders', 'id')
  for (const line of cal.lines) console.log(line)

  console.log('')
  if (!cal.sound) {
    console.log('CONTROLS FAILED -- the probe method is not sound here:')
    for (const f of cal.failures) console.log(`  - ${f}`)
    process.exit(1)
  }
  console.log('CONTROLS SOUND: present and absent are distinguishable.')
  console.log('')

  // The comparison the issue is actually about: what the BROKEN form says about the same
  // known-absent table, measured rather than asserted.
  const raw = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } })
  const broken = await raw
    .from(ABSENT_CONTROL_TABLE)
    .select('*', { count: 'exact', head: true })
  const fixed = await probeTable(db, ABSENT_CONTROL_TABLE)

  console.log(`SAME absent table, two forms:`)
  console.log(`  head:true count:exact  -> error=${broken.error?.code ?? 'null'} count=${broken.count}`)
  console.log(`  probeTable (no head)   -> code=${fixed.code} present=${fixed.present} absent=${fixed.absent}`)

  const brokenSaysPresent = !broken.error
  console.log('')
  console.log(
    brokenSaysPresent
      ? 'CONFIRMED: the broken form reports an ABSENT table as present on this deployment.'
      : 'NOTE: the broken form errored here too -- the defect did not reproduce on staging.'
  )
  console.log('CALIBRATION_DONE')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
