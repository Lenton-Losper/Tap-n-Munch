#!/usr/bin/env node
/**
 * CHAOS TAB LIFECYCLE -- real route handlers, real PostgREST, real Postgres.
 *
 *   node supabase/tests/chaos-e2e.mjs                 build, run the scenario, tear down
 *   node supabase/tests/chaos-e2e.mjs --mutate=V1     apply one mutation, expect its checkpoint RED
 *   node supabase/tests/chaos-e2e.mjs --mutate=all    every mutation, one fresh build each
 *   node supabase/tests/chaos-e2e.mjs --keep          leave the database and PostgREST running
 *
 * WHAT IS REAL. The scenario in __tests__/chaos/tab-lifecycle.chaos.ts imports the Next route
 * modules themselves (rounds, amend, lines, allocate, settle-allocations, settle, prepare-payment,
 * verify-payment, order status, tables, station line state, order history, invoice from-order) and
 * calls their exported handlers. Their supabase-js client talks HTTP to a real PostgREST container,
 * which talks to a real Postgres database built from the REAL baseline plus every later migration
 * that is applied on production -- not the hand-written fixture schema. So a route's filter, a
 * column the route forgets to select, an RLS/grant gap, a CHECK constraint and an RPC body are all
 * exercised together, which is the one thing neither the in-memory PostgREST fake nor the SQL-only
 * suite can prove.
 *
 * WHAT IS NOT. Terminal JWT verification (jose is ESM-only and cannot load under ts-jest) is replaced
 * by a mock that still requires the Bearer header and re-reads the terminal row from the database.
 * The gateway is simulated: Finatic credentials and order.query are mocked to report a verified
 * amount, exactly where the DB suite hands `settle_order_payment` a gateway amount. Realtime
 * broadcast and receipt email are stubbed. Admin (dashboard) auth is mocked to a permitted caller.
 * Manager PIN authorizations are minted as rows, as the authorize route would write them.
 *
 * SAFETY. As in run-db-tests.mjs: every SQL statement runs through `docker exec` in the named local
 * container, and the PostgREST container is started by THIS script against that container's bridge
 * address. There is no connection string, host argument or environment variable that can point any
 * of it at a real database. The only URL handed to jest is the 127.0.0.1 proxy this script opened,
 * and the scenario refuses to start unless it is exactly that shape, and wraps `fetch` so that any
 * request to a non-loopback host throws.
 */
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { createHmac, randomBytes } from 'node:crypto'
import { readFileSync, readdirSync, writeFileSync, existsSync, mkdtempSync } from 'node:fs'
import http from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * A Postgres container of the chaos harness's OWN, not the shared ft-harden-pg. Roles are
 * cluster-wide: Supabase's `service_role` has BYPASSRLS, the shared cluster's does not (another
 * harness created it first), and changing a shared role under other agents' suites is not ours to
 * do. One container per database name, started here, never published on a host port.
 */
/**
 * VERSIONS PINNED TO PRODUCTION, as the Supabase CLI recorded them for ref ihlmmpmolnpchzgwyhgh on
 * 2026-09-02 (supabase/.temp/rest-version = v14.5, postgres-version = 17.6.1.105). This matters and
 * was measured: PostgREST <= 14.1 re-applies a mutation's `or=` filter to the RETURNING set, so the
 * tab settle route's cash claim (`.update().or(...).select('id')`) fails there with 42703
 * "column orders.payment_status does not exist". On 14.5 it works. A harness on the wrong
 * PostgREST reports defects production does not have.
 */
