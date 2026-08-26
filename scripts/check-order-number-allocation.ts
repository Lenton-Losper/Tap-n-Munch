/**
 * NO SECOND ALLOCATOR. Every order number is issued by lib/orders/order-number.ts.
 *
 * Static, no credentials, no database. Blocking in CI, same class as
 * scripts/check-order-number-guard.ts — which guards the READING of an order number. This guards
 * the WRITING of one. They are the two halves of #127 and #296/#308, and neither catches the
 * other's defect.
 *
 * ============================================================================================
 * WHY
 * ============================================================================================
 *
 * `SELECT count(*) + 1` was the allocator in FIVE places when #127 was fixed:
 *
 *   lib/orders/create-order.ts            the live one, every POS and Accept order
 *   app/api/orders/route.ts               the legacy direct path
 *   lib/supabase/orders.ts                by restaurant_id, not firebase id — a different scope
 *   app/api/orders/route.ts    (kiosk)    daily counter
 *   .../order-requests/accept  (kiosk)    daily counter, copied from the above
 *
 * Two of the five had no caller at all, which is how a fifth copy gets written: somebody finds a
 * plausible-looking helper and uses it. A comment saying "use the allocator" does not stop that.
 * A failing build does.
 *
 * ============================================================================================
 * TWO RULES, AND WHAT EACH ONE CANNOT SEE
 * ============================================================================================
 *
 * RULE 1 — the count-plus-one shape: `(anythingCount || 0) + 1`, `(count ?? 0) + 1`.
 *
 *   This is the exact spelling that shipped five times in this repo. It is NOT a general test for
 *   "derived a sequential number from a row count" and it is not pretending to be: `count + 1`
 *   with no default, or a count read into a differently named variable two lines earlier, both
 *   walk past it. It catches the shape that actually recurs here, which is the shape a sixth copy
 *   is most likely to be pasted from.
 *
 * RULE 2 — the write itself: a file may not put `order_number` or `kiosk_order_number` inside an
 *   `.insert({ … })` or `.update({ … })` unless it imports lib/orders/order-number.
 *
 *   This is the load-bearing one, and it does not depend on how the number was computed. Rule 1
 *   can be evaded by rewriting the arithmetic; rule 2 cannot be evaded except by importing the
 *   allocator, which is the point. It reads object-literal keys inside a write call by tracking
 *   brace depth — deliberately not a regex over the whole file, because `order_number:` appears in
 *   a dozen SELECT projections and result mappings that are not writes and must not be flagged.
 *
 *   It cannot see a write assembled elsewhere (`const patch = {...}; .update(patch)`) or one built
 *   by spreading a caller's object. `createSupabaseOrder` was exactly that shape — `.insert({
 *   ...data })` with `order_number` hidden in `data` — and this scan would have missed it. It was
 *   deleted rather than allow-listed, and this paragraph is here so the next reader knows the gate
 *   has that hole rather than discovering it after a sixth allocator.
 */
import { readdirSync, readFileSync, statSync } from 'fs'
import { join, relative, sep } from 'path'

const ROOT = process.cwd()
const SEARCH_DIRS = ['app', 'components', 'lib', 'hooks']
const EXTS = ['.ts', '.tsx']

/** The module that may issue an order number. Exempt from both rules: it is the allocator. */
const ALLOCATOR = 'lib/orders/order-number.ts'
const ALLOCATOR_IMPORT = /from\s+['"](?:@\/)?lib\/orders\/order-number['"]/

/** The columns whose value must come from the allocator. */
const ALLOCATED_COLUMNS = ['order_number', 'kiosk_order_number']

type Finding = { file: string; line: number; text: string; why: string }

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
    let st
    try {
      st = statSync(full)
    } catch {
      continue
    }
    if (st.isDirectory()) walk(full, out)
    else if (EXTS.some((e) => entry.endsWith(e))) out.push(full)
  }
  return out
}

/** Blank out comments so a docblock DESCRIBING the wrong shape is not itself a finding. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' ')).replace(/\/\/[^\n]*/g, '')
}

/** `(fooCount || 0) + 1` / `(count ?? 0) + 1`. */
const COUNT_PLUS_ONE = /\(\s*\w*[Cc]ount\w*\s*(?:\|\||\?\?)\s*0\s*\)\s*\+\s*1/

