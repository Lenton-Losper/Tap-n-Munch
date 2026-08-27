/**
 * A REVENUE-SHAPED READ OF `orders` THAT CANNOT BE NARROWED TO A VENUE MUST EXCLUDE THE STRESS
 * FIXTURES, OR ITS NUMBER IS WRONG BY UP TO 37% AND LOOKS FINE.
 *
 * Static, no credentials, no database. Blocking in CI, same class as
 * scripts/check-orders-read-bounded.ts, whose chain-walking machinery this deliberately reuses in
 * shape so the two behave identically on the same file.
 *
 * ============================================================================================
 * WHY THIS EXISTS -- #324
 * ============================================================================================
 *
 * Production's `orders` table holds 3,522 rows. 1,314 of them are stress-test fixtures from one
 * seeding run: `restaurant_id IS NULL`, `firebase_restaurant_id` of `restaurant_test_02`..`_10`,
 * `total = 0`, never paid. Measured read-only on 2026-08-27 and unchanged since #324 was filed.
 *
 * They are 37.3% of the table, and they have already produced two wrong answers that were acted
 * on: the "876 broken QR orders" finding (all 876 were fixtures; the real population is fifteen)
 * and #281's "282 duplicate order-number pairs" (279 of 283 groups were fixtures), which is the
 * number that scoped #127's unique index away from production.
 *
 * `lib/orders/stress-fixtures.ts` states the exclusion once and the platform paths import it. That
 * is a mitigation, not a fix: IT IS A CONVENTION REPEATED AT EACH CALL SITE AND ENFORCED BY
 * NOTHING. The next person to write a cross-venue revenue query will not know it exists, and the
 * failure is silent -- a plausible number, not an error.
 *
 * THIS FILE IS THE ENFORCEMENT. It catches the NEXT one, which is the point; the ones that exist
 * today are already fixed and are what its self-test is calibrated against.
 *
 * ============================================================================================
 * WHAT IS AND IS NOT A FINDING, AND WHY THE LINE IS DRAWN THERE
 * ============================================================================================
 *
 * A finding needs BOTH halves:
 *
 *   1. THE READ CAN REACH A FIXTURE. Any read narrowed by `restaurant_id`, `id`, `tab_id`,
 *      `table_id`, a session id or a payment reference cannot: a fixture's `restaurant_id` is
 *      NULL, and NULL never equals a uuid. Of the order-table call sites in app/ and lib/, the
 *      large majority are scoped that way, and flagging them would bury the handful that matter.
 *
 *   2. THE READ PRODUCES A MEASUREMENT. A count, a sum, or a ratio -- `count: 'exact'`, a select
 *      naming a money column (`total`, `subtotal`, `tax`), or a result that is `.length`-ed,
 *      `.reduce`-d or divided. An unscoped read that fetches one row to display is a different
 *      problem (that was the platform-search defect, already fixed at 6c777e3d) and it is REPORTED
 *      by `--report` without failing the build, because a check that fires on things nobody will
 *      fix is a check people learn to skip.
 *
 * `--report` prints the verdict for EVERY unscoped read, findings and not, which is the #324
 * blast-radius table. The default run fails only on half-1-and-half-2.
 *
 * ============================================================================================
 * THE SATISFACTION RULE, AND THE FAILURE MODE IT IS SHAPED AROUND
 * ============================================================================================
 *
 * A read satisfies the guard in one of three ways:
 *
 *   (a) the builder is wrapped in `excludeStressFixtures(...)` -- the PostgREST route;
 *   (b) the chain passes `STRESS_FIXTURE_EXCLUSION_OR` to `.or()` -- the same thing, unwrapped;
 *   (c) the file imports a stress-fixture predicate AND THE SELECT NAMES BOTH `restaurant_id` AND
 *       `firebase_restaurant_id` -- the in-memory route, which is how every probe under
 *       scripts/prod/ does it.
 *
 * THE SECOND HALF OF (c) IS THE WHOLE VALUE OF (c). `measure-customer-wait-20260825.ts` imported
 * the predicate, applied it to every row, selected thirteen columns WITHOUT
 * `firebase_restaurant_id`, and therefore read `undefined` for every row, called every row real,
 * and printed `stress fixtures excluded: 0 of 3516` beside exactly the same wrong figure it
 * printed before the exclusion was added. An absent filter is visible. A filter that runs, reports
 * zero and changes nothing reads as CONFIRMATION THAT THE DATA IS CLEAN, and it fails in the
 * reassuring direction, which is the direction nobody re-derives.
 *
 * The helper now throws on a missing column, so that specific script fails loudly at runtime. This
 * check is the same rule applied where it costs nothing: at the select, before the query is ever
 * run, in CI, on a file nobody has executed yet.
 *
 * ============================================================================================
 * SCOPE OF THE SCAN
 * ============================================================================================
 *
 * The fixtures are a PRODUCTION population. Staging does not carry them, so a staging-only probe
 * cannot be wrong because of them. The scan therefore covers the runtime tree (app, lib,
 * components, hooks -- all of which serve production) plus the scripts that read production:
 * everything under `scripts/prod/`, and any script whose filename says `production`. Widening it
 * to all of `scripts/` would add ~120 staging one-offs that cannot exhibit the defect.
 *
 * Usage:
 *   node ./node_modules/tsx/dist/cli.mjs scripts/check-orders-fixture-excluded.ts
 *   node ./node_modules/tsx/dist/cli.mjs scripts/check-orders-fixture-excluded.ts --report
 */