const PG_IMAGE = 'postgres:17'
const DB = process.env.FT_TEST_DB || 'ft_chaos'
if (!/^[a-z][a-z0-9_]{0,40}$/.test(DB)) throw new Error(`FT_TEST_DB must be a plain database name, got ${DB}`)
const CONTAINER = `ft-chaos-pg-${DB}`.replace(/_/g, '-')
const PGRST_IMAGE = 'postgrest/postgrest:v14.5'
const PGRST_CONTAINER = `ft-chaos-pgrst-${DB}`.replace(/_/g, '-')
// A login role of our own: the shared cluster's `authenticator` may belong to another harness.
const PGRST_LOGIN = 'ft_chaos_authenticator'
const PGRST_PASSWORD = 'chaos-local-only'
const REPO = new URL('../..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const CHAOS_TEST = '__tests__/chaos/tab-lifecycle.chaos.ts'

// ------------------------------------------------------------------------------------------------
// MIGRATION SELECTION: model PRODUCTION.
// ------------------------------------------------------------------------------------------------

/** `-- @env: staging` files are never applied to production (the drift checker's own rule). */
const SKIP_ENV = 'staging'

/**
 * Scoped `@env: staging` in this tree but APPLIED ON PRODUCTION since: 20260901120000 was applied
 * over direct Postgres on 2026-09-18 (the header fix, staging -> both, is 8f0732e7 on
 * fix/billing-vat-registered-production and has not reached this base). The invoice route reads
 * the column it adds.
 */
const APPLIED_DESPITE_HEADER = new Set(['20260901120000_billing_profile_vat_registration.sql'])

/**
 * Held from main on every promotion and applied on NEITHER database (owner-run; see the memory note
 * "two migrations are permanently held from main"). Applying them here would test a schema nobody
 * runs.
 */
const HELD = new Set([
  '20260825020000_tabs_revoke_anon_select.sql',
  '20260825030000_customer_sessions_drop_last_seen_at.sql',
])

/**
 * Files that fail when replayed on top of the baseline, with WHY that is expected. The baseline is a
 * 2026-06-30 snapshot, so migrations up to that date are already in it and trip "already exists";
 * two more are data seeds for rows that exist only in real environments. Any failure NOT listed
 * here aborts the build: a new migration that cannot apply is a finding, not noise.
 */
const EXPECTED_FAILURES = {
  '20260617120000_bug_reports.sql': 'in the 2026-06-30 baseline',
  '20260628130000_add_kiosk_whatsapp_features.sql': 'in the baseline; its seed row names a real restaurant',
  '20260629130000_audit_logs.sql': 'in the 2026-06-30 baseline',
  '20260629170000_report_schedules.sql': 'in the 2026-06-30 baseline',
  '20260629180000_report_send_log.sql': 'in the 2026-06-30 baseline',
  '20260630100000_stock_ledger.sql': 'in the 2026-06-30 baseline (column since renamed)',
  '20260630120000_grv_header_lineitems.sql': 'in the 2026-06-30 baseline (column since renamed)',
  '20260630130000_par_level_grv_number.sql': 'in the 2026-06-30 baseline',
  '20260630150000_adjustment_type.sql': 'in the 2026-06-30 baseline',
  '20260717120000_seed_whatsapp_account_staging.sql': 'data seed for a staging restaurant row',
  '20260827122000_issue229_variant_groups_from_legacy_variants.sql':
    'production data backfill; refuses by design when its named menu_items row is absent',
}

// ------------------------------------------------------------------------------------------------
// MUTATIONS. Each reintroduces one defect and names the FIRST chaos checkpoint that must go red.
// `ts` mutations edit a source file for the duration of the run; `sql` mutations rewrite a
// migration's text before it is applied. Every edit must land exactly once, and the edited line is
// printed back from disk / from the text so a mutation that hits a comment cannot pass silently.
// ------------------------------------------------------------------------------------------------
const MUTATIONS = {
  V1: {
    what: 'a void that is not persisted but is reported as success (amend_order_lines leaves the state)',
    expect: 'C06 cancel three items: server voided them',
    sql: {
      // Retargeted 2026-09-29: the LIVE definition. Mutating a superseded migration is overwritten
      // by the later redefinition before the scenario runs -- the mutation silently never lands.
      file: '20260929120200_amend_refuses_payment_in_flight.sql',
      from: "        SET kitchen_state = CASE WHEN kitchen_state = 'outstanding' THEN 'voided' ELSE kitchen_state END,\n            bar_state = CASE WHEN bar_state = 'outstanding' THEN 'voided' ELSE bar_state END",
      to: '        SET kitchen_state = kitchen_state,\n            bar_state = bar_state',
    },
  },
  V2: {
    what: 'a cancelled line is still charged (projection no longer subtracts voided lines)',
    expect: 'C06 cancel three items: server voided them',
    ts: {
      file: 'lib/orders/order-financials.ts',
      from: '    if (voided) voidedCents += totalCents\n',
      to: '    if (voided) voidedCents += 0\n',
    },
  },
  R1: {
    what: 'a round replay with an EDITED body is accepted as a duplicate',
    expect: 'C11 edited retry with the same key: 409, nothing new',
    ts: {
      file: 'lib/orders/round-idempotency.ts',
      from: 'export function isSameRound(',
      to: 'export function isSameRound(..._ignored: unknown[]): boolean { return true }\nexport function isSameRoundOriginal(',
    },
  },
  P1: {
    what: 'a line on a PAID order can be voided (order_paid guard off)',
    expect: 'C14 void an item on a paid order: refused order_paid',
    sql: {
      // Retargeted 2026-09-29: the LIVE definition. Mutating a superseded migration is overwritten
      // by the later redefinition before the scenario runs -- the mutation silently never lands.
      file: '20260929120200_amend_refuses_payment_in_flight.sql',
      from: "        IF FOUND AND lower(btrim(COALESCE(v_payment_status, ''))) = 'paid' THEN",
      to: '        IF false THEN',
    },
  },
  D1: {
    what: 'double settlement of the same orders (the settle route claim guard off)',
    expect: 'C13 double-tapped cash settle: exactly one claim',
    ts: {
      file: 'app/api/terminal/tabs/[tabId]/settle/route.ts',
      from: "      claimQuery = claimQuery.or(\n        `payment_status.in.(${cashStatusList}),` +",
      to: "      claimQuery = claimQuery.or(\n        `payment_status.not.is.null,payment_status.in.(${cashStatusList}),` +",
    },
  },
  A1: {
    what: 'an allocation can be settled twice (claim no longer requires settled_at IS NULL)',
    expect: 'C04 replay item payment: nothing charged twice',
    sql: {
      // Retargeted 2026-09-29: the LIVE definition. Mutating a superseded migration is overwritten
      // by the later redefinition before the scenario runs -- the mutation silently never lands.
      file: '20260929120300_allocation_settle_locks_orders.sql',
      from: '      AND voided_at IS NULL\n      AND settled_at IS NULL\n    RETURNING id, amount_cents INTO v_claimed;',
      to: '      AND voided_at IS NULL\n    RETURNING id, amount_cents INTO v_claimed;',
      // The unique index is the second line of defence; drop it so the RPC guard is what is tested.
      after: 'DROP INDEX IF EXISTS public.order_line_allocation_settlements_one_per_allocation;',
    },
  },
  H1: {
    what: 'dashboard revenue sums the original order totals again (voided items counted as revenue)',
    expect: 'C22 final: terminal lines, tables, order history and invoice agree',
    ts: {
      file: 'app/api/orders/history/route.ts',
      from: '      grossPaidCents += computeOrderFinancials(',
      to: '      grossPaidCents += Math.round(Number(order.total) * 100) + 0 * computeOrderFinancials(',
    },
  },
  B1: {
    what: 'a partial payment is not deducted from the remaining balance',
    expect: 'C03 pay about half by item: balance reduced by exactly that',
    ts: {
      file: 'lib/orders/order-financials.ts',
      from: '  let paidCents = allocSettled\n',
      to: '  let paidCents = 0\n',
    },
  },
}

// ------------------------------------------------------------------------------------------------
// docker / psql
// ------------------------------------------------------------------------------------------------
function docker(args, input) {
  return execFileSync('docker', args, { input, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'] })
}
function psql(sql, { db = DB, single = false } = {}) {
  const args = ['exec', '-i', CONTAINER, 'psql', '-U', 'postgres', '-d', db, '-v', 'ON_ERROR_STOP=1', '-q']
  if (single) args.push('-1')
  return docker(args, sql)
}

function migrationFiles() {
  return readdirSync(join(REPO, 'supabase/migrations'))
    .filter((f) => f.endsWith('.sql'))
    .sort()
}

function envScope(sql) {
  const m = /^--\s*@env:\s*(\w+)/m.exec(sql.split('\n').slice(0, 5).join('\n'))
  return m ? m[1] : 'both'
}

function applyOnce(text, from, to, label) {
  const hits = text.split(from).length - 1
  if (hits !== 1) throw new Error(`mutation ${label}: expected exactly one match, found ${hits}`)
  return text.replace(from, to)
}

function buildDatabase(mutation) {
  psql(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE);`, { db: 'postgres' })
  psql(`CREATE DATABASE ${DB};`, { db: 'postgres' })
  psql(readFileSync(join(REPO, 'supabase/tests/chaos/supabase-stub.sql'), 'utf8'))
  psql(`DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${PGRST_LOGIN}') THEN
      CREATE ROLE ${PGRST_LOGIN} LOGIN NOINHERIT PASSWORD '${PGRST_PASSWORD}';
    END IF; END $$;
    ALTER ROLE ${PGRST_LOGIN} PASSWORD '${PGRST_PASSWORD}';
    GRANT anon, authenticated, service_role TO ${PGRST_LOGIN};`)
  psql(readFileSync(join(REPO, 'supabase/migrations/00000000000000_baseline.sql'), 'utf8'))

  const skipped = []
  const expectedFailed = []
  let applied = 0
  let mutationLanded = false
  for (const file of migrationFiles()) {
    if (file === '00000000000000_baseline.sql') continue
    // CRLF-normalised, as run-db-tests.mjs does: a checkout's line endings must not decide whether a mutation lands.
    let sql = readFileSync(join(REPO, 'supabase/migrations', file), 'utf8').replace(/\r\n/g, '\n')
    if (envScope(sql) === SKIP_ENV && !APPLIED_DESPITE_HEADER.has(file)) { skipped.push(`${file} (@env: staging)`); continue }
    if (HELD.has(file)) { skipped.push(`${file} (held from main, applied nowhere)`); continue }
    if (mutation?.sql && mutation.sql.file === file) {
      sql = applyOnce(sql, mutation.sql.from, mutation.sql.to, mutation.id)
      const line = sql.split('\n').find((l) => l.includes(mutation.sql.to.split('\n')[0].trim()))
      console.log(`  MUTATED ${file}: ${line?.trim()}`)
      mutationLanded = true
    }
    try {
      psql(sql, { single: true })
      applied += 1
    } catch (e) {
      const reason = EXPECTED_FAILURES[file]
      const message = String(e.stderr || e.message).split('\n').find((l) => l.includes('ERROR')) || String(e.message)
      if (!reason) throw new Error(`migration ${file} failed and is not an expected failure:\n${message}`)
      expectedFailed.push(`${file}: ${reason}`)
    }
  }
  if (mutation?.sql) {
    if (!mutationLanded) throw new Error(`mutation ${mutation.id}: file ${mutation.sql.file} was never applied`)
    if (mutation.sql.after) psql(mutation.sql.after)
  }
  psql(readFileSync(join(REPO, 'supabase/tests/chaos/seed.sql'), 'utf8'))
  return { applied, skipped, expectedFailed }
}

// ------------------------------------------------------------------------------------------------
// PostgREST + the /rest/v1 proxy
// ------------------------------------------------------------------------------------------------
function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_')
}
function signJwt(payload, secret) {
  const head = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
  const body = b64url(JSON.stringify(payload))
  const sig = b64url(createHmac('sha256', secret).update(`${head}.${body}`).digest())
  return `${head}.${body}.${sig}`
}

function stopPostgrest() {
  spawnSync('docker', ['rm', '-f', PGRST_CONTAINER], { encoding: 'utf8' })
}

async function ensurePostgres() {
  const running = spawnSync('docker', ['inspect', '-f', '{{.State.Running}}', CONTAINER], { encoding: 'utf8' })
  if (running.stdout.trim() !== 'true') {
    spawnSync('docker', ['rm', '-f', CONTAINER], { encoding: 'utf8' })
    docker(['run', '-d', '--name', CONTAINER, '-e', 'POSTGRES_PASSWORD=chaos-local-only', PG_IMAGE])
  }
  for (let i = 0; i < 60; i += 1) {
    const ready = spawnSync('docker', ['exec', CONTAINER, 'pg_isready', '-U', 'postgres'], { encoding: 'utf8' })
    if (ready.status === 0) {
      // pg_isready answers during the image's init restart; a real query is the readiness proof.
      const q = spawnSync('docker', ['exec', CONTAINER, 'psql', '-U', 'postgres', '-tAc', 'select 1'], { encoding: 'utf8' })
      if (q.stdout.trim() === '1') return
    }
    await new Promise((r) => setTimeout(r, 1000))
  }
  throw new Error(`Postgres container ${CONTAINER} did not become ready`)
}

async function startPostgrest(secret) {
  stopPostgrest()
  const nets = JSON.parse(docker(['inspect', '-f', '{{json .NetworkSettings.Networks}}', CONTAINER]))
  const ip = Object.values(nets)[0]?.IPAddress
  if (!ip || !/^(172|10|192\.168)\./.test(ip)) throw new Error(`unexpected container address ${ip}`)
  docker([
    'run', '-d', '--name', PGRST_CONTAINER, '-p', '127.0.0.1::3000',
    '-e', `PGRST_DB_URI=postgres://${PGRST_LOGIN}:${PGRST_PASSWORD}@${ip}:5432/${DB}`,
    '-e', 'PGRST_DB_SCHEMAS=public',
    '-e', 'PGRST_DB_ANON_ROLE=anon',
    '-e', `PGRST_JWT_SECRET=${secret}`,
    '-e', 'PGRST_DB_POOL=20',
    PGRST_IMAGE,
  ])
  const mapped = docker(['port', PGRST_CONTAINER, '3000/tcp']).trim().split('\n')[0]
  const port = Number(mapped.split(':').pop())
  for (let i = 0; i < 60; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/`)
      if (res.status === 200) return port
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error('PostgREST did not become ready:\n' + spawnSync('docker', ['logs', PGRST_CONTAINER], { encoding: 'utf8' }).stderr)
}

/** supabase-js addresses `${url}/rest/v1/...`; PostgREST serves `/...`. Nothing else is proxied. */
function startProxy(pgrstPort) {
  const server = http.createServer((req, res) => {
    if (!req.url.startsWith('/rest/v1/')) {
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: `chaos proxy serves /rest/v1 only, not ${req.url}` }))
      return
    }
    const upstream = http.request(
      { host: '127.0.0.1', port: pgrstPort, method: req.method, path: req.url.slice('/rest/v1'.length), headers: { ...req.headers, host: `127.0.0.1:${pgrstPort}` } },
      (up) => { res.writeHead(up.statusCode, up.headers); up.pipe(res) },
    )
    upstream.on('error', (e) => { res.writeHead(502); res.end(String(e)) })
    req.pipe(upstream)
  })
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)))
}

function runChild(cmd, args, opts) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { ...opts, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => { stdout += d })
    child.stderr.on('data', (d) => { stderr += d })
    child.on('close', (status) => resolve({ status, stdout, stderr }))
  })
}

// ------------------------------------------------------------------------------------------------
// One run
// ------------------------------------------------------------------------------------------------
async function runOnce(mutation, { keep }) {
  let restore = null
  if (mutation?.ts) {
    const path = join(REPO, mutation.ts.file)
    const original = readFileSync(path, 'utf8')
    // A CRLF checkout (core.autocrlf) must not make a multi-line mutation silently miss.
    const eol = original.includes('\r\n') ? '\r\n' : '\n'
    const mutated = applyOnce(original, mutation.ts.from.replace(/\n/g, eol), mutation.ts.to.replace(/\n/g, eol), mutation.id)
    writeFileSync(path, mutated)
    restore = () => writeFileSync(path, original)
    const first = mutation.ts.to.split('\n')[0].trim()
    const line = readFileSync(path, 'utf8').split('\n').findIndex((l) => l.includes(first))
    console.log(`  MUTATED ${mutation.ts.file}:${line + 1}: ${readFileSync(path, 'utf8').split('\n')[line].trim()}`)
  }
  let server = null
  try {
    await ensurePostgres()
    const build = buildDatabase(mutation)
    console.log(`  schema: baseline + ${build.applied} migrations applied; ${build.skipped.length} skipped; ${build.expectedFailed.length} expected failures`)
    if (!mutation) {
      for (const s of build.skipped) console.log(`    skipped  ${s}`)
      for (const s of build.expectedFailed) console.log(`    expected ${s}`)
    }
    const secret = randomBytes(32).toString('hex')
    const pgrstPort = await startPostgrest(secret)
    server = await startProxy(pgrstPort)
    const proxyPort = server.address().port
    const serviceKey = signJwt({ role: 'service_role', iss: 'chaos-e2e', iat: Math.floor(Date.now() / 1000) }, secret)
    const outDir = mkdtempSync(join(tmpdir(), 'chaos-'))
    const outFile = join(outDir, 'result.json')
    // ASYNC spawn: the /rest/v1 proxy lives in THIS process, and spawnSync would block the event
    // loop that serves it -- every route call would hang until jest's timeout.
    const child = await runChild(
      process.execPath,
      [
        join(REPO, 'node_modules/jest/bin/jest.js'), '--ci', '--runInBand', '--forceExit',
        '--testMatch', '**/__tests__/chaos/**/*.chaos.ts',
        '--testPathIgnorePatterns', '/node_modules/', '/\\.claude/',
        '--json', '--outputFile', outFile,
        CHAOS_TEST,
      ],
      {
        cwd: REPO,
        env: {
          ...process.env,
          FT_CHAOS_REST_URL: `http://127.0.0.1:${proxyPort}`,
          FT_CHAOS_SERVICE_KEY: serviceKey,
          FT_CHAOS_DB: DB,
          FT_CHAOS_CONTAINER: CONTAINER,
        },
      },
    )
    const out = `${child.stdout}\n${child.stderr}`
    writeFileSync(join(outDir, 'output.txt'), out)
    console.log(`  jest output: ${join(outDir, 'output.txt')}`)
    if (!existsSync(outFile)) {
      console.log(out.slice(-8000))
      throw new Error('jest produced no result file')
    }
    const result = JSON.parse(readFileSync(outFile, 'utf8'))
    const tests = (result.testResults[0]?.assertionResults ?? [])
    return { tests, out, keepInfo: { proxyPort, pgrstPort } }
  } finally {
    if (restore) {
      restore()
      console.log(`  restored ${mutation.ts.file}`)
    }
    if (server) server.close()
    if (!keep) stopPostgrest()
  }
}

