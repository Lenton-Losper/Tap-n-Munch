#!/usr/bin/env node
/**
 * A MIGRATION MUST NOT BUNDLE A SCHEMA CHANGE WITH A DATA WRITE TO LIVE ROWS.
 *
 * ============================================================================================
 * THE RULE, AND WHY IT IS A RULE
 * ============================================================================================
 *
 * Ruled by the owner 2026-09-02:
 *
 *   "A migration that bundles a schema fix with a data write to live rows should not exist."
 *
 * The two halves have completely different risk profiles. A schema change is reviewable in the
 * diff and reversible with another DDL statement. A write to production rows is neither: once
 * `UPDATE restaurants SET vat_rate = 15` has run, the previous values are gone unless somebody
 * thought to capture them first, and no later migration can restore what was not recorded.
 *
 * Bundling them means the dangerous half gets approved on the strength of the safe half. Someone
 * reads "adds a nullable column", says yes, and ships a data write nobody examined. The failure
 * is not that the write is wrong — it is that nobody was asked about it separately.
 *
 * So: separate files, separate approvals, separate deploys. The schema lands, gets verified, and
 * only then does anyone decide what should be written into it.
 *
 * ============================================================================================
 * WHAT COUNTS
 * ============================================================================================
 *
 * A violation is one file containing BOTH:
 *   - DDL:  CREATE TABLE / ALTER TABLE / ADD COLUMN / DROP COLUMN / ADD CONSTRAINT
 *   - DML:  UPDATE <table> SET … / INSERT INTO <table> …
 *
 * NOT a violation, and deliberately so:
 *   - A pure backfill migration. It writes rows and nothing else, so the write IS the review.
 *   - A pure DDL migration.
 *   - Writes to the migration ledger itself (supabase_migrations.schema_migrations).
 *   - INSERTs into a table the same file just CREATEd. Seeding a brand-new table touches no
 *     live row, because there were none a moment ago — the whole hazard is absent.
 *
 * ============================================================================================
 * A RATCHET, NOT A PURGE
 * ============================================================================================
 *
 * Existing offenders are baselined by filename below. This rule cannot retroactively unbundle
 * migrations that already ran months ago, and failing the build over them would just get the
 * check switched off. It fails on anything NEW.
 *
 * Exit 0 = clean. Exit 1 = a new migration bundles the two.
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '..', 'supabase', 'migrations')

/**
 * Files that already bundle both, from before the rule existed. Each is a historical fact, not a
 * licence. Adding to this list requires the owner's sign-off — that is the point of the rule.
 */
const BASELINE = new Set([
  '20260620150000_terminal_api_layer.sql',
  '20260628130000_add_kiosk_whatsapp_features.sql',
  '20260630120000_grv_header_lineitems.sql',
  '20260701120000_recipe_bom_deduction.sql',
  '20260702120000_measurement_units.sql',
  '20260704120000_menu_items_track_inventory.sql',
  '20260705150000_restaurant_roles_invite_eligible.sql',
  '20260705210000_post_payment_order_lifecycle.sql',
  '20260705280000_business_documents.sql',
  '20260705300000_payment_events.sql',
  '20260705320000_terminal_privileged_authorization.sql',
  '20260725200000_document_engine_credit_notes_lineage.sql',
  '20260801010000_recipes_soft_delete.sql',
  '20260824120000_restaurants_is_counter_service.sql',
  '20260824140000_stock_transfer_reject_and_cancel_in_transit.sql',
  '20260826160000_order_requests_claimed_at.sql',
  '20260828141000_cooked_state.sql',
  '20260828235900_order_line_events_four_state_check.sql',
  '20260829131000_staff_without_logins.sql',
])

const DDL = /^\s*(CREATE\s+TABLE|ALTER\s+TABLE)\b/im
const UPDATE_STMT = /^\s*UPDATE\s+(?:"?public"?\.)?"?([a-z_]+)"?/gim
const INSERT_STMT = /^\s*INSERT\s+INTO\s+(?:"?([a-z_]+)"?\.)?"?([a-z_]+)"?/gim
const CREATED_TABLE = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:"?public"?\.)?"?([a-z_]+)"?/gim

