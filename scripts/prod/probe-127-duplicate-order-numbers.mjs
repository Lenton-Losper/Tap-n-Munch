/**
 * #127 / #324 — WHAT ACTUALLY BLOCKS THE UNIQUE INDEX. PRODUCTION, READ ONLY.
 *
 * ============================================================================================
 * WHY THIS RE-DERIVES A SPLIT THAT IS ALREADY WRITTEN DOWN
 * ============================================================================================
 *
 * #127's record says the 282 duplicate (firebase_restaurant_id, order_number) pairs blocking
 * `20260809120000_orders_unique_order_number.sql` are 279 all-fixture groups, 4 all-real groups,
 * and ZERO mixed. That zero is the entire safety argument for #324's delete: if one group held a
 * fixture AND a real order, deleting the fixtures would leave a real order behind whose number
 * once collided, and the delete would be silently reshaping real order history.
 *
 * A claim of "zero of the dangerous kind" is exactly the claim that gets shipped without being
 * re-derived. So it is re-derived here, from the database, in one statement, with the mixed count
 * printed as a first-class number rather than as an absence.
 *
 * ============================================================================================
 * THE TWO CANDIDATE SCOPES, AND WHY BOTH ARE MEASURED
 * ============================================================================================
 *
 * There are two plausible keys for the index and they are NOT blocked by the same rows:
 *
 *   (firebase_restaurant_id, order_number)  <- what the committed migration uses
 *   (restaurant_id, order_number)           <- what #127's comments measure
 *
 * Every one of #324's 1315 fixture rows has `restaurant_id IS NULL` and a
 * `firebase_restaurant_id` of `restaurant_test_NN`. Postgres treats NULLs as distinct in a unique
 * index, so the fixtures CANNOT collide on the restaurant_id key and DO collide on the firebase
 * one. Which scope is chosen therefore decides whether #324 is a prerequisite at all — and that
 * is not a detail either issue records.
 *
 * Both are counted, side by side, so the choice is made against numbers instead of against the
 * migration header's reasoning.
 *
 * ============================================================================================
 * NO WRITES
 * ============================================================================================
 *
 * Every statement is a SELECT. Nothing is deleted, renumbered, or repaired: #324's delete is the
 * owner's to run and the four real duplicates are live financial records. This script's job is to
 * let a human see the numbers before authorising either.
 *
 *   NODE_OPTIONS=--no-network-family-autoselection node scripts/prod/probe-127-duplicate-order-numbers.mjs
 *
 * Without that NODE_OPTIONS every connection ETIMEDOUTs on this network (happy-eyeballs).
 */
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

/*
 * `pg` is not a dependency of this repo. Resolve it from wherever it actually is rather than from
 * a hard-coded path — scripts/prod/probe-245 pins an absolute temp directory that has since been
 * deleted, which is a script that cannot be re-run by the person it was written for.
 *
 * PG_MODULE_PATH lets the operator point at any directory that has `pg` installed. Otherwise the
 * repo is tried, and the failure names the fix instead of throwing MODULE_NOT_FOUND.
 */
function loadPgClient() {
  const candidates = [process.env.PG_MODULE_PATH, process.cwd()].filter(Boolean)
  for (const dir of candidates) {
    try {
      const req = createRequire(pathToFileURL(`${dir}/`).href)
      return req('pg').Client
    } catch {
      /* try the next one */
    }
  }
  console.error(
    'Cannot load `pg`. It is not a dependency of this repo.\n' +
      '  npm i --no-save pg      (then re-run from the repo root)\n' +
      '  or: PG_MODULE_PATH=/path/to/a/dir/with/node_modules/pg node scripts/prod/probe-127-duplicate-order-numbers.mjs',
  )
  process.exit(1)
}
const Client = loadPgClient()