/**
 * Rule 1 hits that are the same SHAPE but not an order number, listed rather than regex'd away so
 * that adding one is a visible decision with a reason attached.
 *
 * app/api/admin/terminals/generate-code/route.ts — `(count ?? 0) + 1` over restaurant_terminals,
 * used only to build the default display label "Terminal 3". It has the identical race and the
 * identical delete-drift, but it produces a `terminal_name` (text, no uniqueness, overridable by
 * the caller) rather than an identifier anything is looked up by. Two devices could be labelled
 * "Terminal 3"; nothing would resolve to the wrong one. Left alone deliberately — it belongs to
 * terminal registration, not to #127, and quietly folding it in would put an unrelated route in
 * an order-numbering commit.
 */
const RULE_1_EXEMPT = new Set(['app/api/admin/terminals/generate-code/route.ts'])

/**
 * The 0-based character ranges covered by an `.insert(` or `.update(` call, found by tracking
 * paren depth from the opening one. Strings are not parsed, so a `)` inside a string literal
 * inside a write call would end the range early — that fails SAFE (it can only shrink a range and
 * miss a write, never invent one), and no write in this repo contains an unbalanced paren.
 */
function writeCallRanges(src: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = []
  const opener = /\.(?:insert|update|upsert)\s*\(/g
  let m: RegExpExecArray | null
  while ((m = opener.exec(src)) !== null) {
    let depth = 0
    let i = m.index + m[0].length - 1
    for (; i < src.length; i += 1) {
      if (src[i] === '(') depth += 1
      else if (src[i] === ')') {
        depth -= 1
        if (depth === 0) break
      }
    }
    ranges.push([m.index, i])
  }
  return ranges
}

function main() {
  const files: string[] = []
  for (const dir of SEARCH_DIRS) walk(join(ROOT, dir), files)

  const findings: Finding[] = []

  for (const file of files) {
    const rel = relative(ROOT, file).split(sep).join('/')
    if (rel === ALLOCATOR) continue

    const raw = readFileSync(file, 'utf8')
    const src = stripComments(raw)
    const importsAllocator = ALLOCATOR_IMPORT.test(src)
    const lineOf = (index: number) => src.slice(0, index).split('\n').length
    const lines = src.split('\n')

    // ---- rule 1
    lines.forEach((line, i) => {
      if (RULE_1_EXEMPT.has(rel)) return
      if (COUNT_PLUS_ONE.test(line)) {
        findings.push({
          file: rel,
          line: i + 1,
          text: line.trim(),
          why: 'derives a sequential number from a row count — count(*) drops when a row leaves the table',
        })
      }
    })

    // ---- rule 2
    if (!importsAllocator) {
      for (const [start, end] of writeCallRanges(src)) {
        const body = src.slice(start, end)
        for (const column of ALLOCATED_COLUMNS) {
          const key = new RegExp(`(^|[{,\\s])${column}\\s*:`)
          if (key.test(body)) {
            findings.push({
              file: rel,
              line: lineOf(start + body.search(key)),
              text: `${column}: … inside a write call`,
              why: `writes ${column} without importing ${ALLOCATOR}`,
            })
          }
        }
      }
    }
  }

  if (findings.length === 0) {
    console.log(
      `check-order-number-allocation: OK — ${files.length} files scanned, ` +
        `every order number is issued by ${ALLOCATOR}.`,
    )
    return
  }

  console.error('\ncheck-order-number-allocation: FAILED\n')
  console.error(
    'An order number was allocated or written outside lib/orders/order-number.ts.\n\n' +
      '#127: count(*)+1 existed in five places. It is a read-then-write with no lock, so two\n' +
      'concurrent writes take the same number — measured four times on production, most recently\n' +
      '2026-08-24 — and it also re-issues a live number after any deletion, with no concurrency\n' +
      'needed at all.\n\n' +
      'Use insertWithOrderNumber() (or nextKioskOrderNumber() for the kiosk counter). It reads\n' +
      'max(order_number)+1 and retries on the unique index\'s 23505.\n',
  )
  for (const f of findings) console.error(`  ${f.file}:${f.line}\n      ${f.text}\n      <- ${f.why}`)
  console.error(`\n${findings.length} finding${findings.length === 1 ? '' : 's'}.\n`)
  process.exit(1)
}

main()
