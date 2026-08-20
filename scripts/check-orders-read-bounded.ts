/**
 * EVERY READ OF `orders` MUST BE BOUNDED, OR IT SILENTLY TRUNCATES AT 1000 ROWS.
 *
 * Static, no credentials, no database. Blocking in CI, same class as
 * scripts/check-order-number-guard.ts and scripts/check-session-restaurant-resolver.ts.
 *
 * ============================================================================================
 * WHY THIS EXISTS
 * ============================================================================================
 *
 * PostgREST caps a response at 1000 rows and says nothing about it. A read with no explicit
 * `.range()` therefore returns a TRUNCATED set that looks complete, and any total computed from it
 * is quietly wrong. That is #323: totalRevenue, totalOrders and avgOrderValue in Order History were
 * summed from an unpaginated query, so above 1000 paid orders in the window they under-reported --
 * no error, nothing on screen, a number a restaurant would have acted on.
 *
 * `orders` is the only table over 1000 rows in production today (2810 rows on 2026-08-20), which is
 * why the scan is scoped to it. When payment_events or menu_items approach the cap, widen TABLES.
 *
 * THE DANGEROUS SHAPE IS SPECIFICALLY "A SET, UNBOUNDED". Reads narrowed to one order, one tab, one
 * table or one payment reference cannot reach 1000 rows and are not findings -- flagging them would
 * bury the four that matter under twenty-six that do not.
 *
 * ============================================================================================
 * THE STORED-BUILDER CASE, WHICH A NAIVE SCAN GETS WRONG
 * ============================================================================================
 *
 * A first pass at this check used a line-chain heuristic and produced TWO FALSE POSITIVES, both in
 * app/api/orders/history/route.ts, which does:
 *
 *     let summaryQuery = supabase.from('orders')...        <- chain ends here
 *     ...
 *     await summaryQuery.range(offset, offset + PAGE - 1)  <- bound applied later, elsewhere
 *
 * A checker that cannot see that is not usable: it cries wolf on correct code, and the habit of
 * ignoring it is what lets a real finding through. So this resolves the assignment target and
 * searches the whole file for a bound applied to that binding.
 */
import { readdirSync, readFileSync, statSync } from 'fs'
import { join, relative, sep } from 'path'

const ROOT = process.cwd()
const SEARCH_DIRS = ['app', 'components', 'lib', 'hooks']
const EXTS = ['.ts', '.tsx']

/** Tables that can exceed 1000 rows in production. Widen as volumes grow. */
const TABLES = ['orders']

/**
 * Columns whose equality (or `.in()`) narrows a read to a handful of rows by construction.
 * A read filtered by any of these cannot reach the cap.
 */
const NARROWING_COLUMNS = [
  'id',
  'tab_id',
  'table_number',
  'table_id',
  'session_id',
  'member_session_id',
  'paycloud_merchant_order_no',
  'payment_reference',
  'payment_trans_no',
  'idempotency_key',
  'source_request_id',
  'firebase_id',
]

/** The paginating helper. A read that goes through it is bounded by definition. */
const PAGINATION_HELPERS = ['fetchAllRows', 'fetchAllPaginated']

/**
 * Empty on purpose. The paginating helper is generic and never names a table, so it does not need
 * an allowance -- and an allowance that matches nothing is itself reported, because one guarding a
 * file that has moved would wave through the next real offender there.
 */
const ALLOWED_FILES = new Map<string, string>()

type Finding = { file: string; line: number; reason: string; text: string }

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
 * from how each line begins.
 *
 * A prefix heuristic breaks on a multi-line argument, and that is not hypothetical: it truncated
 * the chain in app/api/orders/history/route.ts at
 *
 *     .select(
 *       'id, order_number, ...',      <- starts with a quote: not '.', not ')', not 'key:'
 *       { count: 'exact' },
 *     )
 *
 * losing the `.range()` further down and reporting a correctly-paginated query as a finding. Depth
 * tracking sees the whole statement, which is the difference between a usable check and one people
 * learn to ignore.
 */
