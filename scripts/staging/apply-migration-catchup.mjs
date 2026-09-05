#!/usr/bin/env node
/**
 * ONE-OFF: apply the fourteen migrations staging never received. DELETE THIS FILE once it has run
 * and `scripts/check-migration-drift.mjs` reports staging clean. WRITES DDL.
 *
 * ============================================================================================
 * WHY A SCRIPT AND NOT A WORKFLOW JOB
 * ============================================================================================
 *
 * This was written first as a marker-gated job in `.github/workflows/staging.yml` (9acdcf3a, on
 * `fix/staging-migration-catchup`). That job could never have run. GitHub Actions have been
 * unavailable at the account level since 2026-08-28: jobs are rejected before executing any step,
 * with zero steps, no checkout, and no log blob at all. A fix expressed as a workflow job is dead
 * code for as long as that holds, and dead code shaped like a control is worse than no control,
 * because the next person reads the job and believes the migrations were applied. See #378.
 *
 * This file replaces that job. The job is not carried onto any branch that merges.
 *
 * ============================================================================================
 * THE LIST IS LITERAL, AND THAT IS THE POINT
 * ============================================================================================
 *
 * It does NOT enumerate supabase/migrations/. A step that reads the directory is the generic
 * runner #378 proposes, and arriving at it by accident would ship an apply-everything mechanism
 * with none of the design that needs -- scope headers, ledger repair for applied-but-unrecorded,
 * and a person reading what it is about to run. Fourteen named files can be reviewed. A directory
 * cannot.
 *
 * ORDER: versions ascending, EXCEPT the two pure-data migrations, which run last on the owner's
 * instruction. Three others in the list also write rows (20260826160000 backfills claimed_at,
 * 20260827115000 dedupes, 20260904030000 appends a permission) but each is inseparable from its
 * own schema half, so they keep their version position rather than being split out.
 *
 * STOPS ON THE FIRST FAILURE, and each migration commits with its own ledger row in ONE
 * transaction. A half-applied schema followed by more migrations is the worst outcome available;
 * a migration applied without its ledger row is the exact drift this exercise exists to clear,
 * and it is what `supabase db query` leaves behind.
 *
 * ============================================================================================
 * ONE CHANNEL. THE CONNECTION THAT IS CHECKED IS THE CONNECTION THAT WRITES.
 * ============================================================================================
 *
 * An earlier draft read the ledger over PostgREST and applied DDL over Postgres. Those are two
 * different channels: a REST probe against staging says nothing about which database the Postgres
 * socket landed on, so the identity check and the writes could disagree and nothing would notice.
 * Everything here -- identity, ledger, row counts, DDL -- goes over the one connection.
 *
 * IDENTITY IS READ FROM THE DATABASE, NOT FROM DNS OR A URL. The local resolver here answers for
 * hostnames that do not exist, so a name proves nothing. Instead: 20260705210000 and
 * 20260705220000 are applied on staging and deliberately absent from production, so their presence
 * on the connected server distinguishes the two BY STATE. Both absent is a refusal, not a warning.
 * That matters more than usual here: two of the fourteen are DROP COLUMN.
 *
 * ============================================================================================
 * CREDENTIALS
 * ============================================================================================
 *
 * The password is read FROM A FILE, never from argv and never printed. A secret on a command line
 * is visible in the process table and in shell history.
 *
 * Staging is NOT on production's pooler host. `aws-0-eu-west-1` answers
 * `tenant/user postgres.<staging-ref> not found` -- which is Supavisor rejecting the tenant, not a
 * network failure, and it is easy to misread as "staging is unreachable, supply a connection
 * string". It is reachable: `aws-1-eu-central-1.pooler.supabase.com:5432`, established here on
 * 2026-09-05 and the same route `scripts/apply-held-payments-direct-pg.mjs` and the 2026-09-01 VAT
 * migration took. The candidates are tried in order rather than assumed.
 *
 * Session mode (5432), not transaction mode (6543): DDL and explicit transactions need a session.
 *
 * Usage (from the repo root):
 *   node scripts/staging/apply-migration-catchup.mjs            # dry run: connects, verifies, stops
 *   node scripts/staging/apply-migration-catchup.mjs --apply    # applies
 *
 * Then, to confirm it actually caught up:
 *   MIGRATION_TARGET_ENV=staging node scripts/check-migration-drift.mjs
 */
