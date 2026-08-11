/**
 * Fails CI when a migration attaches an inline CHECK to `ADD COLUMN IF NOT EXISTS` (#212).
 *
 * WHY THIS IS A REAL FAILURE AND NOT A STYLE RULE
 * `IF NOT EXISTS` short-circuits the whole ADD COLUMN item, and the item's inline constraint
 * goes with it. When the column already exists the CHECK is never created, and the migration
 * then READS as though it constrains the column while enforcing nothing. Proven against
 * staging on restaurant_terminals.status (#193): the enforced vocabulary is the baseline's
 * {active, inactive, pending, revoked}; 20260620150000's {active, revoked, maintenance,
 * pending_update} never applied.
 *
 * The correct idiom is already used in this repo — DROP CONSTRAINT IF EXISTS, then a separate
 * ADD CONSTRAINT ... CHECK (20260628110000 lines 2-20, 20260629150000 in full). So this is a
 * slip, and slips are what lint is for.
 *
 * THE RULE MUST BE MULTILINE, WHICH IS THE ENTIRE POINT
 * In every hit found so far the CHECK sits on a CONTINUATION line, so a line-oriented grep
 * matches none of them and reports a clean sheet — worse than having no check at all. This
 * scanner therefore works on STATEMENTS, not lines: it splits on semicolons outside strings,
 * comments and dollar-quoted bodies, then attributes each CHECK to the ALTER item it sits in.
 *
 * BASELINE, NOT A SWEEP
 * The hits already committed cannot be fixed by editing the files: an applied migration is
 * immutable, and rewriting one desynchronises it from the ledger. They are listed in BASELINE
 * below with the remediation each needs, and the check fails only on hits that are NOT in it.
 * That makes this a ratchet: existing debt is recorded and visible, new debt cannot land.
 * Removing a BASELINE entry is the way to prove the rule still sees that hit.
 *
 * Usage: node scripts/check-migration-inline-checks.mjs
 * Exits 0 when the only hits are baselined, 1 otherwise. Reads nothing but the filesystem.
 */
import { readdirSync, readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath, pathToFileURL } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const MIGRATIONS_DIR = join(__dirname, '..', 'supabase', 'migrations')

/**
 * Hits that existed when this check was introduced, keyed `<file>:<column>`.
 *
 * Each is a constraint that silently did not apply wherever the column already existed. None
 * can be repaired by editing the file — the fix is a NEW migration using DROP CONSTRAINT IF
 * EXISTS + ADD CONSTRAINT. Recorded here rather than deleted so the debt stays greppable.
 */
const BASELINE = new Set([
  // restaurant_terminals.status — #193. PROVEN not applied on staging by probe: the enforced
  // vocabulary is still the baseline's {active, inactive, pending, revoked}, not this file's
  // {active, revoked, maintenance, pending_update}. Production is deliberately unverified.
  '20260620150000_terminal_api_layer.sql:status',

  // orders.channel — ALREADY REMEDIATED downstream, and it is the worked example of the fix.
  // 20260629150000_orders_pos_channel.sql drops both possible constraint names and re-adds a
  // named one. Kept in the baseline because the slip is still in this file; the check is about
  // the shape, not about whether someone later noticed.
  '20260629120000_add_order_channel.sql:channel',

  // staff_permissions.effect — the same slip, in the file whose FIRST 20 LINES demonstrate the
  // correct DROP+ADD idiom three times over. That is what makes it worth lint rather than
  // documentation: knowing the idiom does not stop the slip.
  '20260628110000_add_cashier_kitchen_roles.sql:effect',

  // restaurants.location_type — quoted identifiers throughout; the only hit where the column
  // name is quoted, which is what caught a parse bug in this scanner's first draft.
  '20260719110000_organizations_and_membership.sql:location_type',

  // bug_reports.status.
  '20260724180000_platform_ops_console.sql:status',
])

/**
 * Blank out comments, string literals and dollar-quoted bodies, preserving length and newlines
 * so every offset still maps to its original line. Dollar quoting matters: several migrations
 * define PL/pgSQL functions whose bodies contain semicolons, and splitting on those would tear
 * a statement in half and lose the association between an ADD COLUMN and its CHECK.
 */
