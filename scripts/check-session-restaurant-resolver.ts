/**
 * EVERY "WHICH RESTAURANT IS THIS USER ON?" MUST GO THROUGH `resolveSessionRestaurantId`.
 *
 * Static, no credentials, no database. Blocking in CI, same class as
 * scripts/check-order-number-guard.ts and scripts/check-migration-inline-check.ts.
 *
 * ============================================================================================
 * WHY THIS EXISTS
 * ============================================================================================
 *
 * On 2026-08-20 there were TWELVE independent answers to this question in the codebase:
 *
 *   lib/{analytics,documents,menu,orders,recipes,settings,staff,stock,tables}/auth.ts
 *       nine byte-identical `resolveStaffRestaurantId` copies -- first restaurant_users row,
 *       no ORDER BY
 *   app/api/auth/role/route.ts          the session bootstrap
 *   app/api/admin/setup-status/route.ts a bare .maybeSingle() -- PGRST116, a 500, for any
 *                                       account with two memberships
 *   app/api/bug-reports/route.ts        attributed the report to the first membership
 *
 * Every one of them was individually correct, and they agreed with each other for as long as
 * every account had exactly one restaurant. The day an organisation held two locations they
 * stopped agreeing, PER PAGE: Analytics could read revenue for one restaurant while the sidebar
 * named another. Analytics, Stock and Documents are money screens.
 *
 * Nothing would have caught it. Each copy typechecked. Each had passing tests. The bug lives
 * strictly in the disagreement BETWEEN them, which is invisible to any test that looks at one.
 * Converging twelve call sites by hand is a one-day fix; keeping them converged is not something
 * a comment can do, which is the lesson of the order-number guard next door.
 *
 * ============================================================================================
 * WHAT COUNTS AS A FINDING
 * ============================================================================================
 *
 * Two shapes, both of which shipped:
 *
 *   A. PICKING A FIRST MEMBERSHIP
 *      `.from('restaurant_users')` filtered by user_id ONLY -- no restaurant_id -- and then
 *      narrowed with `.limit(1)` or `.maybeSingle()`. Filtering by BOTH user_id and restaurant_id
 *      is an authorization check against a restaurant you already have, which is always fine and
 *      is what lib/permissions/authorize.ts does. Selecting every membership without narrowing is
 *      an enumeration, also fine -- that is getRestaurantIdsForUser and resolveUserContexts.
 *
 *   B. THE LEGACY OWNER FALLBACK
 *      `.eq('owner_id', <user id>)` against `restaurants`. That column is the pre-restaurant_users
 *      provisioning path and appears only inside "which restaurant is this person's".
 *
 * ============================================================================================
 * WHAT IS ALLOWED
 * ============================================================================================
 *
 * See ALLOWED_FILES. Anything added there needs a reason in the commit that adds it.
 */
import { readdirSync, readFileSync, statSync } from 'fs'
import { join, relative, sep } from 'path'

const ROOT = process.cwd()
const SEARCH_DIRS = ['app', 'components', 'lib', 'hooks']
const EXTS = ['.ts', '.tsx']

/** The file that IS the answer, plus paths that match a shape for a reason that is not a pick. */
const ALLOWED_FILES = new Map<string, string>([
  [
    'lib/auth/resolve-session-restaurant.ts',
    'the shared resolver itself -- it is where both shapes legitimately live',
  ],
  [
    'app/api/auth/sync-profile/route.ts',
    'legacy provisioning: finds a restaurant by owner_id while BACKFILLING ownership, before ' +
      'memberships necessarily exist. Not a session pick -- it never decides which restaurant a ' +
      'page reads.',
  ],
])

type Finding = { file: string; line: number; shape: string; text: string }

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