import { readdirSync, readFileSync, statSync } from 'fs'
import { join, relative, sep } from 'path'

const ROOT = process.cwd()
const EXTS = ['.ts', '.tsx', '.mjs', '.js']

/** The runtime tree. Every file here serves production. */
const RUNTIME_DIRS = ['app', 'components', 'lib', 'hooks']

/** Scripts that read production. `scripts/prod/` wholesale, plus `*production*` elsewhere. */
const PRODUCTION_SCRIPT_DIR = 'scripts/prod'
const PRODUCTION_SCRIPT_NAME = /production/i

const TABLE = 'orders'

/**
 * Columns whose equality (or `.in()`) ties a read to a tenant or a single record.
 *
 * A fixture carries `restaurant_id IS NULL`, so a filter on any of these cannot return one --
 * except `firebase_restaurant_id`, which fixtures DO carry. It is listed because a query scoped to
 * a NAMED venue's firebase id is still tenant-scoped; the danger there is a query scoped to a
 * LITERAL `restaurant_test_...`, which is handled below.
 *
 * `order_number` IS DELIBERATELY ABSENT. It is not narrowing: the fixtures occupy order numbers
 * 1..146 with up to 45 rows on a single number, and a platform search by order number alone
 * returned 8 fixtures in a page of 10. That is the defect this table would have hidden.
 */
const TENANT_COLUMNS = [
  'restaurant_id',
  'firebase_restaurant_id',
  'id',
  'tab_id',
  'table_id',
  'session_id',
  'member_session_id',
  'edit_lock_session_id',
  'tab_settlement_for_tab_id',
  'firebase_id',
  'idempotency_key',
  'source_request_id',
  'paycloud_merchant_order_no',
  'paycloud_transaction_id',
  'payment_reference',
  'payment_trans_no',
  'payment_voucher_no',
]

/**
 * ============================================================================================
 * THE FIXTURE VALUE SIGNATURE, MEASURED READ-ONLY ON PRODUCTION 2026-08-27
 * ============================================================================================
 *
 * All 1,314 rows, tallied column by column. They were written by one run of
 * `flashtap-stress-test.js` on 2026-04-27 and NOTHING WRITES TO THEM — no code path can reach a
 * NULL-restaurant row to update it — so this signature is frozen, not a snapshot of live data.
 *
 *     status          completed  1314
 *     payment_status  cancelled   876 | cash_pending  438
 *     channel         table      1314
 *     payment_method  card        876 | cash          438
 *     total           0          1314
 *     always NULL     paid_at, tab_id, payment_reference, payment_voucher_no,
 *                     paycloud_merchant_order_no, paycloud_transaction_id, payment_trans_no,
 *                     payment_attempt_started_at, source_request_id
 *
 * WHY THIS IS IN A CHECKER AT ALL, GIVEN #324 SAYS NOT TO RELY ON IT. The issue's point is that
 * "unreachable today" is a property of the current code and must not be mistaken for a property
 * of the table. That is a rule about what you may CONCLUDE, not about what a checker may SEE. A
 * query that pins `payment_status` to 'paid' provably returns no fixture, and reporting it as an
 * unguarded revenue read would be false — and a checker that is wrong about correct code is one
 * people learn to skip, which is how the next real one gets through.
 *
 * So these reads get their own verdict, UNREACHABLE-BY-VALUE. They never fail the build, they are
 * always listed by --report, and the verdict says out loud that they are safe because of a filter
 * rather than because of a guard. Delete that filter and the site turns red, which is the correct
 * behaviour and the reason this is a rule rather than an allowance.
 */
const FIXTURE_VALUES: Record<string, string[]> = {
  status: ['completed'],
  payment_status: ['cancelled', 'cash_pending'],
  channel: ['table'],
  payment_method: ['card', 'cash'],
}

/** Columns every fixture leaves NULL, so `.not(col, 'is', null)` cannot return one. */
const FIXTURE_ALWAYS_NULL = [
  'paid_at',
  'tab_id',
  'payment_reference',
  'payment_voucher_no',
  'paycloud_merchant_order_no',
  'paycloud_transaction_id',
  'payment_trans_no',
  'payment_attempt_started_at',
  'source_request_id',
]

/** Money and measure columns. A select naming one of these is summing something. */
const MEASURE_COLUMNS = ['total', 'subtotal', 'tax', 'total_before_edit']

/** Anything exported from lib/orders/stress-fixtures.ts. */
const FIXTURE_HELPERS = [
  'excludeStressFixtures',
  'isStressFixtureOrder',
  'withoutStressFixtures',
  'countStressFixtures',
  'STRESS_FIXTURE_EXCLUSION_OR',
  'STRESS_FIXTURE_EXCLUSION_SQL',
  'STRESS_FIXTURE_FIREBASE_PREFIX',
]

/** The two columns an in-memory predicate cannot work without. Mirrors STRESS_FIXTURE_REQUIRED_COLUMNS. */
const PREDICATE_COLUMNS = ['restaurant_id', 'firebase_restaurant_id']

