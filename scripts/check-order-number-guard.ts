/**
 * EVERY "DOES THIS ORDER HAVE A NUMBER?" TEST MUST GO THROUGH `hasAllocatedOrderNumber`.
 *
 * Static, no credentials, no database. Blocking in CI, same class as
 * scripts/check-migration-inline-check.ts.
 *
 * ============================================================================================
 * WHY THIS EXISTS
 * ============================================================================================
 *
 * "Order #0" has now reached production THREE times, in three different files, each time because
 * a render site asked the question itself instead of asking the helper:
 *
 *   #296  `Number(row.order_number || 0)`                        -> every request said "Order #0"
 *   #308  a number derived from the UUID tail
 *   2026-08-19  `orderNumber != null` in order-confirmation-view  -> a real customer saw "Order #0"
 *
 * The third one is the reason this script exists rather than a fourth fix. `hasAllocatedOrderNumber`
 * was written for exactly this and its own docblock warned that inlining `!= null` "gets the `0`
 * and empty-string cases wrong, which is how the derived-identifier bug reached production twice".
 * The warning was a comment, and comments do not fail builds.
 *
 * THE TWO SHAPES THAT ARE WRONG, and both have shipped:
 *
 *   order_number != null        admits 0. Allocation starts at 1, so 0 means "none".
 *   typeof x === 'number'       admits 0 for the same reason.
 *
 * And the producer of the 0: lib/guest-orders/queries.ts mapped every order_request to a literal
 * `order_number: 0`, because that table has no such column. Fixed at source; the scan stays
 * because the next producer will not know that.
 *
 * ============================================================================================
 * WHAT IS ALLOWED
 * ============================================================================================
 *
 * `hasAllocatedOrderNumber(...)` and `orderIdentityLabel(...)`, which is built on it. Everything
 * else that puts `order_number` next to a null/undefined/typeof comparison is a finding.
 *
 * lib/orders/order-identity.ts is exempt: it is where the real test lives.
 */
import { readdirSync, readFileSync, statSync } from 'fs'
import { join, relative, sep } from 'path'

const ROOT = process.cwd()
const SEARCH_DIRS = ['app', 'components', 'lib', 'hooks']
const EXTS = ['.ts', '.tsx']

/**
 * The one file permitted to answer the question itself, because it is the answer.
 * Anything else added here needs a reason in the commit that adds it.
 */
const ALLOWED_FILES = new Set(['lib/orders/order-identity.ts'])

/**
 * THE ALLOWED-SUFFIX LIST IS GONE, AND NOTHING REPLACED IT. Removed 2026-08-27.
 *
 * It read:
 *
 *     const ALLOWED_SUFFIXES = ['table_number', 'kiosk_order_number', 'merchant_order_no', 'orderNumberInput']
 *     ...
 *     if (ALLOWED_SUFFIXES.some((s) => line.includes(s))) return
 *
 * Those identifiers are genuinely not order numbers -- they have no allocation rule and 0 is not
 * special for them -- but the mechanism SKIPPED THE WHOLE LINE. One allowed word anywhere on a
 * line discarded everything else on it. Verified by mutation:
 *
 *     const zzB = order.order_number != null && row.table_number      passed GREEN
 *
 * The left half is exactly the shape that put "Order #0" in front of a customer on 2026-08-19. The
 * right half is an unrelated mention of a table number, and it silently acted as a suppression
 * token -- a one-word opt-out of the money-path guard that nobody would recognise as one while
 * writing it.
 *
 * WHY NOTHING REPLACED IT, which is the part worth reading. The first fix here masked each allowed
 * identifier out of the line instead of skipping the line. That was WRONG -- not incorrect, but
 * DEAD: neutering the masking step changed no outcome, on the 608-file tree or on a single
 * self-test case. The `\b` in every pattern below already does the whole job, because `_` is a word
 * character:
 *
 *     \border_number   does NOT match inside  kiosk_order_number   (no boundary after `_`)
 *     \border_number   does NOT match inside  supplier_order_number  -- and never will, so the
 *                                                                      list needed no maintenance
 *     \borderNumber\b  does NOT match inside  orderNumberInput
 *
 * A list that cannot change any verdict is the decoration this whole audit is about, so it is
 * deleted rather than kept for comfort. What USED to be the list is now pinned in the self-test's
 * must-ignore half, where it is load-bearing: drop a `\b` from any pattern and `kiosk_order_number`
 * starts matching and the self-test fails. That is a real guard; the masking was not.
 */

