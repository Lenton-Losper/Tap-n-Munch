/**
 * Fails the build if a migration attaches an inline CHECK constraint to
 * `ADD COLUMN IF NOT EXISTS` (#212). Static: reads only the files in
 * supabase/migrations/, needs no credentials, and touches no database.
 *
 * THE DEFECT
 * `IF NOT EXISTS` makes the ADD COLUMN idempotent. The inline CHECK is part of
 * the COLUMN DEFINITION, so it is idempotent with it: if the column already
 * exists, Postgres skips the whole action and the constraint is never created.
 * The migration still reports success. The result is a database that satisfies
 * the migration ledger and does not have the constraint, and nothing downstream
 * can tell — the failure is silent by construction, and surfaces later only as a
 * value nobody believed was writable.
 *
 * That is not hypothetical here. `20260620150000_terminal_api_layer.sql` adds
 * `restaurant_terminals.status` this way, and the vocabulary of
 * `restaurant_terminals_status_check` on PRODUCTION is recorded as deliberately
 * unverified — settling it means writing to the table that gates terminal
 * authentication on the live estate. This pattern is a mechanism by which that
 * constraint could be absent there while present on staging.
 *
 * THE CORRECT IDIOM, already used by 20260628110000 and 20260629150000 for
 * their CONSTRAINT changes:
 *
 *     ALTER TABLE t ADD COLUMN IF NOT EXISTS c text NOT NULL DEFAULT 'x';
 *     ALTER TABLE t DROP CONSTRAINT IF EXISTS t_c_check;
 *     ALTER TABLE t ADD CONSTRAINT t_c_check CHECK (c IN (...));
 *
 * Both halves are then independently idempotent, and the constraint is created
 * whether or not the column was.
 *
 * WHY THIS IS NOT A GREP
 * In every violation in this repo the CHECK sits on a CONTINUATION LINE, so a
 * line-oriented `grep 'ADD COLUMN IF NOT EXISTS.*CHECK'` matches NONE of them
 * and reports a clean sheet. A clean sheet from a check that cannot see the
 * defect is worse than no check at all: it is a green light nobody re-examines.
 * So this parses statements, not lines.
 *
 * Usage: npx tsx scripts/check-migration-inline-check.ts [migrationsDir]
 */
import { readdirSync, readFileSync } from 'fs'
import { join } from 'path'

const DEFAULT_MIGRATIONS_DIR = join(process.cwd(), 'supabase', 'migrations')

export type InlineCheckViolation = {
  /** Line of the `ADD COLUMN IF NOT EXISTS`. */
  columnLine: number
  /** Line of the `CHECK (` — a DIFFERENT line in every real case, which is the point. */
  checkLine: number
  snippet: string
}

/**
 * Migrations that ALREADY carry this defect and have ALREADY been applied.
 *
 * They are not fixed here, on purpose. A committed migration that has run
 * against an environment is never rewritten — the standing rule is that a
 * verified-present object gets a ledger repair, never a re-run — so editing
 * these files would rewrite history without changing any database, and would
 * make the file disagree with what was actually applied.
 *
 * This is therefore a BASELINE, not an exemption: it stops the gate failing on
 * history while still failing on anything NEW. It must only ever shrink, and
 * the check enforces that by failing when an entry no longer violates.
 *
 * That last rule turns out to do a second job worth keeping deliberately. A
 * check like this cannot otherwise detect its OWN blindness: regress the parser
 * to a line-oriented match and it reports "0 violations, OK" and exits 0, which
 * looks exactly like success. Because these five files are KNOWN to violate, a
 * parser that stops seeing them fails as a stale baseline instead. Measured by
 * probe: with the parser regressed to a same-line regex, the gate exits 1 and
 * names all five. Do not "simplify" this into a plain ignore-list.
 *
 * Whether each of these constraints is actually PRESENT on production is a
 * separate and open question. This static check cannot answer it and does not
 * pretend to.
 */