function blankNonCode(sql) {
  const out = sql.split('')
  let i = 0
  const blank = (from, to) => {
    for (let k = from; k < to && k < out.length; k++) {
      if (out[k] !== '\n') out[k] = ' '
    }
  }

  while (i < sql.length) {
    const two = sql.slice(i, i + 2)

    if (two === '--') {
      const end = sql.indexOf('\n', i)
      const stop = end === -1 ? sql.length : end
      blank(i, stop)
      i = stop
      continue
    }

    if (two === '/*') {
      // Postgres block comments nest.
      let depth = 1
      let k = i + 2
      while (k < sql.length && depth > 0) {
        if (sql.slice(k, k + 2) === '/*') { depth++; k += 2; continue }
        if (sql.slice(k, k + 2) === '*/') { depth--; k += 2; continue }
        k++
      }
      blank(i, k)
      i = k
      continue
    }

    if (sql[i] === "'") {
      let k = i + 1
      while (k < sql.length) {
        if (sql[k] === "'" && sql[k + 1] === "'") { k += 2; continue }
        if (sql[k] === "'") { k++; break }
        k++
      }
      blank(i, k)
      i = k
      continue
    }

    // Quoted identifiers are deliberately NOT blanked. 20260719110000 writes the column as
    // `ADD COLUMN IF NOT EXISTS "location_type" text ...`, and blanking the quotes made the
    // scanner report the column as "text" — it had matched the TYPE. The name is what the
    // baseline is keyed on, so losing it makes every key unstable. Semicolons and commas
    // inside a quoted identifier are handled by skipping the region in the two splitters
    // below instead.

    const dollar = /^\$[A-Za-z_0-9]*\$/.exec(sql.slice(i))
    if (dollar) {
      const tag = dollar[0]
      const end = sql.indexOf(tag, i + tag.length)
      const stop = end === -1 ? sql.length : end + tag.length
      blank(i, stop)
      i = stop
      continue
    }

    i++
  }

  return out.join('')
}

/** Index just past a quoted identifier starting at `i`, or `i` when there is none. */
function skipQuotedIdentifier(code, i) {
  if (code[i] !== '"') return i
  let k = i + 1
  while (k < code.length) {
    if (code[k] === '"' && code[k + 1] === '"') { k += 2; continue }
    if (code[k] === '"') return k + 1
    k++
  }
  return k
}

/** Split into statements on semicolons that are outside parentheses, strings and comments. */
function statements(code) {
  const out = []
  let depth = 0
  let start = 0
  for (let i = 0; i < code.length; i++) {
    const skipped = skipQuotedIdentifier(code, i)
    if (skipped !== i) { i = skipped - 1; continue }
    const c = code[i]
    if (c === '(') depth++
    else if (c === ')') depth = Math.max(0, depth - 1)
    else if (c === ';' && depth === 0) {
      out.push({ start, text: code.slice(start, i) })
      start = i + 1
    }
  }
  if (start < code.length) out.push({ start, text: code.slice(start) })
  return out
}

/**
 * The span of one ALTER item: from `ADD COLUMN IF NOT EXISTS` to the next comma at paren depth
 * 0, or the end of the statement. Stopping at that comma is what keeps the rule precise — a
 * sibling `ADD CONSTRAINT ... CHECK (...)` in the same ALTER is a separate item, applies
 * unconditionally, and must NOT be reported.
 */
function itemSpan(stmt, from) {
  let depth = 0
  for (let i = from; i < stmt.length; i++) {
    const skipped = skipQuotedIdentifier(stmt, i)
    if (skipped !== i) { i = skipped - 1; continue }
    const c = stmt[i]
    if (c === '(') depth++
    else if (c === ')') depth = Math.max(0, depth - 1)
    else if (c === ',' && depth === 0) return stmt.slice(from, i)
  }
  return stmt.slice(from)
}

function lineOf(source, offset) {
  return source.slice(0, offset).split('\n').length
}

const ADD_COLUMN_IF_NOT_EXISTS = /\bADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s+("?[A-Za-z_][A-Za-z_0-9]*"?)/gi