/**
 * The file that DEFINES the rule, and the file that VERIFIES it against production by deliberately
 * running the unguarded query beside the guarded one. Neither can be asked to guard itself.
 *
 * Kept as a Map with a reason rather than a bare list, and STALE ENTRIES ARE REPORTED: an
 * allowance whose file has moved is exactly where the next real offender hides.
 */
const ALLOWED_FILES = new Map<string, string>([
  [
    'lib/orders/auto-cancel-stale-pos-orders.ts',
    'PAYMENT WRITE PATH -- not edited. Both reads pin payment_status to a value no fixture ' +
      "carries: measured read-only on production 2026-08-27, `payment_status='pending'` reaches " +
      "0 fixtures of 21 rows and `verification_unavailable_hold` reaches 0 of 0. Every fixture is " +
      "payment_status 'cancelled' (876) or 'cash_pending' (438), status 'completed', total 0",
  ],
  [
    'scripts/prod/renumber-127-duplicate-orders.ts',
    "#127's prepared --confirm write script, not edited. It pages the whole table on purpose and " +
      'partitions in memory on `restaurant_id != null && order_number != null`; #324 measured zero ' +
      'MIXED duplicate groups, so no real order shares a pair with a fixture',
  ],
  [
    'scripts/prod/probe-324-orphan-orders.ts',
    "#324's own probe -- counting the fixtures IS its subject",
  ],
  [
    'scripts/prod/delete-324-orphan-orders.ts',
    'selects the fixtures in order to delete them',
  ],
])

/*
 * TWO FILES THAT LOOK LIKE THEY BELONG ABOVE AND DO NOT, recorded so nobody adds them back:
 *
 *   scripts/prod/probe-fixture-reachability-20260826.ts
 *   scripts/prod/verify-stress-fixture-exclusion-20260826.ts
 *
 * Both deliberately run the UNGUARDED query -- the second one as the control its guarded query is
 * compared against, which is the only way to tell a working filter from a dead one. They were in
 * the map, and the stale-allowance report is what removed them: the scan already classifies both
 * correctly on their own merits, so the entries were exempting nothing and would have exempted a
 * real finding the day one appeared.
 */

type Verdict =
  | 'FINDING'
  | 'GUARDED'
  | 'GUARDED-BY-HAND'
  | 'UNREACHABLE-BY-VALUE'
  | 'SCOPED'
  | 'NOT-A-MEASUREMENT'
  | 'WRITE'
  | 'ALLOWED'

type Site = {
  file: string
  line: number
  verdict: Verdict
  why: string
  text: string
}

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return out
  }
  for (const entry of entries) {
    if (entry === 'node_modules' || entry === '.next' || entry.startsWith('.')) continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (EXTS.some((ext) => entry.endsWith(ext))) out.push(full)
  }
  return out
}

/** Walk backwards to the first line that starts a statement, so `let q = supabase` is seen. */
function statementStart(lines: string[], index: number): number {
  let i = index
  while (i > 0 && /^\s*[.)]/.test(lines[i])) i--
  return i
}

/**
 * Collect the chain forward from a statement start, tracking BRACKET DEPTH rather than guessing
 * from how each line begins -- and absorbing comment lines inside the chain, both for the reasons
 * recorded at length in check-orders-read-bounded.ts. A prefix heuristic truncates on a multi-line
 * `.select( '...', { count: 'exact' } )`, which is precisely the argument this check reads.
 */
function chainFrom(lines: string[], start: number): string {
  const parts: string[] = []
  let depth = 0
  for (let i = start; i < lines.length && i < start + 80; i++) {
    const line = lines[i]
    parts.push(line)
    for (const ch of line) {
      if (ch === '(' || ch === '[' || ch === '{') depth++
      else if (ch === ')' || ch === ']' || ch === '}') depth--
    }
    if (depth > 0) continue
    let k = i + 1
    while (k < lines.length && /^\s*(\/\/|\/\*|\*)/.test(lines[k])) k++
    const next = lines[k]
    if (next === undefined || !/^\s*\./.test(next)) break
    for (let c = i + 1; c < k; c++) parts.push(lines[c])
    i = k - 1
  }
  return parts.join(' ')
}

/** The `.select(...)` argument of a chain, as raw text. Empty when the chain has none. */
function selectArgument(flat: string): string {
  const at = flat.indexOf('.select(')
  if (at < 0) return ''
  let depth = 0
  for (let i = at + '.select'.length; i < flat.length; i++) {
    if (flat[i] === '(') depth++
    else if (flat[i] === ')') {
      depth--
      if (depth === 0) return flat.slice(at + '.select('.length, i)
    }
  }
  return flat.slice(at)
}

/**
 * Every string literal in the declaration of `const IDENT = ...`, as one blob.
 *
 * FOUR REAL CALL SITES ARE INVISIBLE WITHOUT THIS, and all four in the reassuring direction:
 *
 *   scripts/prod/probe-qr-cancelled-completed-20260826.ts   .select(COLS)          COLS is a const
 *   lib/payments/resolve-order-by-merchant-order.ts         .eq(column, mo)        for..of a const
 *
 * A literal-only reader sees `.select(COLS)` as a select naming no columns at all, and
 * `.eq(column, ...)` as a filter on no known column. Both then fall through to whatever the code
 * does when it cannot tell — which is the failure mode this whole file exists to remove.
 *
 * Deliberately crude: it takes the declaration line and the next few, and harvests quoted strings.
 * That is enough for a column list built by `'a,b,' + 'c,d'` and for a `['x', 'y'] as const`, and
 * it cannot be fooled into reporting MORE columns than are written down.
 */