export const BASELINE = new Map<string, string>([
  [
    '20260620150000_terminal_api_layer.sql',
    'restaurant_terminals.status — see header; production state unverified',
  ],
  ['20260628110000_add_cashier_kitchen_roles.sql', 'staff_permissions.effect'],
  ['20260629120000_add_order_channel.sql', 'orders.channel'],
  ['20260719110000_organizations_and_membership.sql', 'restaurants.location_type'],
  ['20260724180000_platform_ops_console.sql', 'platform_ops_tickets.status'],
])

/**
 * Blanks out everything the structural scan must not read: line and block
 * comments, single- and double-quoted literals, and dollar-quoted bodies.
 *
 * Replaced CHARACTER FOR CHARACTER with spaces, with newlines preserved, so
 * every offset in the masked text still maps to the same line in the original.
 * Without this, an apostrophe in a comment or a parenthesis inside a `$$`
 * function body corrupts the depth tracking below, and the scan then reports
 * nonsense with complete confidence. 40 of this repo's migrations contain `$$`
 * bodies.
 */
export function maskNonCode(sql: string): string {
  const out = sql.split('')
  const n = sql.length
  let i = 0

  const blank = (from: number, to: number) => {
    for (let k = from; k < to && k < n; k++) {
      if (out[k] !== '\n') out[k] = ' '
    }
  }

  while (i < n) {
    const two = sql.slice(i, i + 2)

    if (two === '--') {
      let end = sql.indexOf('\n', i)
      if (end === -1) end = n
      blank(i, end)
      i = end
      continue
    }

    if (two === '/*') {
      const found = sql.indexOf('*/', i + 2)
      const end = found === -1 ? n : found + 2
      blank(i, end)
      i = end
      continue
    }

    // Dollar quoting: $$ ... $$ or $tag$ ... $tag$
    const dollar = /^\$[A-Za-z_0-9]*\$/.exec(sql.slice(i))
    if (dollar) {
      const tag = dollar[0]
      const found = sql.indexOf(tag, i + tag.length)
      const end = found === -1 ? n : found + tag.length
      blank(i, end)
      i = end
      continue
    }

    if (sql[i] === "'" || sql[i] === '"') {
      const quote = sql[i]
      let j = i + 1
      while (j < n) {
        // '' and "" are escaped quotes in SQL, not terminators.
        if (sql[j] === quote && sql[j + 1] === quote) {
          j += 2
          continue
        }
        if (sql[j] === quote) break
        j++
      }
      const end = Math.min(j + 1, n)
      blank(i, end)
      i = end
      continue
    }

    i++
  }

  return out.join('')
}

const lineOf = (text: string, offset: number): number => text.slice(0, offset).split('\n').length

/**
 * Splits an ALTER TABLE action list on TOP-LEVEL commas only.
 *
 * The comma inside `CHECK (status IN ('active', 'revoked'))` is nested, and a
 * naive split would tear one action into fragments and lose the association
 * between the column and its CHECK — which is the entire thing this detects.
 */
function splitTopLevel(masked: string, start: number, end: number): Array<[number, number]> {
  const parts: Array<[number, number]> = []
  let depth = 0
  let from = start
  for (let i = start; i < end; i++) {
    const ch = masked[i]
    if (ch === '(') depth++
    else if (ch === ')') depth--
    else if (ch === ',' && depth === 0) {
      parts.push([from, i])
      from = i + 1
    }
  }
  parts.push([from, end])
  return parts
}