type Finding = { file: string; line: number; text: string }

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

/** Strip comments so a docblock DESCRIBING the wrong shape is not reported as the wrong shape. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' ')).replace(/\/\/[^\n]*/g, '')
}

/**
 * The forbidden shapes, on one line, with `order_number` / `orderNumber` as the subject.
 * Deliberately narrow: it must not fire on `hasAllocatedOrderNumber(...)` itself, and it must
 * not fire on assignments like `order_number: null`.
 */
const PATTERNS: Array<{ re: RegExp; why: string }> = [
  {
    re: /\b(?:order_number|orderNumber)\s*(?:!==?|===?)\s*(?:null|undefined)/,
    why: 'compares an order number to null/undefined — admits 0',
  },
  {
    re: /\btypeof\s+[\w.?[\]'"]*\b(?:order_number|orderNumber)\b\s*(?:!==?|===?)\s*['"]number['"]/,
    why: "typeof check on an order number — admits 0",
  },
  {
    /**
     * THE FALLBACK MAY SIT EITHER SIDE OF THE CLOSING PAREN, and until 2026-08-27 only one side
     * was matched. `Number(x || 0)` was caught; `Number(x) || 0` was not, though the two are the
     * same defect and produce the same 0. Verified by mutation:
     *
     *     const zzA = Number(order.order_number) || 0     passed GREEN
     *
     * #296 happened to be written the caught way. Which side of the paren the author puts the
     * fallback on is a style choice, and a guard that enforces a style rather than the rule leaves
     * the other spelling open -- the same defect that let `[COPY PENDING:` past the placeholder
     * gate for days.
     *
     * `[^)]*` cannot cross a `)`, so the subject must be inside the same call: a line reading
     * `Number(total); ... order_number || 0` does not match.
     */
    re: /\bNumber\([^)]*\b(?:order_number|orderNumber)\b[^)]*(?:\)\s*)?(?:\|\||\?\?)/,
    why: "coerces an order number with a fallback — Number('') is 0, either side of the paren",
  },
  {
    /**
     * THE SAME COMPARISON WRITTEN THE OTHER WAY ROUND. `null !== order.order_number` passed GREEN
     * on 2026-08-27 because every pattern above requires the order number to be the LEFT operand.
     * A Yoda condition is ordinary style, not an evasion attempt, which is precisely why it has to
     * be covered -- the author has no way to know one operand order is load-bearing.
     *
     * Requires the literal FIRST, so an assignment like `order_number: null` is not a comparison
     * and does not match.
     */
    re: /\b(?:null|undefined)\s*(?:!==?|===?)\s*[\w.?[\]'"]*\b(?:order_number|orderNumber)\b/,
    why: 'compares null/undefined to an order number (reversed operands) — admits 0',
  },
]

/**
 * The whole per-line decision, so the self-test drives THIS rather than a copy of it.
 * Returns the reason, or null when the line is clean.
 */
export function violationOn(line: string): string | null {
  for (const { re, why } of PATTERNS) if (re.test(line)) return why
  return null
}

/**
 * SELF-TEST — this script had none, over 608 files judged entirely by regex.
 *
 * If a pattern stopped matching, it would print "OK — every order-number test goes through
 * hasAllocatedOrderNumber()" across a codebase full of them, and a fourth "Order #0" would reach
 * production exactly as the first three did. This gate exists because a comment could not fail a
 * build; a regex nothing checks is the same thing one layer down.
 *
 * Both halves drive the real `violationOn`. The MUST-IGNORE half is the load-bearing one: masking
 * replaced a whole-line skip, and the widened `Number(...)` and reversed-operand patterns each
 * bought coverage at some false-positive risk. Every entry below is a shape that occurs in this
 * repo and must stay green.
 */
