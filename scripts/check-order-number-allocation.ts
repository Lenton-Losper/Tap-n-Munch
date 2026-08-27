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

/**
 * RULE 3 — THE VALUE WRITTEN TO AN ALLOCATED COLUMN, JUDGED PER CALL SITE.
 *
 * ============================================================================================
 * WHY RULE 2 WAS NOT ENOUGH, found 2026-08-27 by mutation
 * ============================================================================================
 *
 * Rule 2 is guarded by `if (!importsAllocator)` — a FILE-LEVEL signal for a defect that is
 * PER CALL SITE. One import statement anywhere in a file disables it for every write in that file.
 *
 * Planting a hand-rolled second allocator in `lib/orders/create-order.ts`:
 *
 *     supabase.from('orders').insert({ restaurant_id, order_number: (last?.order_number ?? 0) + 1 })
 *
 * produced: "OK — 603 files scanned, every order number is issued by lib/orders/order-number.ts."
 * Rule 1 missed it too (its pattern needs a `count`-shaped name), so BOTH rules passed over the
 * exact defect the file's title forbids.
 *
 * FOUR files hold that blanket exemption, and they are the worst four to be blind in:
 *   app/api/orders/route.ts   <- named in this script's OWN docblock as having held TWO of the
 *                                five historical count(*)+1 allocators
 *   app/api/order-requests/[requestId]/accept/route.ts
 *   lib/orders/create-order.ts
 *   lib/supabase/orders.ts
 * A sixth allocator written inside any of them could not fail this gate.
 *
 * ============================================================================================
 * WHY THE EXEMPTION IS NARROWED RATHER THAN DELETED
 * ============================================================================================
 *
 * Deleting `if (!importsAllocator)` was the obvious fix and it is wrong: it produces FOUR findings
 * on a correct tree, because those files legitimately write the number the allocator handed them.
 * All four write a BARE IDENTIFIER —
 *
 *     order_number: orderNumber          lib/orders/create-order.ts:133
 *     order_number: allocated            app/api/orders/route.ts:542
 *     kiosk_order_number: kioskNumber    app/api/orders/route.ts:603
 *     kiosk_order_number: kioskOrderNumber
 *                                        app/api/order-requests/[requestId]/accept/route.ts:226
 *
 * — which is what passing an allocated value through looks like. A gate that opens with four false
 * positives on correct code is one somebody switches off, and this repo has already recorded that
 * failure twice.
 *
 * So the discriminator is PROVENANCE, not location: a value that is handed to the write is fine; a
 * value the write DERIVES for itself is a second allocator regardless of what the file imports.
 * Deriving is the whole defect — count(*)+1 and max+1 both drop or collide when a row leaves the
 * table, which is why the allocator retries on the unique index's 23505 instead.
 *
 * Kept deliberately narrow: arithmetic, a row count, a length, a max. Anything subtler than this is
 * a value someone computed elsewhere and passed in, which rule 1 and the allocator's own retry
 * already cover, and widening further would start flagging the four correct sites above.
 */