/*
 * The password comes from .env.local, which is where the production DB password actually lives —
 * the inventory's claim that it is a GitHub secret only is wrong. Read directly rather than via
 * dotenv so a stale value in the process environment cannot win silently.
 */
const ENV_FILE = process.env.FLASHTAP_ENV_FILE || 'C:/Users/223125318/Desktop/mvp/restaurant-menu-screen/.env.local'
const secret = (name) => {
  if (!existsSync(ENV_FILE)) {
    console.error(`Cannot read ${ENV_FILE}. Set FLASHTAP_ENV_FILE to the .env.local holding SUPABASE_DB_PASSWORD_PROD.`)
    process.exit(1)
  }
  for (const line of readFileSync(ENV_FILE, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/)
    if (m && m[1] === name) return m[2].trim().replace(/^["']|["']$/g, '')
  }
  return ''
}

/**
 * The stress-fixture predicate, character-for-character `STRESS_FIXTURE_EXCLUSION_SQL` negated.
 *
 * THIS IS NULL, NOT FALSE, FOR THE ONE ROW THAT HAS NEITHER COLUMN. Production carries exactly one
 * order with `restaurant_id IS NULL` AND `firebase_restaurant_id IS NULL`: `NULL LIKE '...'` is
 * NULL, so `TRUE AND NULL` is NULL and `NOT NULL` is NULL. That row is counted by NEITHER a
 * `FILTER (WHERE IS_FIXTURE)` nor a `FILTER (WHERE NOT IS_FIXTURE)`, so the two halves silently do
 * not sum to the total — which is exactly the trap `lib/orders/stress-fixtures.ts` documents, and
 * which the first run of this script fell into.
 *
 * Every use below is therefore wrapped in `IS TRUE` / `IS NOT TRUE`, and section 0 prints the
 * reconciliation so a future missing row is visible rather than absorbed.
 */
const IS_FIXTURE_RAW = `(restaurant_id IS NULL AND firebase_restaurant_id LIKE 'restaurant_test_%')`
const IS_FIXTURE = `(${IS_FIXTURE_RAW} IS TRUE)`
const NOT_FIXTURE = `(${IS_FIXTURE_RAW} IS NOT TRUE)`

const PROD = {
  label: 'PRODUCTION (ihlmmpmolnpchzgwyhgh)',
  host: 'aws-0-eu-west-1.pooler.supabase.com',
  port: 5432,
  user: 'postgres.ihlmmpmolnpchzgwyhgh',
  password: secret('SUPABASE_DB_PASSWORD_PROD'),
  database: 'postgres',
  ssl: { rejectUnauthorized: false },
}

const rule = (t) => console.log(`\n${'='.repeat(90)}\n${t}\n${'='.repeat(90)}`)

/**
 * One duplicate-group census over a chosen scope column.
 *
 * `rows` is how many orders share the pair; `blocking` is rows-1, the number that would have to
 * disappear or be renumbered before CREATE UNIQUE INDEX succeeds.
 */
const censusSql = (scopeColumn) => `
  WITH g AS (
    SELECT ${scopeColumn} AS scope, order_number,
           count(*)::int AS rows,
           count(*) FILTER (WHERE ${IS_FIXTURE})::int AS fixture_rows
    FROM public.orders
    WHERE ${scopeColumn} IS NOT NULL AND order_number IS NOT NULL
    GROUP BY 1, 2
    HAVING count(*) > 1
  )
  SELECT
    count(*)::int                                                              AS groups,
    coalesce(sum(rows), 0)::int                                                AS rows_total,
    coalesce(sum(rows - 1), 0)::int                                            AS blocking_total,
    count(*) FILTER (WHERE fixture_rows = rows)::int                           AS fixture_groups,
    coalesce(sum(rows - 1) FILTER (WHERE fixture_rows = rows), 0)::int         AS fixture_blocking,
    count(*) FILTER (WHERE fixture_rows = 0)::int                              AS real_groups,
    coalesce(sum(rows - 1) FILTER (WHERE fixture_rows = 0), 0)::int            AS real_blocking,
    count(*) FILTER (WHERE fixture_rows > 0 AND fixture_rows < rows)::int      AS mixed_groups,
    coalesce(sum(rows) FILTER (WHERE fixture_rows > 0 AND fixture_rows < rows), 0)::int AS mixed_rows
  FROM g`

async function main() {
  const db = new Client(PROD)
  await db.connect()
  const q = async (sql, params = []) => (await db.query(sql, params)).rows

  const [{ ref }] = await q(`SELECT current_setting('cluster_name', true) AS ref`)
  console.log(`connected: ${PROD.label}   cluster_name=${ref ?? '(unset)'}   user=${PROD.user}`)
  console.log('READ ONLY — every statement below is a SELECT.')

  // ------------------------------------------------------------------------------------------
  rule('0. POPULATION — and the denominator this whole issue is measured against')
  const [pop] = await q(`
    SELECT count(*)::int total,
           count(*) FILTER (WHERE ${IS_FIXTURE})::int fixtures,
           count(*) FILTER (WHERE ${NOT_FIXTURE})::int real,
           count(*) FILTER (WHERE restaurant_id IS NULL)::int null_rid,
           count(*) FILTER (WHERE restaurant_id IS NULL AND ${NOT_FIXTURE})::int null_rid_not_fixture,
           count(*) FILTER (WHERE ${IS_FIXTURE} AND order_number IS NOT NULL)::int fixtures_numbered,
           count(*) FILTER (WHERE firebase_restaurant_id IS NULL)::int no_firebase,
           count(*) FILTER (WHERE restaurant_id IS NULL AND firebase_restaurant_id IS NULL)::int both_null,
           count(*) FILTER (WHERE order_number IS NULL)::int no_number
    FROM public.orders`)
  console.log(`  orders rows                                     : ${pop.total}`)
  console.log(`  #324 stress fixtures                            : ${pop.fixtures}`)
  console.log(`  real orders                                     : ${pop.real}`)
  console.log(`  RECONCILIATION fixtures + real                  : ${pop.fixtures + pop.real}` +
    `  ${pop.fixtures + pop.real === pop.total ? '== total' : `*** ${pop.total - pop.fixtures - pop.real} ROW(S) IN NEITHER HALF ***`}`)
  console.log(`  restaurant_id IS NULL                           : ${pop.null_rid}`)
  console.log(`    of which NOT a fixture (must survive a delete): ${pop.null_rid_not_fixture}`)
  console.log(`  fixtures carrying an order_number               : ${pop.fixtures_numbered}`)
  console.log(`  rows with no firebase_restaurant_id             : ${pop.no_firebase}`)
  console.log(`  rows with BOTH ids NULL (the 3VL row)           : ${pop.both_null}`)
  console.log(`  rows with no order_number                       : ${pop.no_number}`)

  const bothNull = await q(`
    SELECT id, order_number, total, status, payment_status, channel, placed_at
    FROM public.orders WHERE restaurant_id IS NULL AND firebase_restaurant_id IS NULL`)
  for (const r of bothNull) {
    console.log(`    -> ${r.id}  #${r.order_number}  total=${r.total}  ${r.status}/${r.payment_status}` +
      `  channel=${r.channel}  ${r.placed_at?.toISOString?.() ?? r.placed_at}`)
    console.log('       Not a fixture, not deletable by #324, and invisible to a naive NOT(...) filter.')
  }

  // ------------------------------------------------------------------------------------------
  rule('1. THE SPLIT — duplicate groups on each candidate scope, partitioned fixture / real / MIXED')
  for (const scope of ['firebase_restaurant_id', 'restaurant_id']) {
    const [c] = await q(censusSql(scope))
    console.log(`\n  (${scope}, order_number)   -- ${
      scope === 'firebase_restaurant_id' ? 'the committed migration key' : 'the key #127 comments measure'
    }`)
    console.log(`    duplicate groups                     : ${c.groups}`)
    console.log(`    rows inside them                     : ${c.rows_total}`)
    console.log(`    blocking rows (rows - 1 per group)   : ${c.blocking_total}`)
    console.log(`      all rows are #324 fixtures         : ${c.fixture_groups} groups, ${c.fixture_blocking} blocking`)
    console.log(`      all rows are real orders           : ${c.real_groups} groups, ${c.real_blocking} blocking`)
    console.log(`      *** MIXED ***                      : ${c.mixed_groups} groups, ${c.mixed_rows} rows`)
    if (c.mixed_groups > 0) {
      console.log('    !!! A MIXED GROUP EXISTS. #324\'s delete would reshape real order history. STOP.')
    }
  }

  // ------------------------------------------------------------------------------------------
  rule('2. THE MIXED GROUPS, if any — listed rather than asserted absent')
  const mixed = await q(`
    WITH g AS (
      SELECT firebase_restaurant_id AS fid, order_number AS num, count(*) AS rows,
             count(*) FILTER (WHERE ${IS_FIXTURE}) AS fixture_rows
      FROM public.orders
      WHERE firebase_restaurant_id IS NOT NULL AND order_number IS NOT NULL
      GROUP BY 1,2 HAVING count(*) > 1
    )
    SELECT o.id, o.firebase_restaurant_id, o.restaurant_id, o.order_number, o.total, o.placed_at,
           (o.restaurant_id IS NULL AND o.firebase_restaurant_id LIKE 'restaurant_test_%') IS TRUE AS is_fixture
    FROM public.orders o
    JOIN g ON g.fid = o.firebase_restaurant_id AND g.num = o.order_number
    WHERE g.fixture_rows > 0 AND g.fixture_rows < g.rows
    ORDER BY o.firebase_restaurant_id, o.order_number, o.placed_at`)
  if (mixed.length === 0) console.log('  none — the two populations are cleanly separable.')
  for (const r of mixed) {
    console.log(`  ${r.firebase_restaurant_id} #${r.order_number}  fixture=${r.is_fixture}  ${r.id}  ${r.placed_at}`)
  }

  // ------------------------------------------------------------------------------------------
  rule('3. AFTER #324 — the same census with the fixture rows simulated away (nothing deleted)')
  for (const scope of ['firebase_restaurant_id', 'restaurant_id']) {
    const [c] = await q(`
      WITH survivors AS (SELECT * FROM public.orders WHERE ${NOT_FIXTURE}),
      g AS (
        SELECT ${scope} AS scope, order_number, count(*)::int rows
        FROM survivors
        WHERE ${scope} IS NOT NULL AND order_number IS NOT NULL
        GROUP BY 1,2 HAVING count(*) > 1
      )
      SELECT count(*)::int groups, coalesce(sum(rows - 1), 0)::int blocking FROM g`)
    console.log(`  (${scope.padEnd(22)}, order_number) : ${c.groups} groups, ${c.blocking} blocking rows remain`)
  }

  // ------------------------------------------------------------------------------------------
  rule('4. THE REAL DUPLICATES — every row, with what a renumber would have to carry')
  const real = await q(`
    WITH g AS (
      SELECT restaurant_id, order_number
      FROM public.orders
      WHERE restaurant_id IS NOT NULL AND order_number IS NOT NULL
      GROUP BY 1,2 HAVING count(*) > 1
    )
    SELECT r.name AS venue, o.id, o.order_number, o.total, o.status, o.payment_status,
           o.channel, o.placed_at, o.paid_at, o.table_number, o.tab_id, o.customer_name,
           o.kiosk_order_number, o.idempotency_key, o.source_request_id,
           (SELECT count(*)::int FROM public.payments p WHERE p.order_ids @> ARRAY[o.id]) AS payments,
           (SELECT count(*)::int FROM public.receipt_documents rc WHERE rc.order_id = o.id) AS receipts,
           (SELECT count(*)::int FROM public.payment_events pe WHERE pe.order_ids @> ARRAY[o.id]) AS payment_events,
           (SELECT count(*)::int FROM public.order_requests orq WHERE orq.accepted_order_id = o.id) AS requests,
           (SELECT string_agg(rc.document_type || ' ' || rc.document_number, ', ')
              FROM public.receipt_documents rc WHERE rc.order_id = o.id) AS documents
    FROM public.orders o
    JOIN g ON g.restaurant_id = o.restaurant_id AND g.order_number = o.order_number
    LEFT JOIN public.restaurants r ON r.id = o.restaurant_id
    ORDER BY o.restaurant_id, o.order_number, o.placed_at`)
  let previous = null
  for (const r of real) {
    const key = `${r.venue}|${r.order_number}`
    if (key !== previous) {
      console.log(`\n  ${r.venue} — order_number ${r.order_number}`)
      previous = key
    }
    console.log(
      `    ${r.id}  ${r.placed_at?.toISOString?.() ?? r.placed_at}` +
        `  total=${r.total}  ${r.status}/${r.payment_status}  channel=${r.channel}` +
        `  table=${r.table_number}  tab=${r.tab_id ? 'yes' : 'no'}` +
        `  payments=${r.payments} receipt_docs=${r.receipts} payment_events=${r.payment_events}` +
        ` accepted_by_requests=${r.requests}` +
        `  idem=${r.idempotency_key ?? 'null'}  src_req=${r.source_request_id ?? 'null'}`,
    )
    if (r.documents) console.log(`        issued documents: ${r.documents}`)
  }
  const [{ n: realGroups }] = await q(`
    SELECT count(*)::int n FROM (
      SELECT 1 FROM public.orders
      WHERE restaurant_id IS NOT NULL AND order_number IS NOT NULL
      GROUP BY restaurant_id, order_number HAVING count(*) > 1) x`)
  console.log(`\n  ${realGroups} real duplicate groups, ${real.length} rows.`)

  // ------------------------------------------------------------------------------------------
  rule('5. IS THE PAIR SAME-SECOND? — the race signature, and the gap between the two writes')
  const gaps = await q(`
    WITH g AS (
      SELECT restaurant_id, order_number
      FROM public.orders
      WHERE restaurant_id IS NOT NULL AND order_number IS NOT NULL
      GROUP BY 1,2 HAVING count(*) > 1
    )
    SELECT r.name venue, o.order_number,
           min(o.placed_at) first_at, max(o.placed_at) last_at,
           extract(epoch FROM (max(o.placed_at) - min(o.placed_at))) * 1000 AS gap_ms,
           count(DISTINCT o.total)::int distinct_totals,
           count(*)::int rows
    FROM public.orders o
    JOIN g ON g.restaurant_id = o.restaurant_id AND g.order_number = o.order_number
    LEFT JOIN public.restaurants r ON r.id = o.restaurant_id
    GROUP BY 1,2 ORDER BY 3`)
  for (const r of gaps) {
    console.log(
      `  ${String(r.venue).padEnd(16)} #${String(r.order_number).padEnd(6)} rows=${r.rows}` +
        `  gap=${Number(r.gap_ms).toFixed(0)}ms  distinct totals=${r.distinct_totals}  first=${r.first_at?.toISOString?.() ?? r.first_at}`,
    )
  }

  // ------------------------------------------------------------------------------------------
  rule('6. WHAT A RENUMBER WOULD HAVE TO CARRY — every column in the schema named like an order number')
  const cols = await q(`
    SELECT table_schema, table_name, column_name, data_type
    FROM information_schema.columns
    WHERE table_schema IN ('public')
      AND (column_name LIKE '%order_number%' OR column_name LIKE '%order_no%')
    ORDER BY table_name, column_name`)
  for (const c of cols) console.log(`  ${c.table_name}.${c.column_name}  ${c.data_type}`)

  // ------------------------------------------------------------------------------------------
  rule('7. THE HIGH-WATER MARK — is count(*)+1 even right single-threaded?')
  const hw = await q(`
    SELECT r.name venue, count(*)::int rows, max(o.order_number)::int max_number,
           count(*) FILTER (WHERE o.order_number IS NOT NULL)::int numbered,
           max(o.order_number)::int - count(*) FILTER (WHERE o.order_number IS NOT NULL)::int AS max_minus_count
    FROM public.orders o
    JOIN public.restaurants r ON r.id = o.restaurant_id
    WHERE o.restaurant_id IS NOT NULL
    GROUP BY 1 HAVING count(*) FILTER (WHERE o.order_number IS NOT NULL) > 0
    ORDER BY 3 DESC NULLS LAST`)
  console.log('  A positive max-minus-count means count(*)+1 will re-issue a number ALREADY IN USE.')
  for (const r of hw) {
    console.log(
      `  ${String(r.venue).padEnd(22)} rows=${String(r.rows).padEnd(6)} numbered=${String(r.numbered).padEnd(6)}` +
        ` max=${String(r.max_number).padEnd(6)} max-count=${r.max_minus_count > 0 ? '+' : ''}${r.max_minus_count}`,
    )
  }

  // ------------------------------------------------------------------------------------------
  rule('8. THE OTHER UNPROTECTED NUMBER — kiosk_order_number, daily count(*) with the same race')
  const kiosk = await q(`
    SELECT count(*)::int groups, coalesce(sum(rows - 1), 0)::int blocking FROM (
      SELECT count(*)::int rows FROM public.orders
      WHERE restaurant_id IS NOT NULL AND kiosk_order_number IS NOT NULL
      GROUP BY restaurant_id, (placed_at AT TIME ZONE 'UTC')::date, kiosk_order_number
      HAVING count(*) > 1) x`)
  const [{ n: kioskRows }] = await q(
    `SELECT count(*)::int n FROM public.orders WHERE kiosk_order_number IS NOT NULL`)
  console.log(`  rows carrying a kiosk_order_number      : ${kioskRows}`)
  console.log(`  duplicate (restaurant, day, kiosk#)     : ${kiosk[0].groups} groups, ${kiosk[0].blocking} blocking`)
  if (kioskRows === 0) {
    console.log('  ZERO ROWS — a zero duplicate count here proves nothing about the race. No kiosk order')
    console.log('  has ever been numbered in production, so this is an untested path, not a safe one.')
  }

  // ------------------------------------------------------------------------------------------
  rule('9. EXISTING UNIQUE INDEXES ON orders — is 20260809120000 there?')
  const idx = await q(`
    SELECT i.relname AS index_name, pg_get_indexdef(ix.indexrelid) AS def
    FROM pg_index ix
    JOIN pg_class i ON i.oid = ix.indexrelid
    WHERE ix.indrelid = 'public.orders'::regclass AND ix.indisunique
    ORDER BY 1`)
  for (const r of idx) console.log(`  ${r.index_name}\n      ${r.def}`)
  const has127 = idx.some((r) => /firebase_restaurant_id.*order_number|order_number.*firebase/.test(r.def))
  console.log(`\n  (firebase_restaurant_id, order_number) unique index present: ${has127 ? 'YES' : 'NO'}`)
  console.log('  CONTROL: the list above is non-empty, so a NO is an absence and not a broken query.')

  // ------------------------------------------------------------------------------------------
  rule('10. THE SCOPE QUESTION — are the two candidate keys equivalent for real rows?')
  const [scopeCheck] = await q(`
    SELECT
      (SELECT count(*)::int FROM (
         SELECT firebase_restaurant_id FROM public.orders
         WHERE ${NOT_FIXTURE} AND firebase_restaurant_id IS NOT NULL AND restaurant_id IS NOT NULL
         GROUP BY firebase_restaurant_id HAVING count(DISTINCT restaurant_id) > 1) x)
        AS firebase_ids_spanning_two_restaurants,
      (SELECT count(*)::int FROM (
         SELECT restaurant_id FROM public.orders
         WHERE ${NOT_FIXTURE} AND firebase_restaurant_id IS NOT NULL AND restaurant_id IS NOT NULL
         GROUP BY restaurant_id HAVING count(DISTINCT firebase_restaurant_id) > 1) x)
        AS restaurants_with_two_firebase_ids,
      (SELECT count(*)::int FROM public.orders
         WHERE ${NOT_FIXTURE} AND restaurant_id IS NOT NULL AND firebase_restaurant_id IS NULL)
        AS real_rows_with_no_firebase_id,
      (SELECT count(*)::int FROM public.orders
         WHERE ${NOT_FIXTURE} AND restaurant_id IS NULL AND firebase_restaurant_id IS NOT NULL)
        AS real_rows_with_no_restaurant_id`)
  console.log(`  firebase ids spanning >1 restaurant_id : ${scopeCheck.firebase_ids_spanning_two_restaurants}`)
  console.log(`  restaurant_ids with >1 firebase id     : ${scopeCheck.restaurants_with_two_firebase_ids}`)
  console.log(`  real rows with restaurant_id but NO firebase id : ${scopeCheck.real_rows_with_no_firebase_id}`)
  console.log(`  real rows with firebase id but NO restaurant_id : ${scopeCheck.real_rows_with_no_restaurant_id}`)
  console.log('  A firebase id spanning two restaurants would make the firebase-scoped index REJECT')
  console.log('  valid inserts. Real rows with no firebase id are rows a firebase-scoped partial')
  console.log('  index does not cover at all — the collision it exists to stop stays possible there.')

  // ------------------------------------------------------------------------------------------
  rule('11. DOES #324\'s DELETE MOVE ANY VENUE\'S ALLOCATION? — the obvious worry, measured')
  const allocation = await q(`
    SELECT firebase_restaurant_id fid,
           count(*)::int                                                     AS rows_now,
           count(*) FILTER (WHERE ${NOT_FIXTURE})::int                       AS rows_after,
           max(order_number)::int                                            AS max_now,
           max(order_number) FILTER (WHERE ${NOT_FIXTURE})::int              AS max_after
    FROM public.orders
    WHERE firebase_restaurant_id IS NOT NULL
    GROUP BY 1 ORDER BY 2 DESC`)
  console.log('  The old allocator is count(*)+1 scoped by firebase_restaurant_id, so a delete that')
  console.log('  removed rows from a REAL venue would make it re-issue a live number. Fixtures carry')
  console.log("  their own restaurant_test_NN ids, so they should not touch any real venue's count.")
  let moved = 0
  for (const r of allocation) {
    const isFixtureVenue = String(r.fid).startsWith('restaurant_test_')
    const changes = r.rows_now !== r.rows_after
    if (!isFixtureVenue && changes) moved += 1
    if (isFixtureVenue) continue
    console.log(
      `  ${String(r.fid).padEnd(38)} count+1 ${r.rows_now + 1} -> ${r.rows_after + 1}` +
        `   max+1 ${r.max_now + 1} -> ${r.max_after + 1}` +
        `   ${changes ? '*** MOVES ***' : 'unchanged'}`,
    )
  }
  console.log(`\n  real venues whose allocation the delete would move: ${moved}`)
  console.log('  CONTROL: the fixture venues ARE in this query and were skipped by name, so a zero')
  console.log('  above means the two populations do not share a scope — not that the query missed them.')

  await db.end()
}

main().catch((e) => {
  console.error('\nPROBE FAILED:', e.message)
  process.exit(1)
})