function selfTest(): void {
  const MUST_CATCH: Array<[string, string]> = [
    ['#296, the caught spelling', 'const n = Number(row.order_number || 0)'],
    ['#296, the spelling that evaded until 2026-08-27', 'const n = Number(row.order_number) || 0'],
    ['the ?? variant, outside the paren', 'const n = Number(o.order_number) ?? 0'],
    ['2026-08-19, a real customer saw Order #0', 'if (orderNumber != null) {'],
    ['strict form', 'if (order.order_number !== undefined) {'],
    ['typeof, admits 0', "if (typeof order.order_number === 'number') {"],
    ['reversed operands, evaded until 2026-08-27', 'if (null !== order.order_number) {'],
    ['a real violation sharing a line with an allowed word', 'const ok = order.order_number != null && row.table_number'],
  ]
  for (const [why, line] of MUST_CATCH) {
    if (!violationOn(line)) {
      console.error(`SELF-TEST FAILED: no longer catches ${why}\n  ${line}`)
      process.exit(2)
    }
  }

  const MUST_IGNORE: Array<[string, string]> = [
    ['the sanctioned helper', 'if (hasAllocatedOrderNumber({ order_number })) {'],
    ['the label built on it', 'const label = orderIdentityLabel(order)'],
    ['an assignment, not a comparison', 'await supabase.from("orders").insert({ order_number: null })'],
    ['a table number, which has no allocation rule', 'if (row.table_number != null) {'],
    ['the kiosk counter, which CONTAINS order_number', 'if (o.kiosk_order_number != null) {'],
    ['a merchant reference', 'if (p.merchant_order_no != null) {'],
    ['a form input, which CONTAINS orderNumber', 'if (orderNumberInput !== undefined) {'],
    ['coercion with no fallback at all', 'const n = Number(order.order_number)'],
    ['a fallback on a different column entirely', 'const t = Number(order.total) || 0'],
    ['an unrelated Number() sharing the line', 'const t = Number(total); const s = order_status || 0'],
  ]
  for (const [why, line] of MUST_IGNORE) {
    const hit = violationOn(line)
    if (hit) {
      console.error(`SELF-TEST FAILED: now flags ${why}\n  ${line}\n  reported: ${hit}`)
      process.exit(2)
    }
  }
}

function main() {
  selfTest()
  const files: string[] = []
  for (const dir of SEARCH_DIRS) walk(join(ROOT, dir), files)

  const findings: Finding[] = []

  for (const file of files) {
    const rel = relative(ROOT, file).split(sep).join('/')
    if (ALLOWED_FILES.has(rel)) continue

    const lines = stripComments(readFileSync(file, 'utf8')).split('\n')
    lines.forEach((line, i) => {
      const why = violationOn(line)
      if (why) findings.push({ file: rel, line: i + 1, text: `${line.trim()}   <- ${why}` })
    })
  }

  if (findings.length === 0) {
    console.log(
      `check-order-number-guard: OK — ${files.length} files scanned, every order-number test goes through hasAllocatedOrderNumber().`,
    )
    return
  }

  console.error('\ncheck-order-number-guard: FAILED\n')
  console.error(
    'An order number was tested without hasAllocatedOrderNumber(). That is how "Order #0"\n' +
      'reached production three times: `!= null` and `typeof === "number"` both admit 0, and any\n' +
      'producer that invents a number for a row without one hands you exactly that 0.\n\n' +
      'Use hasAllocatedOrderNumber({ order_number }) — it rejects null, undefined, \'\' and 0\n' +
      'together. See lib/orders/order-identity.ts.\n',
  )
  for (const f of findings) console.error(`  ${f.file}:${f.line}\n      ${f.text}`)
  console.error(`\n${findings.length} finding${findings.length === 1 ? '' : 's'}.\n`)
  process.exit(1)
}

main()
