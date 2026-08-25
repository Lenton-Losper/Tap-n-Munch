/**
 * STAGE 2 of the 2026-08-25 promotion. Applies ONE migration to PRODUCTION:
 *
 *   supabase/migrations/20260825020000_tabs_revoke_anon_select.sql   (#284)
 *
 * WRITES DDL. ONE-OFF.
 *
 * WHY THIS IS A SEPARATE STAGE AND NOT PART OF THE DEPLOY
 * ------------------------------------------------------
 * The migration is `-- @env: both`, so `check-migration-drift` demands it before `wrangler deploy`
 * runs -- the drift step sits ABOVE the deploy step in production-worker.yml. Applying it while
 * production still served 84e14e4 would have revoked anon's SELECT on `tabs` underneath a QR
 * landing that still re-read `tabs` through the browser anon client and, on error, called
 * `endTabSession(storedId)`. Every customer holding an open tab would have been evicted for the
 * length of a build.
 *
 * So the code shipped first. This script REFUSES unless that is true.
 *
 * THE PRECONDITION IS CHECKED AGAINST THE LIVE WORKER, not against git: all three production
 * hostnames must be serving a commit that contains the code removal. A rollout is gradual, so
 * every sample must agree -- one cache-busted hit can read either version for ~2 minutes.
 *
 * POSITIVE CONTROL BEFORE AND AFTER. "anon cannot select tabs" is worthless if anon never could,
 * or if the whole connection is broken. So this asserts the grant IS present first, and that a
 * control table anon legitimately reads stays readable afterwards.
 *
 * THE CONTROL IS READ FROM `role_column_grants`, NOT `role_table_grants`. The first version of this
 * script used the table-level view and got `[NONE]` back for `tabs` -- which reads exactly like
 * "already revoked, nothing to do" and would have closed #284 as done. It is not: #262 narrowed
 * anon to a COLUMN list, and column-level grants do not appear in `role_table_grants` at all.
 * Measured on production: 15 column grants on `tabs`, and the unscoped guest policy still live.
 * The control refusing is what caught this -- a probe pointed at the wrong catalog view answers
 * confidently and wrongly, which is #169's lesson in a different catalog.
 *
 * `REVOKE SELECT ON TABLE public.tabs FROM anon` removes column-level SELECT too, so the migration
 * itself needs no change.
 *
 * Usage (from the repo root):
 *   node scripts/prod/apply-284-revoke-anon-tabs.mjs --sha=XXXXXXX            # dry run
 *   node scripts/prod/apply-284-revoke-anon-tabs.mjs --sha=XXXXXXX --confirm  # apply
 */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

const require = createRequire(
  'file:///C:/Users/223125~1/AppData/Local/Temp/claude/C--Users-223125318-Desktop-mvp/42cde80a-ddd8-4302-a2d9-e3cb8803244e/scratchpad/pgclient/',
)
const { Client } = require('pg')

const PROD_REF = 'ihlmmpmolnpchzgwyhgh'
const ENV_FILE = 'C:/Users/223125318/Desktop/mvp/restaurant-menu-screen/.env.local'
const VERSION = '20260825020000'
const FILE = `supabase/migrations/${VERSION}_tabs_revoke_anon_select.sql`
const CONFIRM = process.argv.includes('--confirm')
const REQUIRED_SHA = (process.argv.find((a) => a.startsWith('--sha=')) || '').slice(6)
const HOSTS = ['flashtap.app', 'www.flashtap.app', 'riviera.flashtap.app']
const SAMPLES = 20

/** Applied on staging, deliberately NOT on production. Their absence identifies the database. */
const MUST_BE_ABSENT = ['20260705210000', '20260705220000']