export function findInlineChecks(sql) {
  const code = blankNonCode(sql)
  const hits = []

  for (const stmt of statements(code)) {
    ADD_COLUMN_IF_NOT_EXISTS.lastIndex = 0
    let m
    while ((m = ADD_COLUMN_IF_NOT_EXISTS.exec(stmt.text)) !== null) {
      const span = itemSpan(stmt.text, m.index)
      const check = /\bCHECK\s*\(/i.exec(span)
      if (!check) continue
      hits.push({
        column: m[1].replace(/"/g, ''),
        line: lineOf(sql, stmt.start + m.index),
        checkLine: lineOf(sql, stmt.start + m.index + check.index),
      })
    }
  }

  return hits
}

/**
 * `node scripts/check-migration-inline-checks.mjs [dir] [--json]`
 *
 * `dir` exists so the test suite can drive THIS script — the artifact CI actually runs — over
 * fixture SQL, rather than carrying its own copy of the rule and proving only that the copy
 * works (#205). A custom dir disables BASELINE, which is keyed to real filenames.
 */
function main() {
  const args = process.argv.slice(2)
  const asJson = args.includes('--json')
  const dirArg = args.find((a) => !a.startsWith('--'))
  const dir = dirArg ? dirArg : MIGRATIONS_DIR
  const useBaseline = !dirArg

  const files = readdirSync(dir).filter((n) => n.endsWith('.sql')).sort()
  const unexpected = []
  const baselined = []

  for (const file of files) {
    const sql = readFileSync(join(dir, file), 'utf8')
    for (const hit of findInlineChecks(sql)) {
      const key = `${file}:${hit.column}`
      ;(useBaseline && BASELINE.has(key) ? baselined : unexpected).push({ file, key, ...hit })
    }
  }

  // Computed before any output path returns, so --json cannot skip the ratchet.
  const missing = useBaseline
    ? [...BASELINE].filter((key) => !baselined.some((hit) => hit.key === key))
    : []

  if (asJson) {
    console.log(JSON.stringify({ scanned: files.length, baselined, unexpected, missing }, null, 2))
    process.exit(unexpected.length === 0 && missing.length === 0 ? 0 : 1)
  }

  console.log(
    `INLINE CHECK ON ADD COLUMN IF NOT EXISTS: scanned ${files.length} migrations — ` +
      `${baselined.length} baselined, ${unexpected.length} new`,
  )
  for (const hit of baselined) {
    console.log(`  known  ${hit.file}:${hit.line} column "${hit.column}" (CHECK at line ${hit.checkLine})`)
  }

  if (missing.length > 0) {
    console.error('\nFAIL: a BASELINE entry no longer matches any hit:')
    for (const key of missing) console.error(`  ${key}`)
    console.error(
      '\nEither the migration was repaired (remove the entry) or the SCANNER STOPPED SEEING IT,',
    )
    console.error('which is the failure this check exists to prevent. Do not remove blindly.')
    process.exit(1)
  }

  if (unexpected.length === 0) {
    console.log('OK: no new inline CHECK on ADD COLUMN IF NOT EXISTS')
    return
  }

  console.error('\nFAIL: inline CHECK on ADD COLUMN IF NOT EXISTS')
  for (const hit of unexpected) {
    console.error(`  ${hit.file}:${hit.line} column "${hit.column}" — CHECK on line ${hit.checkLine}`)
  }
  console.error(
    '\nIF NOT EXISTS short-circuits the whole ADD COLUMN item, so this CHECK is silently dropped',
  )
  console.error('wherever the column already exists. Use the idiom already in this repo instead:')
  console.error('')
  console.error('  ALTER TABLE t ADD COLUMN IF NOT EXISTS c TEXT NOT NULL DEFAULT \'x\';')
  console.error('  ALTER TABLE t DROP CONSTRAINT IF EXISTS t_c_check;')
  console.error('  ALTER TABLE t ADD CONSTRAINT t_c_check CHECK (c IN (...));')
  console.error('')
  console.error('See 20260628110000_add_cashier_kitchen_roles.sql:2-20 and 20260629150000.')
  process.exit(1)
}

// pathToFileURL, not a hand-built `file://` string: on Windows the two forms differ by a slash
// and by drive-letter escaping, so the hand-built comparison silently never matches and the
// check exits 0 having run nothing — a green CI step that checks the migrations not at all.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
