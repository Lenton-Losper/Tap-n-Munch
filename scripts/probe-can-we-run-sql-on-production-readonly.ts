/**
 * CAN WE RUN A TRANSACTIONAL SQL STATEMENT AGAINST PRODUCTION AT ALL, from CI?
 *
 * Asked because the ruling requires the merge and the catalogue move to happen in ONE transaction,
 * and it turns out the repo's usual route may not be available:
 *
 *   - `supabase link` + `db query --linked` needs SUPABASE_ACCESS_TOKEN. `gh secret list` shows no
 *     such secret, at repo level or on either environment, and apply-ops-migration.yml -- which
 *     exists precisely to use it -- has never once run.
 *   - PostgREST (supabase-js) can express every statement in the merge individually, but has NO
 *     transaction. Three separate updates is exactly the half-done state the ruling forbids.
 *   - an `exec_sql` RPC is REFERENCED by scripts/enable-orders-realtime.ts, whose own fallback
 *     message says it is unavailable. Referenced is not defined, so this checks rather than assumes.
 *
 * `SELECT 1` is the probe payload: if the RPC exists it does nothing, and if it does not the error
 * tells us so. Reads nothing, writes nothing either way.
 */
// @ts-nocheck
import { createClient } from '@supabase/supabase-js'

const PRODUCTION_REF = 'ihlmmpmolnpchzgwyhgh'
const url = process.env.SUPABASE_URL || ''
const key = process.env.SUPABASE_SERVICE_ROLE_KEY || ''
if (!url.includes(PRODUCTION_REF)) {
  throw new Error(`REFUSING: ${url || '(unset)'} is not the production project`)
}
const admin = createClient(url, key, { auth: { persistSession: false } })

async function main() {
  console.log('\nCAN WE RUN SQL ON PRODUCTION? Read-only probe.')
  console.log(`  project ref confirmed in URL: ${PRODUCTION_REF}\n`)

  // control: the client works at all
  const { data: ctl, error: ctlErr } = await admin.from('restaurants').select('id').limit(1)
  console.log(`  [control] PostgREST reachable: ${ctlErr ? `NO — ${ctlErr.message}` : 'YES'}`)
  if (ctlErr) process.exit(1)

  for (const fn of ['exec_sql', 'execute_sql', 'run_sql']) {
    const { error } = await admin.rpc(fn, { sql: 'SELECT 1' })
    if (!error) {
      console.log(`  ${fn.padEnd(14)} EXISTS and accepted a statement — a transactional path is available`)
      continue
    }
    console.log(`  ${fn.padEnd(14)} unavailable (${error.code}) ${String(error.message).slice(0, 90)}`)
  }

  // Does the migration-ledger RPC exist? Its presence proves SQL HAS reached this database by some
  // route in the past -- which is a different claim from "we can do it from CI today".
  const { error: ledgerErr } = await admin.rpc('list_applied_migration_versions')
  console.log(`\n  list_applied_migration_versions: ${ledgerErr ? `absent (${ledgerErr.code})` : 'present'}`)
  console.log('  ^ present only proves past SQL reached production somehow, most likely by hand in')
  console.log('    the Supabase SQL editor. It says nothing about an automated route existing now.')
}

main().catch((e) => {
  console.error('FATAL', e?.message ?? e)
  process.exit(1)
})