import { readFileSync, existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const STAGING_REF = 'mdqjpxwczrhkxkbqatqa'
const PROD_REF = 'ihlmmpmolnpchzgwyhgh'
const APPLY = process.argv.includes('--apply')

/** LITERAL AND EXPLICIT. Versions ascending; the two pure-data migrations last. */
const MIGRATIONS = [
  ['20260825030000', '20260825030000_customer_sessions_drop_last_seen_at.sql', 'schema'],
  ['20260826160000', '20260826160000_order_requests_claimed_at.sql', 'schema'],
  ['20260826170000', '20260826170000_restaurants_drop_payment_methods.sql', 'schema'],
  ['20260827111000', '20260827111000_receipt_snapshot_line_vat_basis.sql', 'schema'],
  ['20260827115000', '20260827115000_organization_stock_items_dedupe_and_unique.sql', 'schema'],
  ['20260827116000', '20260827116000_orders_is_stress_fixture.sql', 'schema'],
  ['20260827117000', '20260827117000_crash_reports.sql', 'schema'],
  ['20260827120000', '20260827120000_cron_runs.sql', 'schema'],
  ['20260827121000', '20260827121000_restaurant_terminals_status_vocabulary.sql', 'schema'],
  ['20260903060000', '20260903060000_realtime_private_lines_channel.sql', 'schema'],
  ['20260904020000', '20260904020000_authorization_purpose_walkout_close.sql', 'schema'],
  ['20260904030000', '20260904030000_grant_tabs_close_unpaid.sql', 'schema'],
  ['20260826105000', '20260826105000_issue159_correct_mingle_recipe_quantities.sql', 'data'],
  ['20260827122000', '20260827122000_issue229_variant_groups_from_legacy_variants.sql', 'data'],
]

/**
 * Applied on staging, deliberately NOT on production. Presence identifies the database by state.
 * See scripts/apply-held-payments-direct-pg.mjs, which uses the same pair the other way round.
 */
const STAGING_MARKERS = ['20260705210000', '20260705220000']

const MINGLE_RESTAURANT = '131c39d1-b816-407d-8c5f-e628fc38967e'

/**
 * `pg` is not a dependency of this repo and the build worktrees carry no node_modules, so it is
 * resolved from a standalone install. Candidates rather than one hard-coded path: the sibling
 * scripts pin a session-scoped temp directory that no longer exists, which turns "the module
 * moved" into a stack trace instead of a sentence.
 */
function loadPgClient() {
  const candidates = [
    process.env.PG_MODULE_DIR,
    'D:/dev/pgclient',
    join(REPO, 'node_modules', '..'),
  ].filter(Boolean)
  const tried = []
  for (const dir of candidates) {
    const base = dir.replace(/\\/g, '/').replace(/\/?$/, '/')
    try {
      return createRequire(`file:///${base.replace(/^\/+/, '')}`)('pg').Client
    } catch (err) {
      tried.push(`${dir}: ${String(err.message).split('\n')[0]}`)
    }
  }
  throw new Error(
    'could not load the `pg` module. Set PG_MODULE_DIR to a directory whose node_modules ' +
      `has it.\n    ${tried.join('\n    ')}`,
  )
}

const ENV_FILES = [
  process.env.FLASHTAP_ENV_FILE,
  join(REPO, '.env.local'),
  'C:/Users/223125318/Desktop/mvp2/Tap-n-Munch/.env.local',
].filter(Boolean)

/** Reads one name out of the first env file that defines it. Never printed, never from argv. */
function secret(name) {
  for (const file of ENV_FILES) {
    if (!existsSync(file)) continue
    for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/)
      if (m && m[1] === name) {
        const value = m[2].trim().replace(/^["']|["']$/g, '')
        if (value) return { value, file }
      }
    }
  }
  throw new Error(`${name} is not set in any of:\n    ${ENV_FILES.join('\n    ')}`)
}

/**
 * The `-- @env:` scope header, same vocabulary as check-migration-drift.mjs; absent means 'both'.
 * The list is hand-written, so this is a guard against the list rather than a routing decision:
 * a file scoped `production` must never be applied here just because somebody typed its name.
 */
const SCOPE_RE = /^[ \t]*--[ \t]*@env:[ \t]*(staging|production|both)[ \t]*$/im
function scopeOf(sql) {
  return sql.split(/\r?\n/).slice(0, 30).join('\n').match(SCOPE_RE)?.[1] ?? 'both'
}

async function connectToStaging(Client) {
  const { value: password, file } = secret('SUPABASE_DB_PASSWORD_STAGING')
  console.log(`  password source : ${file} (SUPABASE_DB_PASSWORD_STAGING, not printed)`)

  const candidates = [
    { label: 'pooler eu-central-1 (aws-1)', host: 'aws-1-eu-central-1.pooler.supabase.com' },
    { label: 'pooler eu-central-1 (aws-0)', host: 'aws-0-eu-central-1.pooler.supabase.com' },
    { label: 'pooler eu-west-1', host: 'aws-0-eu-west-1.pooler.supabase.com' },
    { label: 'direct', host: `db.${STAGING_REF}.supabase.co`, user: 'postgres' },
  ]

  for (const c of candidates) {
    // Belt and braces: nothing naming production may be dialled from this script at all.
    if (c.host.includes(PROD_REF) || (c.user ?? '').includes(PROD_REF)) {
      throw new Error(`REFUSING: candidate ${c.label} names the production ref`)
    }
    const client = new Client({
      host: c.host,
      port: 5432,
      user: c.user ?? `postgres.${STAGING_REF}`,
      password,
      database: 'postgres',
      ssl: { rejectUnauthorized: false },
      connectionTimeoutMillis: 15000,
    })
    try {
      await client.connect()
      console.log(`  CONNECTED       : ${c.label} (${c.host}:5432)`)
      return client
    } catch (err) {
      console.log(`  ${c.label.padEnd(28)} ${String(err.message).slice(0, 72)}`)
      try {
        await client.end()
      } catch {}
    }
  }
  throw new Error('no candidate host accepted the connection')
}

/** The figures the two data migrations are judged against, reported either side of the run. */
async function dataCounts(client, label) {
  const { rows } = await client.query(
    `SELECT
       (SELECT count(*) FROM public.recipe_items ri
          JOIN public.recipes rc ON rc.id = ri.recipe_id
         WHERE rc.restaurant_id = $1 AND ri.quantity = 1)                       AS mingle,
       (SELECT count(*) FROM public.menu_items
         WHERE variant_groups IS NOT NULL
           AND jsonb_array_length(variant_groups) > 0)                          AS variants`,
    [MINGLE_RESTAURANT],
  )
  const counts = { mingle: Number(rows[0].mingle), variants: Number(rows[0].variants) }
  console.log(`\n  --- row counts (${label}) ---`)
  console.log(`    recipe_items at quantity = 1 for the Mingle restaurant : ${counts.mingle}`)
  console.log(`    menu_items with a non-empty variant_groups             : ${counts.variants}`)
  return counts
}

async function ledgerVersions(client) {
  const { rows } = await client.query(
    'SELECT version FROM supabase_migrations.schema_migrations ORDER BY version',
  )
  return new Set(rows.map((r) => String(r.version)))
}

console.log('='.repeat(90))
console.log('STAGING MIGRATION CATCH-UP — 14 migrations, direct Postgres, one-off (#378)')
console.log('='.repeat(90))
console.log(`  target ref      : ${STAGING_REF}`)
console.log(`  mode            : ${APPLY ? 'APPLY' : 'DRY RUN — verifies, then stops'}`)

let client = null
try {
  const Client = loadPgClient()
  client = await connectToStaging(Client)

  // ------------------------------------------------------------------ identity, from the server
  const applied = await ledgerVersions(client)
  console.log(`  ledger rows     : ${applied.size}`)

  const missingMarkers = STAGING_MARKERS.filter((v) => !applied.has(v))
  if (missingMarkers.length) {
    throw new Error(
      `REFUSING: ${missingMarkers.join(' and ')} absent from the ledger. Those are applied on ` +
        'staging and deliberately absent from production, so this is NOT staging. Two of the ' +
        'fourteen are DROP COLUMN; nothing is attempted.',
    )
  }
  console.log(`  identity        : staging (${STAGING_MARKERS.join(' and ')} both present)`)

  // ------------------------------------------------------------------ read and vet the fourteen
  console.log('')
  const todo = []
  for (const [version, file, kind] of MIGRATIONS) {
    const path = join(REPO, 'supabase', 'migrations', file)
    if (!existsSync(path)) {
      // A list that has drifted from the tree must stop the run, not quietly apply thirteen of
      // fourteen and report success.
      throw new Error(`${file} is named in the list and is not in the tree. Refusing to continue.`)
    }
    const sql = readFileSync(path, 'utf8')
    const scope = scopeOf(sql)
    if (scope === 'production') {
      throw new Error(`${file} is scoped '@env: production' and must not be applied to staging.`)
    }
    const present = applied.has(version)
    console.log(
      `  ${(present ? 'already applied' : 'WOULD APPLY    ').padEnd(16)}${version} ` +
        `(${kind.padEnd(6)} @env: ${scope.padEnd(8)}) ${file}  ${sql.length}B`,
    )
    if (!present) todo.push({ version, file, kind, sql })
  }
  console.log(`\n  to apply: ${todo.length} of ${MIGRATIONS.length}`)

  const before = await dataCounts(client, 'BEFORE')

  if (!APPLY) {
    console.log('\n  DRY RUN. Nothing was written. Re-run with --apply to apply.')
    console.log('CATCHUP=DRY-RUN')
  } else if (todo.length === 0) {
    console.log('\n  Nothing to do — all fourteen are already in the ledger.')
    console.log('CATCHUP=NOTHING-TO-DO')
  } else {
    for (const item of todo) {
      console.log(`\n  == applying ${item.version} (${item.kind}): ${item.file}`)
      await client.query('BEGIN')
      try {
        await client.query(item.sql)
        await client.query(
          'INSERT INTO supabase_migrations.schema_migrations(version) VALUES ($1) ON CONFLICT DO NOTHING',
          [item.version],
        )
        await client.query('COMMIT')
        console.log('     applied and recorded, in one transaction')
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {})
        console.error(`     FAILED: ${err.message}`)
        console.error('     STOPPING. This migration rolled back; nothing after it was attempted.')
        throw err
      }
    }

    const after = await dataCounts(client, 'AFTER')
    console.log(
      `\n  deltas: mingle ${before.mingle} -> ${after.mingle}, ` +
        `variants ${before.variants} -> ${after.variants}`,
    )

    // Read the ledger back rather than trusting the loop that just wrote it.
    const now = await ledgerVersions(client)
    const stillMissing = MIGRATIONS.map(([v]) => v).filter((v) => !now.has(v))
    if (stillMissing.length) {
      throw new Error(`applied without error, but still missing: ${stillMissing.join(', ')}`)
    }
    console.log(`\n  all ${MIGRATIONS.length} versions confirmed in the ledger (now ${now.size} rows)`)
    console.log('CATCHUP=DONE')
    console.log('\n  Now confirm independently:')
    console.log('    MIGRATION_TARGET_ENV=staging node scripts/check-migration-drift.mjs')
  }
} catch (err) {
  console.error(`\nCATCHUP=FAILED — ${err.message}`)
  process.exitCode = 1
} finally {
  if (client) {
    try {
      await client.end()
    } catch {}
  }
}