/** Strip `--` line comments and /* *\/ blocks so prose about UPDATE is not read as an UPDATE. */
export function stripComments(sql) {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split(/\r?\n/)
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n')
}

export function analyse(sql) {
  const code = stripComments(sql)
  const hasDdl = DDL.test(code)

  const created = new Set()
  for (const m of code.matchAll(CREATED_TABLE)) created.add(m[1].toLowerCase())

  const writes = []
  for (const m of code.matchAll(UPDATE_STMT)) {
    const table = m[1].toLowerCase()
    if (table === 'schema_migrations' || created.has(table)) continue
    writes.push(`UPDATE ${table}`)
  }
  for (const m of code.matchAll(INSERT_STMT)) {
    const schema = (m[1] || '').toLowerCase()
    const table = m[2].toLowerCase()
    if (schema === 'supabase_migrations' || table === 'schema_migrations' || created.has(table)) continue
    writes.push(`INSERT INTO ${table}`)
  }

  return { hasDdl, writes, violation: hasDdl && writes.length > 0 }
}

function selfTest() {
  const failures = []
  const bundled = 'ALTER TABLE public.restaurants ADD COLUMN vat_rate numeric;\nUPDATE public.restaurants SET vat_rate = 15;'
  const pureDdl = 'ALTER TABLE public.restaurants ADD COLUMN vat_rate numeric;'
  const pureDml = 'UPDATE public.restaurants SET vat_rate = 15;'
  const seedNew = 'CREATE TABLE public.thing (id uuid);\nINSERT INTO public.thing (id) VALUES (gen_random_uuid());'
  const ledger = 'ALTER TABLE public.x ADD COLUMN y int;\nINSERT INTO supabase_migrations.schema_migrations (version) VALUES (1);'
  const proseOnly = 'ALTER TABLE public.x ADD COLUMN y int;\n-- we deliberately do not UPDATE public.restaurants here'

  if (!analyse(bundled).violation) failures.push('failed to flag a bundled schema change + data write')
  if (analyse(pureDdl).violation) failures.push('flagged a pure DDL migration')
  if (analyse(pureDml).violation) failures.push('flagged a pure backfill migration')
  if (analyse(seedNew).violation) failures.push('flagged seeding a table created in the same file')
  if (analyse(ledger).violation) failures.push('flagged a write to the migration ledger')
  if (analyse(proseOnly).violation) failures.push('read prose in a comment as a data write')
  return failures
}

const selfTestFailures = selfTest()
if (selfTestFailures.length) {
  console.error('MIGRATION DATA-WRITE CHECK ABORTED — the checker cannot verify itself:')
  for (const f of selfTestFailures) console.error(`  - ${f}`)
  process.exit(1)
}

const files = readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort()
const offenders = []
for (const file of files) {
  const { violation, writes } = analyse(readFileSync(join(MIGRATIONS, file), 'utf8'))
  if (violation && !BASELINE.has(file)) offenders.push({ file, writes })
}

console.log(
  `MIGRATION DATA-WRITE CHECK: self-test PASS, scanned ${files.length} migration(s), ${BASELINE.size} baselined.`,
)

if (offenders.length) {
  console.error('\nFAIL — these migrations bundle a schema change with a write to live rows:\n')
  for (const o of offenders) {
    console.error(`  ${o.file}`)
    for (const w of [...new Set(o.writes)]) console.error(`      ${w}`)
  }
  console.error('\nSplit them. The schema change is reviewable and reversible; the data write is')
  console.error('neither, and bundling them gets the dangerous half approved on the strength of the')
  console.error('safe half. Separate files, separate approvals, separate deploys.')
  process.exit(1)
}

console.log('OK — no migration bundles a schema change with a data write.')