const DERIVED_VALUE = /\+\s*1\b|\.length\b|\bcount\b|\bmax\s*\(/i

/**
 * The value expression for `column:` inside a write body — up to the comma that ends the property,
 * ignoring commas nested inside parens, brackets or braces.
 */
function valueExpressionFor(body: string, column: string): { value: string; index: number } | null {
  const key = new RegExp(`(^|[{,\\s])${column}\\s*:`)
  const m = key.exec(body)
  if (!m) return null
  const start = m.index + m[0].length
  let depth = 0
  let i = start
  for (; i < body.length; i += 1) {
    const c = body[i]
    if (c === '(' || c === '[' || c === '{') depth += 1
    else if (c === ')' || c === ']' || c === '}') {
      if (depth === 0) break
      depth -= 1
    } else if (c === ',' && depth === 0) break
  }
  return { value: body.slice(start, i), index: m.index }
}

/**
 * SELF-TEST — this script had none, over 603 files and two rules of pure regex.
 *
 * If any pattern here stops matching, the script reports "OK — every order number is issued by
 * lib/orders/order-number.ts" over a codebase full of offenders and nothing notices. That is the
 * failure mode the sibling gates check-orders-read-bounded.ts and check-session-restaurant-
 * resolver.ts were each given a self-test to prevent; the lesson had not been applied here.
 *
 * These drive the REAL `valueExpressionFor` and the REAL `DERIVED_VALUE`, not a copy. The
 * must-ignore half is the load-bearing half: it is the four correct call sites, verbatim, and it is
 * what stops a future widening of DERIVED_VALUE from turning this gate into four false positives on
 * a correct tree.
 */
function selfTest(): void {
  const derived = (body: string, column = 'order_number') => {
    const e = valueExpressionFor(body, column)
    return e !== null && DERIVED_VALUE.test(e.value)
  }

  const MUST_CATCH: Array<[string, string]> = [
    ['the 2026-08-27 mutation that got past rule 2', '{ restaurant_id: r, order_number: (last?.order_number ?? 0) + 1 }'],
    ['count(*)+1, the shape of all five historical allocators', '{ order_number: (count || 0) + 1 }'],
    ['a length-derived sequence', '{ order_number: existing.length + 1 }'],
    ['max()+1 written inline', '{ order_number: max(rows) + 1 }'],
    ['the kiosk counter, same defect', '{ kiosk_order_number: (c ?? 0) + 1 }'],
  ]
  for (const [why, body] of MUST_CATCH) {
    const column = body.includes('kiosk_order_number') ? 'kiosk_order_number' : 'order_number'
    if (!derived(body, column)) {
      console.error(`SELF-TEST FAILED: no longer catches ${why}\n  ${body}`)
      process.exit(2)
    }
  }

  // FALSE-POSITIVE GUARD: the four real call sites on this tree, which pass the allocator's own
  // value through and MUST stay green. See the rule 3 docblock.
  const MUST_IGNORE: Array<[string, string]> = [
    ['lib/orders/create-order.ts:133', '{ tab_id: t, order_number: orderNumber, channel: c }'],
    ['app/api/orders/route.ts:542', '{ total: p.total, order_number: allocated, channel }'],
    ['app/api/orders/route.ts:603', '{ kiosk_order_number: kioskNumber }'],
    ['accept/route.ts:226', '{ kiosk_order_number: kioskOrderNumber }'],
  ]
  for (const [where, body] of MUST_IGNORE) {
    const column = body.includes('kiosk_order_number') ? 'kiosk_order_number' : 'order_number'
    if (derived(body, column)) {
      console.error(`SELF-TEST FAILED: now flags a correct pass-through at ${where}\n  ${body}`)
      process.exit(2)
    }
  }

  // The value extractor must stop at the property's own comma, or every write body reads as one
  // expression and a `+ 1` anywhere in it would flag the wrong column.
  const e = valueExpressionFor('{ order_number: allocated, total: subtotal + 1 }', 'order_number')
  if (e === null || e.value.trim() !== 'allocated') {
    console.error(`SELF-TEST FAILED: value extraction crossed a property boundary — got ${JSON.stringify(e?.value)}`)
    process.exit(2)
  }
}

function main() {
  selfTest()
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

    // ---- rule 3: runs on EVERY file, including the four that import the allocator
    for (const [start, end] of writeCallRanges(src)) {
      const body = src.slice(start, end)
      for (const column of ALLOCATED_COLUMNS) {
        const expr = valueExpressionFor(body, column)
        if (expr && DERIVED_VALUE.test(expr.value)) {
          findings.push({
            file: rel,
            line: lineOf(start + expr.index),
            text: `${column}:${expr.value.trim()}`,
            why: 'derives the number in the write itself — a second allocator, whatever the file imports',
          })
        }
      }
    }

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
