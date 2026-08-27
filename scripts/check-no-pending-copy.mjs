/**
 * NO `PENDING COPY` MARKER MAY REACH PRODUCTION.
 *
 * WHY THIS EXISTS. On 2026-08-21 the restaurant switcher shipped to production carrying five
 * placeholder strings, and the owner of a multi-location account read `PENDING COPY — Location`
 * above the switcher on every one of the twenty staff screens.
 *
 * THERE WERE ALREADY FOUR `PENDING COPY` CHECKS ON MAIN, AND NOT ONE OF THEM COULD HAVE CAUGHT IT:
 *
 *   __tests__/order-alert-copy-signed-off.test.ts   reads components/orders-dashboard.tsx — that file only
 *   __tests__/customer-status-vocabulary.test.ts    asserts on CUSTOMER_STATUS_COPY — that constant only
 *   __tests__/no-invented-order-number.test.ts      asserts on the tabOrderNotYetNumbered key — that key only
 *   __tests__/menu-item-requires-tax-rate.test.ts   asserts on TAX_RATE_REQUIRED_MESSAGE — that constant only
 *
 * Each was written at the moment its own string was signed off, to pin that string. Every one is a
 * PER-STRING PIN; none asks the CLASS question "is there any placeholder anywhere". A file created
 * afterwards — restaurant-switcher.tsx — was invisible to all four, and the convention itself was
 * only ever documented, in the header of lib/customer-copy/qr-redesign-copy.ts, which literally
 * tells the reader to run `git grep "PENDING COPY"` by hand.
 *
 * A convention that depends on somebody remembering to grep is not a gate. This is the gate.
 *
 * THE MARKER IS DELIBERATELY ALLOWED ON STAGING. Shipping a placeholder to staging is the workflow:
 * mark it, build the screen, get the wording signed off, then promote. This runs on the production
 * deploy only — see .github/workflows/production-worker.yml — so it blocks the door it should
 * without breaking the way work actually gets done.
 *
 * Usage:
 *   node scripts/check-no-pending-copy.mjs           # exit 1 if any marker is found
 *   node scripts/check-no-pending-copy.mjs --list    # report and exit 0, to build a sign-off list
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

/**
 * `--root=` exists so the checker can be tested against a fixture instead of only against the repo
 * it happens to be sitting in. A gate whose own behaviour is asserted by running it and reading the
 * output is a gate nobody can change safely.
 */
const ROOT = process.argv.find((a) => a.startsWith('--root='))?.slice('--root='.length) || process.cwd()
const LIST_ONLY = process.argv.includes('--list')

/**
 * Shippable source only. A marker in a test, a script or a doc is not something a customer or a
 * staff member can read — and several of those files legitimately contain the words, because they
 * are the ones enforcing and explaining the convention.
 */
const SEARCH_DIRS = ['app', 'components', 'lib', 'hooks', 'contexts', 'types', 'workers', 'payments']
const SKIP_DIR_NAMES = new Set(['node_modules', '.next', '__tests__', 'tests', '__mocks__'])
const EXTS = ['.ts', '.tsx', '.js', '.jsx', '.mjs']

/**
 * BOTH WORD ORDERS, AND THAT IS NOT PEDANTRY.
 *
 * Found 2026-08-27. `lib/payments/verify-payment-outcome.ts` carries three staff-facing
 * placeholders spelled `[COPY PENDING: ...]`. `/PENDING COPY/` does not match that, so this gate
 * reported OK while all three sat on `main` — live on production — for days.
 *
 * That is the same defect the gate exists to prevent, arriving through the one route the original
 * could not see: not a file it did not scan, but a spelling it did not know. A checker that
 * recognises exactly one phrasing of the convention is a checker that enforces the phrasing rather
 * than the convention, and whoever writes the next placeholder has no way to know which of two
 * natural word orders is the load-bearing one.
 *
 * So: match either order, and any separator between the words. `--list` output is what people use
 * to build a sign-off list, and a placeholder missing from that list is a placeholder nobody signs.
 */
const MARKER = /\b(?:PENDING[\s_-]*COPY|COPY[\s_-]*PENDING)\b/i

function walk(dir, out = []) {
  let entries
  try {
    entries = readdirSync(dir)
  } catch {
    return out
  }
  for (const name of entries) {
    const full = join(dir, name)
    let st
    try {
      st = statSync(full)
    } catch {
      continue
    }
    if (st.isDirectory()) {
      if (SKIP_DIR_NAMES.has(name)) continue
      walk(full, out)
    } else if (EXTS.some((e) => name.endsWith(e))) {
      if (name.includes('.test.') || name.includes('.spec.')) continue
      out.push(full)
    }
  }
  return out
}

/**
 * Comments are stripped before matching, and that is load-bearing rather than a nicety.
 *
 * The docblocks that EXPLAIN this convention say the words — qr-redesign-copy.ts's header, the
 * block comment above the switcher's own copy, and this file. A checker that matched its own
 * explanation would fire on every file that documents the rule and would be turned off within a
 * week. It is the same trap the tab back-button test hit: assert against code, not commentary.
 */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')
}

const hits = []
for (const d of SEARCH_DIRS) {
  for (const file of walk(join(ROOT, d))) {
    const raw = readFileSync(file, 'utf8')
    if (!MARKER.test(raw)) continue
    const code = stripComments(raw)
    if (!MARKER.test(code)) continue
    // Report with real line numbers from the original file, not from the stripped copy.
    const strippedLines = new Set()
    code.split('\n').forEach((l) => {
      if (MARKER.test(l)) strippedLines.add(l.trim())
    })
    raw.split('\n').forEach((line, i) => {
      if (MARKER.test(line) && strippedLines.has(line.trim())) {
        hits.push({ file: relative(ROOT, file).split(sep).join('/'), line: i + 1, text: line.trim() })
      }
    })
  }
}

if (!hits.length) {
  console.log('PENDING COPY CHECK: OK — no placeholder strings in shippable source.')
  process.exit(0)
}

console.log(`PENDING COPY CHECK: ${hits.length} placeholder string(s) found\n`)
let currentFile = null
for (const h of hits) {
  if (h.file !== currentFile) {
    currentFile = h.file
    console.log(`  ${h.file}`)
  }
  console.log(`    :${h.line}  ${h.text}`)
}

if (LIST_ONLY) {
  console.log('\n--list: reporting only, not failing.')
  process.exit(0)
}

console.log(
  '\nThese are placeholders, not wording. Each one is a string somebody has to sign off before it\n' +
    'can ship — that is a decision, not a code change, and it is not this script\'s to make.\n' +
    '\n' +
    'Get the wording signed off and replace the string. Do NOT delete the marker to get past this\n' +
    'check: an unsigned string that no longer announces itself is the exact defect this exists to\n' +
    'prevent, and it is worse than the one it replaces because nothing will find it next time.\n' +
    '\n' +
    'Emergency only: production-worker.yml has a skip_verification input, and the choice is\n' +
    'recorded in the run log.',
)
process.exit(1)