function chainFrom(lines: string[], start: number): { text: string; end: number } {
  const parts: string[] = []
  let depth = 0
  let i = start
  for (; i < lines.length && i < start + 60; i++) {
    const line = lines[i]
    parts.push(line)
    for (const ch of line) {
      if (ch === '(' || ch === '[' || ch === '{') depth++
      else if (ch === ')' || ch === ']' || ch === '}') depth--
    }
    if (depth > 0) continue
    // Balanced. Keep going only while the NEXT line continues the chain.
    //
    // A COMMENT LINE inside a chain is still the chain. Treating it as a terminator truncated the
    // walk in app/api/payments/push-to-terminal, which puts a comment between .from('orders') and
    // .update(...) -- so the write was never seen and an UPDATE was reported as an unbounded read.
    let k = i + 1
    while (k < lines.length && /^\s*(\/\/|\/\*|\*)/.test(lines[k])) k++
    const next = lines[k]
    if (next === undefined || !/^\s*\./.test(next)) break
    // Absorb the comment lines so the chain text stays contiguous.
    for (let c = i + 1; c < k; c++) parts.push(lines[c])
    i = k - 1
  }
  return { text: parts.join(' '), end: i }
}

function findingsFor(rel: string, source: string): Finding[] {
  const lines = source.split(/\r?\n/)
  const found: Finding[] = []

  for (const table of TABLES) {
    const fromRe = new RegExp(`\\.from\\(\\s*['"]${table}['"]\\s*\\)`)
    for (let i = 0; i < lines.length; i++) {
      if (!fromRe.test(lines[i])) continue

      const start = statementStart(lines, i)
      const { text } = chainFrom(lines, start)
      const flat = text.replace(/\s+/g, ' ').trim()

      // Writes are not reads.
      if (/\.(insert|update|upsert|delete)\(/.test(flat)) continue

      // Bounded inline.
      if (/\.range\(|\.limit\(|\.maybeSingle\(\)|\.single\(\)|head:\s*true/.test(flat)) continue

      // Bounded through the shared helper -- which commonly wraps the builder on the LINE ABOVE:
      //     const rows = await fetchAllRows(
      //       supabase.from('orders')...,
      //     )
      // so the chain text alone does not contain the helper name. Look back a few lines too.
      //
      // The call may also carry GENERIC TYPE ARGUMENTS -- fetchAllRows<Record<string, unknown>>( --
      // so a literal `name(` match misses it. That mistake flagged three sites AFTER they had been
      // correctly converted, which is exactly as useless as missing an unconverted one.
      const lookback = lines.slice(Math.max(0, start - 4), start + 1).join(' ')
      const helperCall = (h: string) => new RegExp(`\\b${h}\\s*(?:<[^(]*>)?\\s*\\(`)
      if (PAGINATION_HELPERS.some((h) => helperCall(h).test(flat) || helperCall(h).test(lookback)))
        continue

      // Bounded by a later call on the binding this chain was assigned to.
      const assigned = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/.exec(lines[start])
      if (assigned) {
        const name = assigned[1]
        const laterBound = new RegExp(
          `\\b${name}\\s*\\.\\s*(range|limit)\\(|\\b${name}\\s*=\\s*${name}\\s*\\.\\s*(range|limit)\\(`,
        )
        if (laterBound.test(source)) continue
        if (
          PAGINATION_HELPERS.some((h) =>
            new RegExp(`\\b${h}\\s*(?:<[^(]*>)?\\s*\\(\\s*${name}\\b`).test(source),
          )
        )
          continue
      }

      // Narrow scope: cannot reach 1000 rows.
      const narrow = NARROWING_COLUMNS.some((col) =>
        new RegExp(`\\.(eq|in)\\(\\s*['"]${col}['"]`).test(flat),
      )
      if (narrow) continue

      // The column may be a VARIABLE rather than a literal, as in lib/guest-orders/queries.ts:
      //
      //     const ordersQueryFor = (column: 'session_id' | 'member_session_id', ...) =>
      //       supabase.from('orders')....in(column, sessionIds)
      //
      // That read is bounded -- it can only ever match one customer's own sessions -- but a
      // literal-only test cannot see it. Resolve the variable against its type annotation: if
      // every member of the union is a narrowing column, the read is narrow. Adding this file to
      // an allowlist instead would have been the easy move, and an allowlist is where the next
      // genuinely unbounded read in it would hide.
      const varFilter = /\.(?:eq|in)\(\s*([A-Za-z_$][\w$]*)\s*,/.exec(flat)
      if (varFilter) {
        const ident = varFilter[1]
        const scope = lines.slice(Math.max(0, start - 10), start + 1).join(' ')
        const annotation = new RegExp(`\\b${ident}\\s*:\\s*([^,)=]+)`).exec(scope)
        if (annotation) {
          const literals = [...annotation[1].matchAll(/'([^']+)'/g)].map((m) => m[1])
          if (literals.length > 0 && literals.every((l) => NARROWING_COLUMNS.includes(l))) continue
        }
      }

      found.push({
        file: rel,
        line: start + 1,
        reason: `unbounded read of \`${table}\`: no .range(), no narrowing filter`,
        text: flat.slice(0, 150),
      })
    }
  }

  return found
}

/**
 * The scan must prove it can still see before it reports that it sees nothing -- and, given the
 * false-positive history, that it still ignores what it should ignore.
 */
const MUST_CATCH: [string, string][] = [
  [
    'plain unbounded restaurant-wide read',
    `const { data } = await supabase
      .from('orders')
      .select('*')
      .eq('restaurant_id', restaurantId)`,
  ],
  [
    'unbounded read assigned to a builder that is never bounded',
    `let query = supabase
      .from('orders')
      .select('id, total')
      .eq('restaurant_id', restaurantId)
    const { data } = await query`,
  ],
]

const MUST_IGNORE: [string, string][] = [
  [
    'inline .range()',
    `const { data } = await supabase
      .from('orders')
      .select('*')
      .eq('restaurant_id', restaurantId)
      .range(0, 19)`,
  ],
  [
    'STORED BUILDER bounded later -- the false positive that motivated this scan',
    `let summaryQuery = supabase
      .from('orders')
      .select('id, total')
      .eq('restaurant_id', restaurantId)
    const { data } = await summaryQuery.range(offset, offset + 999)`,
  ],
  [
    'narrowed to one tab',
    `const { data } = await supabase
      .from('orders')
      .select('total')
      .eq('tab_id', tabId)`,
  ],
  [
    'routed through the shared paginating helper',
    `const rows = await fetchAllRows(
      supabase.from('orders').select('id, total').eq('restaurant_id', restaurantId),
    )`,
  ],
  [
    'a write, not a read',
    `await supabase
      .from('orders')
      .update({ status: 'ready' })
      .eq('restaurant_id', restaurantId)`,
  ],
]

function selfTest(): void {
  const broken: string[] = []
  for (const [label, fixture] of MUST_CATCH) {
    if (findingsFor('<self-test>', fixture).length === 0) broken.push(`no longer catches: ${label}`)
  }
  for (const [label, fixture] of MUST_IGNORE) {
    if (findingsFor('<self-test>', fixture).length > 0) broken.push(`now false-positives on: ${label}`)
  }
  if (broken.length) {
    console.error(
      '\ncheck-orders-read-bounded: SELF-TEST FAILED -- the scan cannot be trusted.\n' +
        'It would have reported a result over a codebase it can no longer read correctly.\n',
    )
    for (const b of broken) console.error(`  ${b}`)
    console.error('')
    process.exit(1)
  }
}

function main(): void {
  selfTest()

  const files = SEARCH_DIRS.flatMap((dir) => walk(join(ROOT, dir)))
  const findings: Finding[] = []
  const usedAllowances = new Set<string>()

  for (const file of files) {
    const rel = relative(ROOT, file).split(sep).join('/')
    if (rel.includes('__tests__')) continue
    const fileFindings = findingsFor(rel, readFileSync(file, 'utf8'))
    if (!fileFindings.length) continue
    if (ALLOWED_FILES.has(rel)) {
      usedAllowances.add(rel)
      continue
    }
    findings.push(...fileFindings)
  }

  const stale = [...ALLOWED_FILES.keys()].filter((r) => !usedAllowances.has(r))

  if (!findings.length && !stale.length) {
    console.log(
      `check-orders-read-bounded: OK -- ${files.length} files scanned, ` +
        `every read of ${TABLES.join('/')} is ranged, narrowed, or paginated.`,
    )
    return
  }

  if (findings.length) {
    console.error(
      `\ncheck-orders-read-bounded: ${findings.length} finding(s).\n\n` +
        `PostgREST caps a response at 1000 rows and reports nothing. These reads can return a\n` +
        `truncated set that looks complete, and any total computed from one is silently wrong.\n\n` +
        `Fix by routing through fetchAllRows() from lib/supabase/fetch-all-rows.ts, or by adding\n` +
        `an explicit .range() if the caller genuinely wants one page.\n`,
    )
    for (const f of findings) {
      console.error(`  ${f.file}:${f.line}`)
      console.error(`    ${f.reason}`)
      console.error(`    ${f.text}\n`)
    }
  }

  if (stale.length) {
    console.error(
      `\ncheck-orders-read-bounded: ${stale.length} STALE allowance(s) -- listed in ALLOWED_FILES\n` +
        `but no longer matching. Remove them, or the next real offender there is waved through:\n`,
    )
    for (const r of stale) console.error(`  ${r}`)
    console.error('')
  }

  process.exit(1)
}

main()
