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
 * Offenders that predate this scan and are NOT order NUMBERS despite matching the shape --
 * `table_number`, `kiosk_order_number` and friends have no allocation rule and 0 is not special.
 * Kept as an explicit list rather than a clever regex so that adding one is a visible decision.
 */
const ALLOWED_SUFFIXES = ['table_number', 'kiosk_order_number', 'merchant_order_no', 'orderNumberInput']

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
    re: /\bNumber\(\s*[\w.?[\]'"]*\b(?:order_number|orderNumber)\b\s*(?:\|\||\?\?)/,
    why: 'coerces an order number with a fallback — Number(\'\') is 0',
  },
]

function main() {
  const files: string[] = []
  for (const dir of SEARCH_DIRS) walk(join(ROOT, dir), files)

  const findings: Finding[] = []

  for (const file of files) {
    const rel = relative(ROOT, file).split(sep).join('/')
    if (ALLOWED_FILES.has(rel)) continue

    const lines = stripComments(readFileSync(file, 'utf8')).split('\n')
    lines.forEach((line, i) => {
      if (ALLOWED_SUFFIXES.some((s) => line.includes(s))) return
      for (const { re, why } of PATTERNS) {
        if (re.test(line)) {
          findings.push({ file: rel, line: i + 1, text: `${line.trim()}   <- ${why}` })
          return
        }
      }
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
