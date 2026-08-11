/**
 * #193 — WHICH CHECK is actually enforced on restaurant_terminals.status?
 *
 * *** NOT RUN. DO NOT RUN WITHOUT SIGN-OFF. This script WRITES. ***
 *
 * Written 2026-08-11 as the deliverable of the ADD COLUMN IF NOT EXISTS audit. That audit
 * settled what the migration FILES say and can go no further: the files agree that
 * 20260620150000's CHECK never applied, but only the live database can confirm which constraint
 * exists, and #193 recommendation 1 asks exactly that of both environments.
 *
 * WHY THIS WRITES, AND WHY IT IS NOT A SELECT
 * The obvious probe is to read pg_constraint / information_schema. That is not available here:
 * PostgREST does not expose the catalogs, which is a limitation already hit on this project when
 * verifying deployed functions. So the only way to learn the enforced vocabulary is to offer the
 * database a value and see whether it is refused. That is a write, it must be cleaned up, and it
 * is why this needs a human decision rather than being run as part of an audit.
 *
 * WHAT IT DISTINGUISHES
 *   'maintenance' ACCEPTED -> the 20260620150000 CHECK is live (audit's conclusion is WRONG)
 *   'maintenance' REJECTED and 'inactive' ACCEPTED
 *                               -> the baseline CHECK is live (audit's conclusion is RIGHT)
 *   both REJECTED             -> a third constraint exists that no migration file declares
 *
 * 'inactive' is the discriminator worth the most: it is in the baseline vocabulary, absent from
 * 20260620150000's, and READ by app/api/admin/terminals/list/route.ts:21 while being written by
 * nothing. If it is rejected, that filter is not merely dead, it is impossible.
 *
 * SAFETY
 * - Refuses production before a client is constructed. .env.local points at PRODUCTION, so this
 *   loads .env.test only.
 * - Refuses to run at all unless PROBE_CONFIRM=yes is set, so it cannot execute by accident.
 * - Creates ONE throwaway terminal row and deletes it in a finally block. It never touches an
 *   existing row: a failed UPDATE on a real terminal could leave a device unable to authenticate,
 *   because lib/terminal-auth.ts:48 gates on status === 'active'.
 *
 *   PROBE_CONFIRM=yes npx tsx scripts/probe-terminal-status-check-20260811.ts
 */
import { config } from 'dotenv'
import { createClient } from '@supabase/supabase-js'
import path from 'node:path'

const STAGING_REF = 'mdqjpxwczrhkxkbqatqa'
const PRODUCTION_REF = 'ihlmmpmolnpchzgwyhgh'

config({ path: path.resolve(__dirname, '..', '.env.test') })

const url = process.env.SUPABASE_URL ?? ''
const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? ''

if (process.env.PROBE_CONFIRM !== 'yes') {
  console.error('REFUSING: this script WRITES to the database and has not been signed off.')
  console.error('Read the header, then set PROBE_CONFIRM=yes if you intend to run it.')
  process.exit(1)
}
if (url.includes(PRODUCTION_REF)) {
  console.error(`REFUSING: SUPABASE_URL is the PRODUCTION project (${PRODUCTION_REF}). Aborting.`)
  process.exit(1)
}
if (!url.includes(STAGING_REF)) {
  console.error(`REFUSING: SUPABASE_URL is not staging (${STAGING_REF}). Got: ${url || '(empty)'}`)
  process.exit(1)
}
if (!key) {
  console.error('REFUSING: SUPABASE_SERVICE_ROLE_KEY is empty.')
  process.exit(1)
}

const CANDIDATES = [
  { value: 'active', declaredIn: 'both' },
  { value: 'inactive', declaredIn: 'baseline only — and READ by the admin list filter' },
  { value: 'pending', declaredIn: 'baseline only' },
  { value: 'revoked', declaredIn: 'both' },
  { value: 'maintenance', declaredIn: '20260620150000 only' },
  { value: 'pending_update', declaredIn: '20260620150000 only' },
  { value: 'definitely_not_a_status', declaredIn: 'nowhere — control' },
] as const

async function main() {
  const db = createClient(url, key, { auth: { persistSession: false } })

  const { data: restaurant, error: restaurantError } = await db
    .from('restaurants')
    .select('id')
    .limit(1)
    .maybeSingle()

  if (restaurantError || !restaurant) {
    throw new Error(`could not read a restaurant to attach the probe row to: ${restaurantError?.message}`)
  }

  let probeId: string | null = null
  try {
    for (const candidate of CANDIDATES) {
      const { data, error } = await db
        .from('restaurant_terminals')
        .insert({
          restaurant_id: restaurant.id,
          activation_code: `PROBE-${Date.now()}`,
          expires_at: new Date(Date.now() + 60_000).toISOString(),
          status: candidate.value,
        })
        .select('id')
        .maybeSingle()

      if (error) {
        console.log(`REJECTED  ${candidate.value.padEnd(24)} (${candidate.declaredIn}) -- ${error.message}`)
      } else {
        console.log(`ACCEPTED  ${candidate.value.padEnd(24)} (${candidate.declaredIn})`)
        probeId = data?.id ?? null
        // Delete immediately: an accepted row is a real terminal row and must not outlive the probe.
        if (probeId) {
          await db.from('restaurant_terminals').delete().eq('id', probeId)
          probeId = null
        }
      }
    }

    // The control must be REJECTED. If it is ACCEPTED, there is no CHECK on this column at all
    // and every other line above is meaningless.
    console.log('\nIf the control was ACCEPTED, the column has NO check constraint and the rest of')
    console.log('this output says nothing. That is the result to report, not the per-value lines.')
  } finally {
    if (probeId) {
      await db.from('restaurant_terminals').delete().eq('id', probeId)
    }
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