function identifierLiterals(lines: string[], ident: string): string {
  const declRe = new RegExp(`(?:const|let|var)\\s+${ident}\\b`)
  for (let i = 0; i < lines.length; i++) {
    if (!declRe.test(lines[i])) continue
    const blob = lines.slice(i, i + 8).join(' ')
    return [...blob.matchAll(/'([^']*)'|"([^"]*)"/g)].map((m) => m[1] ?? m[2]).join(',')
  }
  return ''
}

/**
 * `.select('*')` NAMES EVERY COLUMN, INCLUDING BOTH THE PREDICATE NEEDS.
 *
 * `scripts/prod/probe-qr-15-real-orders-20260826.ts` does `.select('*')` and then filters with
 * `isStressFixtureOrder(o)`. That is correct and it works at runtime — but a reader that only
 * matches column NAMES sees no `restaurant_id`, decides the predicate cannot work, and reports a
 * correctly-guarded query as a finding. Crying wolf on correct code is how a check earns the habit
 * of being ignored, which is what lets the next real one through.
 */
function namesColumn(selectArg: string, column: string): boolean {
  if (/(^|[^a-z_])\*([^a-z_]|$)/.test(selectArg)) return true
  return new RegExp(`(^|[^a-z_])${column}([^a-z_]|$)`).test(selectArg)
}

