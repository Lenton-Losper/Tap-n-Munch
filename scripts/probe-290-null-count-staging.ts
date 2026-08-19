/**
 * #290: does `{head:true, count:'exact'}` really return NULL (not an error) for a missing table?
 *
 * The fix refuses a null count. That is only correct if a null count genuinely means "table
 * absent" — so this reproduces the underlying behaviour rather than trusting #169's note, and
 * proves the two-sided shape the fix depends on:
 *
 *   a table that EXISTS  -> a number (possibly 0)   the control
 *   a table that DOESN'T -> null, with NO error     the defect's raw material
 *
 * Without the control, "null means missing" could equally be "this call always returns null".
 *
 * Staging only. Reads only — it counts rows and asks about a table that does not exist.
 */
// @ts-nocheck
import { createClient } from '@supabase/supabase-js'

const STAGING_REF = 'mdqjpxwczrhkxkbqatqa'
const url = process.env.SUPABASE_URL || ''
const key = process.env.SUPABASE_SERVICE_ROLE_KEY || ''
if (!url.includes(STAGING_REF)) throw new Error(`GUARD: ${url || '(unset)'} is not staging`)
const admin = createClient(url, key, { auth: { persistSession: false } })

const ABSENT = 'table_that_does_not_exist_290'

async function headCount(table: string) {
  const { count, error } = await admin.from(table).select('id', { count: 'exact', head: true })
  return { count, error: error?.code ?? error?.message ?? null }
}

async function main() {
  console.log('\nSTAGING — #290: what a head-count says about a table that is not there\n')

  const present = await headCount('restaurant_users')
  console.log(`  [control] restaurant_users : count=${present.count}  error=${present.error}`)
  if (present.count === null || present.error) {
    console.error('  CONTROL FAILED — a table that exists did not return a number. Nothing below means anything.')
    process.exit(1)
  }

  const absent = await headCount(ABSENT)
  console.log(`  absent table              : count=${absent.count}  error=${absent.error}`)

  // The other form, which #169 used to tell them apart.
  const { error: noHeadErr } = await admin.from(ABSENT).select('id').limit(1)
  console.log(`  same table, no head:true  : error=${noHeadErr?.code ?? noHeadErr?.message ?? 'none'}`)

  const reproduced = absent.count === null && !absent.error
  console.log(
    `\n  ${reproduced
      ? 'REPRODUCED — a missing table returns count=null with NO error, so `count ?? 0` recorded it as 0 rows.'
      : 'NOT REPRODUCED — the behaviour differs here; the fix should be re-examined.'}`,
  )
  console.log(
    `  The fix refuses a null count, which is ${reproduced ? 'correct' : 'NOT justified by this run'}.`,
  )
  process.exitCode = reproduced ? 0 : 1
}

main().catch((e) => { console.error('FATAL', e?.message ?? e); process.exit(1) })