function secret(name) {
  for (const line of readFileSync(ENV_FILE, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/)
    if (m && m[1] === name) return m[2].trim().replace(/^["']|["']$/g, '')
  }
  return ''
}

const die = (msg) => {
  console.error(`\nREFUSING: ${msg}`)
  process.exit(1)
}

async function assertWorkerShipped() {
  if (!REQUIRED_SHA) die('pass --sha=<7-char sha> -- the commit that must be live before this is safe')
  console.log(`PRECONDITION -- all three hostnames must serve ${REQUIRED_SHA}, ${SAMPLES}x each.`)
  for (const host of HOSTS) {
    const seen = new Map()
    for (let i = 0; i < SAMPLES; i++) {
      let sha = '?'
      try {
        const r = await fetch(`https://${host}/api/version?cb=${i}-${VERSION}`, { cache: 'no-store' })
        const t = await r.text()
        const m = t.match(/[0-9a-f]{7,40}/)
        sha = m ? m[0].slice(0, 7) : '?'
      } catch (e) {
        sha = `ERR:${String(e.message).slice(0, 20)}`
      }
      seen.set(sha, (seen.get(sha) || 0) + 1)
    }
    const summary = [...seen].map(([k, v]) => `${v}x ${k}`).join(', ')
    const clean = seen.size === 1 && seen.has(REQUIRED_SHA)
    console.log(`  ${host.padEnd(22)} ${summary}   ${clean ? 'OK' : '*** NOT UNIFORM ***'}`)
    if (!clean) die(`${host} is not uniformly on ${REQUIRED_SHA}. The code removal is not fully live.`)
  }
  console.log('  => the QR landing no longer reads `tabs` through the anon key anywhere.\n')
}

async function main() {
  await assertWorkerShipped()

  const sql = readFileSync(FILE, 'utf8')
  if (!/REVOKE\s+SELECT\s+ON\s+TABLE\s+public\.tabs\s+FROM\s+anon/i.test(sql)) {
    die(`${FILE} does not contain the expected REVOKE -- refusing to run an unrecognised file`)
  }

  const db = new Client({
    host: 'aws-0-eu-west-1.pooler.supabase.com',
    port: 5432,
    user: `postgres.${PROD_REF}`,
    password: secret('SUPABASE_DB_PASSWORD_PROD'),
    database: 'postgres',
    ssl: { rejectUnauthorized: false },
  })
  await db.connect()
  const q = async (s, p = []) => (await db.query(s, p)).rows

  try {
    // ---------------------------------------------------------------- identity, from STATE not DNS
    const led = await q(
      `SELECT version FROM supabase_migrations.schema_migrations WHERE version = ANY($1::text[])`,
      [[...MUST_BE_ABSENT, VERSION]],
    )
    const have = led.map((r) => r.version)
    console.log('IDENTITY')
    for (const v of MUST_BE_ABSENT) {
      console.log(`  ${v} absent? ${have.includes(v) ? '*** PRESENT -- this is NOT production ***' : 'yes'}`)
    }
    if (MUST_BE_ABSENT.some((v) => have.includes(v))) {
      die('the two staging-only migrations are present -- connected to the wrong database')
    }
    if (have.includes(VERSION)) die(`${VERSION} is already in the ledger -- nothing to do`)
    const [{ n }] = await q(`SELECT count(*)::int n FROM supabase_migrations.schema_migrations`)
    console.log(`  ledger rows: ${n}\n`)

    // ------------------------------------------------- positive control: the grant IS there now
    console.log('POSITIVE CONTROL -- anon must currently HOLD the grant, or "revoked" proves nothing')
    const before = await q(
      `SELECT column_name FROM information_schema.role_column_grants
        WHERE grantee='anon' AND table_schema='public' AND table_name='tabs' AND privilege_type='SELECT'
        ORDER BY column_name`,
    )
    console.log(`  anon SELECT columns on public.tabs (${before.length}): ${before.map((r) => r.column_name).join(', ') || 'NONE'}`)
    if (!before.length) {
      die('anon already holds nothing on public.tabs -- the control fails, so the result would be meaningless')
    }

    const pol = await q(`SELECT polname FROM pg_policy WHERE polrelid='public.tabs'::regclass ORDER BY polname`)
    console.log(`  policies on public.tabs: ${pol.map((r) => r.polname).join(' | ')}`)
    const controlBefore = await q(
      `SELECT count(*)::int c FROM information_schema.role_column_grants
        WHERE grantee='anon' AND table_schema='public' AND table_name='menu_items'`,
    )
    console.log(`  CONTROL table anon must KEEP: menu_items grants = ${controlBefore[0].c}\n`)

    if (!CONFIRM) {
      console.log('DRY RUN -- every precondition passed. Re-run with --confirm to apply.')
      return
    }

    // ---------------------------------------------- apply: DDL and ledger row in ONE transaction
    console.log('APPLYING')
    await db.query('BEGIN')
    try {
      await db.query(sql)
      await db.query(
        `INSERT INTO supabase_migrations.schema_migrations (version, name, statements)
         VALUES ($1, $2, $3)`,
        [VERSION, 'tabs_revoke_anon_select', [sql]],
      )
      await db.query('COMMIT')
      console.log('  committed (DDL + ledger row, same transaction)')
    } catch (e) {
      await db.query('ROLLBACK')
      die(`apply failed, rolled back: ${e.message}`)
    }

    // ---------------------------------------------------------------- after
    console.log('\nAFTER')
    const after = await q(
      `SELECT column_name FROM information_schema.role_column_grants
        WHERE grantee='anon' AND table_schema='public' AND table_name='tabs' AND privilege_type='SELECT'`,
    )
    console.log(`  anon SELECT columns on public.tabs: ${after.length} (was ${before.length})`)
    if (after.length !== 0) die('anon still holds column grants on tabs -- the REVOKE did not take')
    const polAfter = await q(`SELECT polname FROM pg_policy WHERE polrelid='public.tabs'::regclass ORDER BY polname`)
    console.log(`  policies on public.tabs: ${polAfter.map((r) => r.polname).join(' | ') || '(none)'}`)
    const controlAfter = await q(
      `SELECT count(*)::int c FROM information_schema.role_column_grants
        WHERE grantee='anon' AND table_schema='public' AND table_name='menu_items'`,
    )
    console.log(`  CONTROL menu_items grants still = ${controlAfter[0].c} (was ${controlBefore[0].c})`)
    if (controlAfter[0].c !== controlBefore[0].c) die('the control table lost grants -- this did more than intended')
    const ledAfter = await q(`SELECT version FROM supabase_migrations.schema_migrations WHERE version=$1`, [VERSION])
    console.log(`  ledger row for ${VERSION}: ${ledAfter.length ? 'present' : '*** MISSING ***'}`)
    console.log('\nAPPLY_284_OK')
  } finally {
    await db.end().catch(() => {})
  }
}

main().catch((e) => {
  console.error('ABORTED:', e.message)
  process.exitCode = 1
})