const ADD_COLUMN_IF_NOT_EXISTS = /\bADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\b/i
const INLINE_CHECK = /\bCHECK\s*\(/i

/** Every `ADD COLUMN IF NOT EXISTS ... CHECK (...)` in one file's SQL. */
export function findInlineChecks(sql: string): InlineCheckViolation[] {
  const masked = maskNonCode(sql)
  const violations: InlineCheckViolation[] = []

  let cursor = 0
  while (cursor < masked.length) {
    let end = masked.indexOf(';', cursor)
    if (end === -1) end = masked.length

    if (/\bALTER\s+TABLE\b/i.test(masked.slice(cursor, end))) {
      for (const [from, to] of splitTopLevel(masked, cursor, end)) {
        const action = masked.slice(from, to)
        if (!ADD_COLUMN_IF_NOT_EXISTS.test(action)) continue

        const check = INLINE_CHECK.exec(action)
        if (!check) continue

        // Snippet starts at the ADD COLUMN, not at the action start: an action
        // begins after the previous `;`, so slicing from there leads with any
        // intervening comments and the 140-char truncation then cuts away the
        // very text the developer needs to see.
        const columnOffset = from + action.search(ADD_COLUMN_IF_NOT_EXISTS)
        violations.push({
          columnLine: lineOf(sql, columnOffset),
          checkLine: lineOf(sql, from + check.index),
          snippet: sql.slice(columnOffset, to).trim().replace(/\s+/g, ' ').slice(0, 140),
        })
      }
    }

    cursor = end + 1
  }

  return violations
}

export function scanDirectory(dir: string): Map<string, InlineCheckViolation[]> {
  const offenders = new Map<string, InlineCheckViolation[]>()
  for (const name of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
    const found = findInlineChecks(readFileSync(join(dir, name), 'utf8'))
    if (found.length > 0) offenders.set(name, found)
  }
  return offenders
}

function main(): void {
  const dir = process.argv[2] || DEFAULT_MIGRATIONS_DIR
  const total = readdirSync(dir).filter((f) => f.endsWith('.sql')).length
  const offenders = scanDirectory(dir)

  console.log(
    `INLINE CHECK CONSTRAINT CHECK: scanned ${total} migration(s), ${offenders.size} with an ` +
      `inline CHECK on ADD COLUMN IF NOT EXISTS (${BASELINE.size} known and baselined).`
  )

  const newOffenders = [...offenders.keys()].filter((name) => !BASELINE.has(name))
  const staleBaseline = [...BASELINE.keys()].filter((name) => !offenders.has(name))

  if (newOffenders.length === 0 && staleBaseline.length === 0) {
    console.log('INLINE CHECK CONSTRAINT CHECK: OK — no new inline CHECK constraints.')
    return
  }

  console.error('INLINE CHECK CONSTRAINT CHECK: FAILED')

  if (newOffenders.length > 0) {
    console.error(
      '\n  An inline CHECK on ADD COLUMN IF NOT EXISTS is SILENTLY SKIPPED when the column\n' +
        '  already exists. The migration succeeds and the constraint is never created.\n'
    )
    for (const name of newOffenders) {
      for (const v of offenders.get(name) || []) {
        console.error(`  ${name}`)
        console.error(`    column defined at line ${v.columnLine}, CHECK at line ${v.checkLine}`)
        console.error(`    ${v.snippet}`)
      }
    }
    console.error(
      '\n  Split it into two independently idempotent statements:\n' +
        "    ALTER TABLE t ADD COLUMN IF NOT EXISTS c text NOT NULL DEFAULT 'x';\n" +
        '    ALTER TABLE t DROP CONSTRAINT IF EXISTS t_c_check;\n' +
        '    ALTER TABLE t ADD CONSTRAINT t_c_check CHECK (c IN (...));\n'
    )
  }

  if (staleBaseline.length > 0) {
    console.error(
      '\n  STALE BASELINE — listed as known offenders but no longer violating.\n' +
        '  Remove them from BASELINE in this script so the list keeps shrinking:\n'
    )
    for (const name of staleBaseline) console.error(`    ${name}`)
  }

  process.exit(1)
}

// Only runs when invoked directly, so tests can import the parser without the
// process exiting under them.
if (process.argv[1] && /check-migration-inline-check/.test(process.argv[1])) {
  main()
}