export function sitesFor(rel: string, source: string): Site[] {
  const lines = source.split(/\r?\n/)
  const sites: Site[] = []

  const importsHelper = FIXTURE_HELPERS.some((h) =>
    new RegExp(`\\b${h}\\b`).test(source.replace(/\.from\(/g, '')),
  )

  const fromRe = new RegExp(`\\.from\\(\\s*['"]${TABLE}['"]\\s*\\)`)

  for (let i = 0; i < lines.length; i++) {
    if (!fromRe.test(lines[i])) continue

    const start = statementStart(lines, i)
    const flat = chainFrom(lines, start).replace(/\s+/g, ' ').trim()
    const text = flat.slice(0, 160)
    const push = (verdict: Verdict, why: string) =>
      sites.push({ file: rel, line: start + 1, verdict, why, text })

    if (/\.(insert|update|upsert|delete)\(/.test(flat)) {
      push('WRITE', 'a write, not a read')
      continue
    }
    if (!/\.select\(/.test(flat)) {
      push('WRITE', 'no select: not a read')
      continue
    }

    // -- half 1: can this read reach a fixture at all? ------------------------------------------
    //
    // A LITERAL `restaurant_test_...` in the chain means the query is HUNTING fixtures, which is
    // the opposite of forgetting them. Checked before the tenant columns because it is written as
    // `.like('firebase_restaurant_id', 'restaurant_test_%')`, which would otherwise read as scoped
    // and hide a genuine hunt behind the wrong label.
    if (/restaurant_test_/.test(flat)) {
      push('SCOPED', 'filters ON the fixture prefix: this read is about them')
      continue
    }

    const scopedBy = TENANT_COLUMNS.find((col) =>
      new RegExp(`\\.(eq|in)\\(\\s*['"]${col}['"]`).test(flat),
    )
    if (scopedBy) {
      push('SCOPED', `.eq/.in on \`${scopedBy}\`: a NULL restaurant_id can never match`)
      continue
    }

    // The filter column may be a VARIABLE rather than a literal. Two shapes occur here, and the
    // read is properly scoped in both:
    //
    //   lib/guest-orders/queries.ts             (column: 'session_id' | 'member_session_id', ...)
    //   lib/payments/resolve-order-by-...       for (const column of ORDER_REFERENCE_COLUMNS)
    //
    // Resolve the identifier from its union annotation first, then from the array it is iterating.
    // The read is scoped only when EVERY member is a tenant column -- one non-tenant member and the
    // loop can reach a fixture on that pass.
    const varFilter = /\.(?:eq|in)\(\s*([A-Za-z_$][\w$]*)\s*,/.exec(flat)
    if (varFilter) {
      const ident = varFilter[1]
      const scope = lines.slice(Math.max(0, start - 12), start + 1).join(' ')
      const annotation = new RegExp(`\\b${ident}\\s*:\\s*([^,)=]+)`).exec(scope)
      const fromLoop = new RegExp(`\\b(?:const|let)\\s+${ident}\\s+of\\s+([A-Za-z_$][\\w$]*)`).exec(
        scope,
      )
      const candidates = annotation
        ? [...annotation[1].matchAll(/'([^']+)'/g)].map((m) => m[1])
        : fromLoop
          ? identifierLiterals(lines, fromLoop[1]).split(',').filter(Boolean)
          : []
      if (candidates.length > 0 && candidates.every((l) => TENANT_COLUMNS.includes(l))) {
        push('SCOPED', `.eq/.in on a resolved set of tenant columns (${candidates.join('|')})`)
        continue
      }
    }

    // -- satisfied? -----------------------------------------------------------------------------
    //
    // The select argument may be a bare identifier -- `.select(COLS)` -- in which case the column
    // list is wherever COLS was declared.
    const rawSelect = selectArgument(flat)
    const selectIdent = /^\s*([A-Za-z_$][\w$]*)\s*$/.exec(rawSelect.split(',')[0] ?? '')
    const selectArg =
      selectIdent && !/['"]/.test(rawSelect)
        ? identifierLiterals(lines, selectIdent[1])
        : rawSelect
    const wrapped =
      /excludeStressFixtures\s*(?:<[^(]*>)?\s*\(/.test(flat) ||
      /excludeStressFixtures\s*(?:<[^(]*>)?\s*\(/.test(
        lines.slice(Math.max(0, start - 4), start + 1).join(' '),
      )
    const orConstant = /\.or\(\s*STRESS_FIXTURE_EXCLUSION_OR\s*\)/.test(flat)
    const inMemoryReady =
      importsHelper && PREDICATE_COLUMNS.every((c) => namesColumn(selectArg, c))

    if (wrapped || orConstant) {
      push('GUARDED', wrapped ? 'wrapped in excludeStressFixtures()' : 'passes STRESS_FIXTURE_EXCLUSION_OR to .or()')
      continue
    }

    /**
     * THE HAND-WRITTEN CONVENTION, WHICH WORKS AND IS STILL THE THING #324 IS ABOUT.
     *
     * `.not('restaurant_id', 'is', null)` genuinely excludes every fixture -- all 1,314 carry a
     * NULL restaurant_id -- so this is NOT a defect and must not fail the build. It is recorded
     * as a distinct verdict because it is the exact shape the issue names: a convention repeated
     * at each call site and enforced by nothing, which the next author will not know exists.
     *
     * It is also very slightly DIFFERENT from the helper, in a direction worth stating. It drops
     * the one production row whose restaurant_id AND firebase_restaurant_id are both NULL
     * (fa06236b-...), which the helper's third clause deliberately keeps. For a revenue figure
     * that row is immaterial -- total 0, never paid. For a completeness audit it is a silent loss
     * of one row, and the helper is the version that says so.
     */
    if (/\.not\(\s*['"]restaurant_id['"]\s*,\s*['"]is['"]\s*,\s*null\s*\)/.test(flat)) {
      push(
        'GUARDED-BY-HAND',
        "excludes fixtures with .not('restaurant_id','is','null') rather than the shared helper — " +
          'correct, but it is the per-call-site convention #324 is about, and it also drops the one ' +
          'both-NULL production row the helper keeps',
      )
      continue
    }

    // -- unreachable by value? ------------------------------------------------------------------
    // See FIXTURE_VALUES above for the measurement and for why this is a verdict rather than a
    // conclusion. Only LITERALS are read: `.eq('payment_status', SOME_CONST)` is not resolved,
    // because a constant defined in another module can change without this file noticing, and
    // guessing in the reassuring direction is the failure this check exists to prevent.
    let unreachable: string | null = null
    for (const [column, values] of Object.entries(FIXTURE_VALUES)) {
      const pin = new RegExp(`\\.eq\\(\\s*['"]${column}['"]\\s*,\\s*['"]([^'"]+)['"]\\s*\\)`).exec(flat)
      if (pin && !values.includes(pin[1])) {
        unreachable = `pins \`${column}\` to '${pin[1]}'; every fixture is ${values
          .map((v) => `'${v}'`)
          .join(' or ')}`
        break
      }
    }
    if (!unreachable) {
      const notNull = FIXTURE_ALWAYS_NULL.find((col) =>
        new RegExp(`\\.not\\(\\s*['"]${col}['"]\\s*,\\s*['"]is['"]\\s*,\\s*null\\s*\\)`).test(flat),
      )
      if (notNull) unreachable = `requires \`${notNull}\` to be non-NULL; it is NULL on all 1,314 fixtures`
    }
    if (unreachable) {
      push(
        'UNREACHABLE-BY-VALUE',
        `${unreachable} — correct today, but it is the FILTER that excludes them, not a guard. ` +
          'Remove or widen that filter and this becomes a finding.',
      )
      continue
    }

    // -- half 2: is this a measurement? ---------------------------------------------------------
    //
    // A READ THAT CAN RETURN ONE ROW IS NOT A COUNT, A SUM OR A RATIO. Every `[control] orders is
    // readable` probe in scripts/ is `.select('id').limit(1)`, and a positive control that proves
    // the connection works is the opposite of a poisoned denominator. Reported by --report so the
    // blast-radius table stays complete; never a build failure.
    if (inMemoryReady) {
      push('GUARDED', 'file imports the predicate and the select carries both predicate columns')
      continue
    }

    /**
     * A SET IS A MEASUREMENT. ONE ROW IS NOT.
     *
     * THIS RULE WAS REWRITTEN AFTER A MUTATION TEST FOUND THE FIRST ONE WAS DECORATION. The first
     * version asked whether the read looked like a count, a sum or a ratio: `count: 'exact'`, a
     * money column in the select, or a binding that is later `.length`-ed or `.reduce`-d. Stripping
     * `excludeStressFixtures()` off the fourteen-day paging read in
     * `app/api/platform/analytics/route.ts` DID NOT TURN IT RED. That read selects `id, placed_at`
     * — no money column, no count option — and destructures as `const { data, error }`, whose
     * SHORTHAND the binding regex did not resolve, so the aggregation test found nothing either.
     * Three signals, all absent, on a query whose entire purpose is a per-day order-volume chart.
     *
     * The lesson is not "add a fourth signal". It is that a shape test cannot see what a set of
     * rows is going to be used for, and the reassuring answer — "not a measurement" — was the one
     * it produced by default whenever it could not tell. That is the same failure direction as the
     * predicate that ran, reported zero and changed nothing.
     *
     * So the question is now the one that CAN be answered from the query alone: does this read
     * return a SET of rows it did not scope? A set is a denominator waiting to happen; whether it
     * is summed, counted, charted or paged into an array is downstream of the mistake, not part
     * of it. Only a read that can return AT MOST ONE ROW is exempt, and every `[control] orders is
     * readable` probe in scripts/ is exactly that.
     *
     * The count option is checked FIRST: `.select('id', { count: 'exact', head: true }).limit(1)`
     * still reports the whole table's row count, and reading that `.limit(1)` as "one row" would
     * wave through the single most dangerous shape there is.
     */
    const counts =
      /count\s*:\s*['"](exact|planned|estimated)['"]/.test(flat) || /head\s*:\s*true/.test(flat)
    const singleRowRe = /\.limit\(\s*1\s*\)|\.maybeSingle\(\)|\.single\(\)/
    let singleRow = singleRowRe.test(flat)

    /**
     * THE STORED-BUILDER CASE, which the sibling check learned the hard way and this one inherits:
     *
     *     let q = db.from('orders').select(COLUMNS)...      <- chain ends here
     *     q = tabless ? q.is('tab_id', null) : q...
     *     const { data } = await q.order(...).limit(1).maybeSingle()   <- bound LATER, elsewhere
     *
     * scripts/probe-302-305-production-readonly.ts does exactly this. A checker that cannot see it
     * reports a single-row lookup as an unguarded cross-venue measurement, which is a false
     * positive on correct code -- and the habit of ignoring those is what lets a real one through.
     */
    const assigned = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/.exec(lines[start])
    if (!singleRow && assigned) {
      const name = assigned[1]
      if (new RegExp(`\\b${name}\\s*\\.\\s*[\\w.()' ,{}:!=?-]{0,120}?(limit\\(\\s*1\\s*\\)|maybeSingle\\(\\)|single\\(\\))`).test(source))
        singleRow = true
    }

    if (!counts && singleRow) {
      push('NOT-A-MEASUREMENT', 'unscoped, but returns at most one row: not a count, sum or ratio')
      continue
    }

    const missing = importsHelper
      ? `the file imports the predicate but the select omits ${PREDICATE_COLUMNS.filter(
          (c) => !namesColumn(selectArg, c),
        ).join(' and ')}, so it would call every row real`
      : 'no exclusion: this measurement includes the 1,314 stress fixtures'

    push('FINDING', missing)
  }

  return sites
}

/* ==============================================================================================
 * SELF-TEST
 *
 * The scan must prove it can still SEE before it reports that it sees nothing, and -- given how
 * easily a rule this shape turns into noise -- that it still ignores what it should ignore.
 *
 * These fixtures are inputs to the real `sitesFor`, not to a copy of its logic. A self-test with
 * its own implementation proves only that the copy still works.
 * ============================================================================================ */

const MUST_CATCH: [string, string][] = [
  [
    'unscoped exact count -- the shape that produced "876 broken QR orders"',
    `const { count } = await supabase
      .from('orders')
      .select('id', { count: 'exact', head: true })
      .eq('payment_status', 'cancelled')`,
  ],
  [
    'unscoped sum of a money column',
    `const { data } = await supabase
      .from('orders')
      .select('total, placed_at')
      .gte('placed_at', from)`,
  ],
  [
    'unscoped read whose result is reduced',
    `const { data: rows } = await supabase
      .from('orders')
      .select('id, status')
      .gte('placed_at', from)
    const n = rows.reduce((a, r) => a + 1, 0)`,
  ],
  [
    'THE measure-customer-wait DEFECT: imports the predicate, omits firebase_restaurant_id',
    `import { isStressFixtureOrder } from '../../lib/orders/stress-fixtures'
    const { data } = await supabase
      .from('orders')
      .select('id, restaurant_id, total, placed_at')
      .gte('placed_at', from)`,
  ],
  [
    'unscoped count filtered by order_number alone -- order_number is NOT narrowing',
    `const { count } = await supabase
      .from('orders')
      .select('id', { count: 'exact', head: true })
      .eq('order_number', orderNumber)`,
  ],
]

const MUST_IGNORE: [string, string][] = [
  [
    'scoped to one venue',
    `const { data } = await supabase
      .from('orders')
      .select('total')
      .eq('restaurant_id', restaurantId)`,
  ],
  [
    'scoped to one order by id',
    `const { data } = await supabase
      .from('orders')
      .select('total, subtotal, tax')
      .eq('id', orderId)
      .maybeSingle()`,
  ],
  [
    'wrapped in excludeStressFixtures',
    `const { data } = await excludeStressFixtures(
      supabase.from('orders').select('id, total', { count: 'exact' }),
    )`,
  ],
  [
    'the .or() constant, unwrapped',
    `const { count } = await supabase
      .from('orders')
      .select('id', { count: 'exact', head: true })
      .or(STRESS_FIXTURE_EXCLUSION_OR)`,
  ],
  [
    'in-memory predicate with BOTH columns selected',
    `import { isStressFixtureOrder } from '../../lib/orders/stress-fixtures'
    const { data } = await supabase
      .from('orders')
      .select('id, restaurant_id, firebase_restaurant_id, total')
      .gte('placed_at', from)`,
  ],
  [
    'a write, not a read',
    `await supabase
      .from('orders')
      .update({ status: 'ready' })
      .eq('payment_status', 'paid')`,
  ],
  [
    'unscoped but not a measurement -- reported by --report, never a build failure',
    `const { data } = await supabase
      .from('orders')
      .select('id, status')
      .eq('payment_status', 'pending')
      .limit(1)`,
  ],
  [
    'hunting the fixtures on purpose',
    `const { count } = await supabase
      .from('orders')
      .select('id', { count: 'exact', head: true })
      .is('restaurant_id', null)
      .like('firebase_restaurant_id', 'restaurant_test_%')`,
  ],
  [
    'the hand-written convention -- correct, so not a build failure',
    `const { data } = await supabase
      .from('orders')
      .select('id, total, paid_at')
      .eq('payment_status', 'paid')
      .not('restaurant_id', 'is', null)
      .limit(500)`,
  ],
  [
    'a [control] single-row readability probe',
    `const { data: ctl } = await admin.from('orders').select('id').limit(1)
    console.log(ctl?.length ? 'YES' : 'NO')`,
  ],
  [
    "pinned to payment_status 'paid' -- no fixture has ever been paid",
    `const paid = await page((f, t) =>
      supabase.from('orders').select('id, total').eq('payment_status', 'paid').range(f, t),
    )`,
  ],
  [
    'requires a non-NULL source_request_id -- NULL on every fixture',
    `const { data: linked } = await admin
      .from('orders')
      .select('placed_at, source_request_id')
      .not('source_request_id', 'is', null)
      .limit(1000)`,
  ],
  [
    'a select through a CONST column list that names both predicate columns',
    `import { isStressFixtureOrder } from '../../lib/orders/stress-fixtures'
    const COLS = 'id,restaurant_id,firebase_restaurant_id,total'
    const { data } = await db.from('orders').select(COLS).range(f, f + 999)`,
  ],
  [
    'a stored builder bounded to one row LATER, on the binding',
    `let q = db.from('orders').select(COLUMNS).not('session_id', 'is', null)
    q = tabless ? q.is('tab_id', null) : q.not('tab_id', 'is', null)
    const { data: order } = await q.order('placed_at', { ascending: false }).limit(1).maybeSingle()`,
  ],
]

/**
 * SHAPES THAT MUST NOT BE SWALLOWED BY THE TWO NON-FAILING VERDICTS.
 *
 * `.limit(1)` and the hand-written `.not()` are both escape hatches, and an escape hatch is where
 * the next real finding hides. These prove each one is narrow.
 */
const MUST_STILL_CATCH_NEAR_MISSES: [string, string][] = [
  [
    'a whole-table count that also carries .limit(1) -- the count option wins',
    `const { count } = await supabase
      .from('orders')
      .select('id', { count: 'exact', head: true })
      .limit(1)`,
  ],
  [
    'a .not() on a column fixtures DO carry -- excludes none of them',
    `const { count } = await supabase
      .from('orders')
      .select('id', { count: 'exact', head: true })
      .not('order_number', 'is', null)`,
  ],
  [
    "a status pin that MATCHES the fixture vocabulary -- 876 of them are payment_status 'cancelled'",
    `const { count } = await supabase
      .from('orders')
      .select('id', { count: 'exact', head: true })
      .eq('payment_status', 'cancelled')`,
  ],
  [
    'a status pin whose value is a CONSTANT, which is not resolved and must not be assumed benign',
    `const { count } = await supabase
      .from('orders')
      .select('id', { count: 'exact', head: true })
      .eq('payment_status', SOME_IMPORTED_STATUS)`,
  ],
  [
    'a .limit(1000) sample -- one row is not a ratio, a thousand rows is',
    `const { data: rows } = await supabase
      .from('orders')
      .select('id, channel, status')
      .order('placed_at', { ascending: false })
      .limit(1000)
    console.log(rows.length)`,
  ],
]

function selfTest(): void {
  const broken: string[] = []
  for (const [label, fixture] of [...MUST_CATCH, ...MUST_STILL_CATCH_NEAR_MISSES]) {
    if (!sitesFor('<self-test>', fixture).some((s) => s.verdict === 'FINDING'))
      broken.push(`no longer catches: ${label}`)
  }
  for (const [label, fixture] of MUST_IGNORE) {
    if (sitesFor('<self-test>', fixture).some((s) => s.verdict === 'FINDING'))
      broken.push(`now false-positives on: ${label}`)
  }
  if (broken.length) {
    console.error(
      '\ncheck-orders-fixture-excluded: SELF-TEST FAILED -- the scan cannot be trusted.\n' +
        'It would have reported a result over a codebase it can no longer read correctly.\n',
    )
    for (const b of broken) console.error(`  ${b}`)
    console.error('')
    process.exit(1)
  }
}

function inScope(rel: string): boolean {
  if (rel.includes('__tests__')) return false
  if (RUNTIME_DIRS.some((d) => rel === d || rel.startsWith(`${d}/`))) return true
  if (rel.startsWith(`${PRODUCTION_SCRIPT_DIR}/`)) return true
  if (rel.startsWith('scripts/') && PRODUCTION_SCRIPT_NAME.test(rel.split('/').pop() ?? '')) return true
  return false
}

function main(): void {
  selfTest()

  const report = process.argv.includes('--report')
  const roots = [...RUNTIME_DIRS, 'scripts']
  const files = roots.flatMap((dir) => walk(join(ROOT, dir)))

  const sites: Site[] = []
  const usedAllowances = new Set<string>()
  let scanned = 0

  for (const file of files) {
    const rel = relative(ROOT, file).split(sep).join('/')
    if (!inScope(rel)) continue
    scanned++
    const fileSites = sitesFor(rel, readFileSync(file, 'utf8'))
    if (!fileSites.length) continue

    /**
     * AN ALLOWANCE COVERS ONLY THE SITES THAT WOULD OTHERWISE FAIL, NOT THE WHOLE FILE.
     *
     * `lib/orders/auto-cancel-stale-pos-orders.ts` holds six `orders` chains. Four are writes or
     * are already scoped; two are the reads the allowance is about. A file-level allowance
     * relabelled all six ALLOWED, so the report claimed a reasoned exemption for four sites nobody
     * had reasoned about, and the file would have gone on being exempt if one of them later became
     * an unguarded cross-venue sum. Every other verdict is left exactly as the scan found it.
     */
    const allowance = ALLOWED_FILES.get(rel)
    if (allowance !== undefined) {
      let covered = false
      for (const s of fileSites) {
        if (s.verdict === 'FINDING') {
          covered = true
          sites.push({ ...s, verdict: 'ALLOWED', why: allowance })
        } else sites.push(s)
      }
      if (covered) usedAllowances.add(rel)
      continue
    }
    sites.push(...fileSites)
  }

  const findings = sites.filter((s) => s.verdict === 'FINDING')
  const stale = [...ALLOWED_FILES.keys()].filter((r) => !usedAllowances.has(r))

  if (report) {
    const shown = sites.filter((s) => s.verdict !== 'WRITE' && s.verdict !== 'SCOPED')
    console.log(
      `\ncheck-orders-fixture-excluded --report: ${scanned} files in scope, ` +
        `${sites.length} \`${TABLE}\` call sites.\n` +
        `Reads narrowed to a venue/record and writes are omitted below; they cannot reach a fixture.\n`,
    )
    const order: Verdict[] = [
      'FINDING',
      'UNREACHABLE-BY-VALUE',
      'GUARDED-BY-HAND',
      'NOT-A-MEASUREMENT',
      'GUARDED',
      'ALLOWED',
    ]
    for (const verdict of order) {
      const group = shown.filter((s) => s.verdict === verdict)
      if (!group.length) continue
      console.log(`--- ${verdict} (${group.length}) ---`)
      for (const s of group) {
        console.log(`  ${s.file}:${s.line}`)
        console.log(`    ${s.why}`)
      }
      console.log('')
    }
    const counts = new Map<Verdict, number>()
    for (const s of sites) counts.set(s.verdict, (counts.get(s.verdict) ?? 0) + 1)
    console.log(
      'totals: ' +
        [...counts.entries()].map(([v, n]) => `${v}=${n}`).join('  '),
    )
  }

  if (!findings.length && !stale.length) {
    if (!report)
      console.log(
        `check-orders-fixture-excluded: OK -- ${scanned} files scanned, ` +
          `every unscoped measurement over \`${TABLE}\` excludes the #324 stress fixtures.`,
      )
    return
  }

  if (findings.length) {
    console.error(
      `\ncheck-orders-fixture-excluded: ${findings.length} finding(s).\n\n` +
        `Production's \`orders\` table is 37% stress fixtures (1,314 of 3,522 on 2026-08-27).\n` +
        `A cross-venue count, sum or ratio that does not exclude them is wrong by up to 37% and\n` +
        `reports no error. That has already produced two figures that were acted on (#324).\n\n` +
        `Fix by wrapping the builder in excludeStressFixtures() from lib/orders/stress-fixtures.ts,\n` +
        `or -- if the rows are filtered in memory -- by adding restaurant_id AND\n` +
        `firebase_restaurant_id to the select, without which the predicate calls every row real.\n`,
    )
    for (const f of findings) {
      console.error(`  ${f.file}:${f.line}`)
      console.error(`    ${f.why}`)
      console.error(`    ${f.text}\n`)
    }
  }

  if (stale.length) {
    console.error(
      `\ncheck-orders-fixture-excluded: ${stale.length} STALE allowance(s) -- listed in\n` +
        `ALLOWED_FILES but matching nothing. Remove them, or the next real offender in that file\n` +
        `is waved through:\n`,
    )
    for (const r of stale) console.error(`  ${r}`)
    console.error('')
  }

  process.exit(1)
}

main()