/** Collapse a supabase query chain to one line so a multi-line builder can be matched as a unit. */
function queryChains(source: string): { start: number; text: string }[] {
  const lines = source.split(/\r?\n/)
  const chains: { start: number; text: string }[] = []
  for (let i = 0; i < lines.length; i++) {
    if (!/\.from\(\s*['"]restaurant_users['"]\s*\)/.test(lines[i])) continue
    // A chain ends at the first line that does not continue it.
    //
    // A COMMENT LINE INSIDE A CHAIN IS STILL THE CHAIN. Fixed 2026-08-27. A `//` part-way down a
    // builder matches neither `^\s*\.` nor `^\s*\)`, so it terminated the walk and everything below
    // it became invisible -- shape A went unrecognised for that call site. Explaining WHY a query
    // is shaped a certain way is the most natural thing to do in the middle of a builder, and it
    // silently disabled the check.
    //
    // This is the SAME BUG the sibling scan already hit and already fixed: see the note in
    // scripts/check-orders-read-bounded.ts's chainFrom(), where a comment between `.from('orders')`
    // and `.update(...)` made an UPDATE read as an unbounded SELECT. Its remedy is reused here
    // rather than a second approach invented -- skip the comment lines so the chain keeps walking.
    //
    // The comment's TEXT is replaced with a blank rather than absorbed. The sibling scan pushes the
    // raw comment line, which is harmless there but would not be here: this detector matches on
    // `.eq('user_id'` and `.is('deleted_at'` appearing in the joined chain text, so a comment
    // MENTIONING those -- exactly what a comment explaining a soft-delete filter contains -- could
    // make a legitimate authorization check read as shape A. Blanking keeps the chain contiguous
    // without letting prose vote on the verdict.
    const parts: string[] = [lines[i]]
    for (let j = i + 1; j < lines.length && j < i + 15; j++) {
      let k = j
      while (k < lines.length && /^\s*(\/\/|\/\*|\*)/.test(lines[k])) k++
      const next = lines[k]
      if (next === undefined) break
      if (!/^\s*\./.test(next) && !/^\s*\)/.test(next)) break
      for (let c = j; c < k; c++) parts.push(' ')
      parts.push(next)
      j = k
    }
    chains.push({ start: i + 1, text: parts.join(' ') })
  }
  return chains
}

function findingsFor(rel: string, source: string): Finding[] {
  const found: Finding[] = []

  // Shape A -- picking a first membership.
  for (const chain of queryChains(source)) {
    const byUser = /\.eq\(\s*['"]user_id['"]/.test(chain.text)
    const byRestaurant = /\.eq\(\s*['"]restaurant_id['"]/.test(chain.text)
    const narrowed = /\.limit\(\s*1\s*\)|\.maybeSingle\(\)|\.single\(\)/.test(chain.text)
    if (byUser && !byRestaurant && narrowed) {
      found.push({
        file: rel,
        line: chain.start,
        shape: 'A: picks a FIRST restaurant_users row for a user',
        text: chain.text.replace(/\s+/g, ' ').trim().slice(0, 140),
      })
    }
  }

  // Shape B -- the legacy owner fallback.
  const lines = source.split(/\r?\n/)
  lines.forEach((line, index) => {
    if (/\.eq\(\s*['"]owner_id['"]\s*,/.test(line)) {
      found.push({
        file: rel,
        line: index + 1,
        shape: 'B: resolves a restaurant via the legacy owner_id fallback',
        text: line.trim().slice(0, 140),
      })
    }
  })

  return found
}

/**
 * THE SCAN MUST PROVE IT CAN STILL SEE, BEFORE IT REPORTS THAT IT SEES NOTHING.
 *
 * A detector whose regex stops matching -- a formatter reflows a chain, someone renames a column --
 * reports "OK" over a codebase full of offenders, and that green is indistinguishable from a real
 * one. So: two fixtures that MUST be caught, and one that must NOT, checked on every run. This is
 * the positive control the security-probe lesson asks for, applied to a static scan.
 */
const SELF_TEST_MUST_CATCH: [string, string][] = [
  [
    'shape A -- first membership pick',
    `const { data } = await supabase
      .from('restaurant_users')
      .select('restaurant_id')
      .eq('user_id', userId)
      .is('deleted_at', null)
      .limit(1)
      .maybeSingle()`,
  ],
  [
    'shape B -- legacy owner fallback',
    `await supabase.from('restaurants').select('id').eq('owner_id', userId).limit(1)`,
  ],
  [
    /**
     * A COMMENT INSIDE THE CHAIN IS STILL THE CHAIN. Added 2026-08-27.
     *
     * `queryChains` ended a chain at the first line matching neither `^\s*\.` nor `^\s*\)`, so a
     * `//` line part-way down terminated the walk: everything below it was invisible and shape A
     * went unrecognised. Explaining WHY a query is written a certain way is the most natural thing
     * to do in the middle of a builder, and it silently disabled the check for that call site.
     *
     * This is not a new discovery. `scripts/check-orders-read-bounded.ts` hit the identical bug --
     * its own comment records a comment between `.from('orders')` and `.update(...)` causing an
     * UPDATE to be read as an unbounded SELECT -- and fixed it by skipping comment lines and
     * ABSORBING them so the chain text stays contiguous. That fix is reused here verbatim in
     * shape rather than reinvented.
     */
    'shape A with a comment part-way down the chain',
    `const { data } = await supabase
      .from('restaurant_users')
      .select('restaurant_id')
      .eq('user_id', userId)
      // the soft-delete filter matters: a removed membership must not resolve
      .is('deleted_at', null)
      .limit(1)
      .maybeSingle()`,
  ],
]

const SELF_TEST_MUST_IGNORE: [string, string][] = [
  [
    'authorization check against a known restaurant',
    `const { data } = await supabase
      .from('restaurant_users')
      .select('role')
      .eq('user_id', userId)
      .eq('restaurant_id', restaurantId)
      .maybeSingle()`,
  ],
  [
    'enumerating every membership',
    `const { data } = await supabase
      .from('restaurant_users')
      .select('restaurant_id, role')
      .eq('user_id', userId)
      .is('deleted_at', null)`,
  ],
  [
    /**
     * FALSE-POSITIVE GUARD for the comment-absorption fix above, and the reason comment text is
     * BLANKED rather than joined into the chain.
     *
     * This is a legitimate authorization check -- it names a known `restaurant_id`, so it is not
     * resolving anything. But its comment mentions the soft-delete filter and the user lookup,
     * which are the very tokens shape A matches on. If the walker joined comment text into the
     * chain, this correct call site would be reported as a resolver. Widening a chain walker to
     * see through comments trades a false negative for a false positive unless the prose is
     * excluded from the match, and this pins that it is.
     */
    'authorization check whose COMMENT mentions the resolver shape',
    `const { data } = await supabase
      .from('restaurant_users')
      .select('role')
      // unlike the resolver we do not .is('deleted_at', null) then .limit(1) on user_id alone
      .eq('user_id', userId)
      .eq('restaurant_id', restaurantId)
      .maybeSingle()`,
  ],
]

function selfTest(): void {
  const broken: string[] = []

  for (const [label, fixture] of SELF_TEST_MUST_CATCH) {
    if (findingsFor('<self-test>', fixture).length === 0) {
      broken.push(`detector no longer catches: ${label}`)
    }
  }
  for (const [label, fixture] of SELF_TEST_MUST_IGNORE) {
    if (findingsFor('<self-test>', fixture).length > 0) {
      broken.push(`detector now false-positives on: ${label}`)
    }
  }

  if (broken.length > 0) {
    console.error(
      '\ncheck-session-restaurant-resolver: SELF-TEST FAILED -- the scan cannot be trusted.\n' +
        'It would have reported a result over a codebase it can no longer read correctly.\n',
    )
    for (const line of broken) console.error(`  ${line}`)
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
    const source = readFileSync(file, 'utf8')
    const fileFindings = findingsFor(rel, source)
    if (fileFindings.length === 0) continue

    if (ALLOWED_FILES.has(rel)) {
      usedAllowances.add(rel)
      continue
    }
    findings.push(...fileFindings)
  }

  // A stale allowance is a finding of its own: it means the scan is guarding something that has
  // moved, and the next real offender in that file would be waved through.
  const staleAllowances = [...ALLOWED_FILES.keys()].filter((rel) => !usedAllowances.has(rel))

  if (findings.length === 0 && staleAllowances.length === 0) {
    console.log(
      `check-session-restaurant-resolver: OK -- ${files.length} files scanned, ` +
        `every session-restaurant lookup goes through resolveSessionRestaurantId.`,
    )
    return
  }

  if (findings.length > 0) {
    console.error(
      `\ncheck-session-restaurant-resolver: ${findings.length} finding(s).\n\n` +
        `A call site is deriving the session's restaurant itself instead of calling\n` +
        `resolveSessionRestaurantId() from lib/auth/resolve-session-restaurant.ts.\n\n` +
        `That is how a user ends up on two different restaurants depending on the page.\n`,
    )
    for (const f of findings) {
      console.error(`  ${f.file}:${f.line}`)
      console.error(`    ${f.shape}`)
      console.error(`    ${f.text}\n`)
    }
  }

  if (staleAllowances.length > 0) {
    console.error(
      `\ncheck-session-restaurant-resolver: ${staleAllowances.length} STALE allowance(s) -- ` +
        `listed in ALLOWED_FILES but no longer matching any shape. Remove them, or the next real\n` +
        `offender in that file is waved through silently:\n`,
    )
    for (const rel of staleAllowances) console.error(`  ${rel}`)
    console.error('')
  }

  process.exit(1)
}

main()