function firstFailure(tests) {
  return tests.find((t) => t.status === 'failed') ?? null
}

function printTests(tests) {
  for (const t of tests) {
    console.log(`  ${t.status === 'passed' ? 'PASS' : t.status === 'failed' ? 'FAIL' : t.status.toUpperCase()}  ${t.title}`)
    if (t.status === 'failed') {
      const msg = (t.failureMessages ?? []).join('\n').split('\n').filter((l) => !/^\s+at /.test(l)).slice(0, 14).join('\n')
      console.log(msg.replace(/^/gm, '        '))
    }
  }
}

async function main() {
  const args = process.argv.slice(2)
  const keep = args.includes('--keep')
  const mutateArg = args.find((a) => a.startsWith('--mutate='))?.slice('--mutate='.length)
  const ids = !mutateArg ? [null] : mutateArg === 'all' ? Object.keys(MUTATIONS) : mutateArg.split(',')

  let failed = 0
  for (const id of ids) {
    if (id && !MUTATIONS[id]) throw new Error(`unknown mutation ${id}; known: ${Object.keys(MUTATIONS).join(', ')}`)
    const mutation = id ? { id, ...MUTATIONS[id] } : null
    console.log(id ? `\n=== MUTATION ${id}: ${mutation.what}` : '\n=== CHAOS SCENARIO (unmutated)')
    const { tests, out } = await runOnce(mutation, { keep })
    if (tests.length === 0) {
      console.log(out.slice(-6000))
      console.log('  NO TESTS RAN -- treated as a failure')
      failed += 1
      continue
    }
    if (!mutation) {
      printTests(tests)
      const bad = tests.filter((t) => t.status !== 'passed')
      console.log(`\n  ${tests.length - bad.length}/${tests.length} checkpoints passed`)
      if (bad.length) failed += 1
      continue
    }
    const first = firstFailure(tests)
    if (!first) {
      console.log(`  STILL GREEN -- mutation ${id} was NOT caught (${tests.length} checkpoints passed)`)
      failed += 1
    } else if (!first.title.startsWith(mutation.expect)) {
      console.log(`  RED, but at the wrong checkpoint: expected "${mutation.expect}", first red "${first.title}"`)
      printTests([first])
      failed += 1
    } else {
      const line = (first.failureMessages ?? []).join('\n').split('\n').find((l) => /Expected|Received|expect\(|Error:/.test(l)) ?? ''
      console.log(`  RED as expected at "${first.title}"`)
      console.log(`    ${line.trim()}`)
    }
  }
  if (!keep) {
    try { psql(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE);`, { db: 'postgres' }) } catch { /* best effort */ }
  }
  process.exit(failed ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  stopPostgrest()
  process.exit(2)
})
