/**
 * #212 — the CI guard against an inline CHECK on `ADD COLUMN IF NOT EXISTS`.
 *
 * `IF NOT EXISTS` makes the ADD COLUMN idempotent, and the inline CHECK is part
 * of the column definition, so it is idempotent WITH it: if the column already
 * exists the action is skipped whole and the constraint is never created, while
 * the migration reports success.
 *
 * The single most important property asserted here is that the check is
 * MULTILINE. In every violation in this repo the CHECK sits on a continuation
 * line, so the obvious line-oriented grep matches NOTHING and returns a clean
 * sheet — a green light nobody re-examines, which is strictly worse than having
 * no check. `same-line grep is blind to every real violation` below is that
 * property, asserted against the real migration files rather than a fixture.
 *
 * The parser is IMPORTED, not restated. A test carrying its own copy of the
 * rule passes whatever the subject does (#205).
 *
 * PROOF CEILING: STATIC. This proves what the CI gate will and will not flag in
 * the committed SQL. It says NOTHING about database state — in particular it
 * cannot tell whether any of the five baselined constraints actually exists on
 * production, which is the question that makes the pattern matter. Answering
 * that needs a read against the live estate and is not attempted here.
 */
import { readFileSync, readdirSync } from 'fs'
import { join } from 'path'
import { findInlineChecks, maskNonCode, scanDirectory, BASELINE } from '@/scripts/check-migration-inline-check'

const MIGRATIONS_DIR = join(process.cwd(), 'supabase', 'migrations')
const read = (name: string) => readFileSync(join(MIGRATIONS_DIR, name), 'utf8')

/** The one the brief names as the real hit. */
const TERMINAL_API_LAYER = '20260620150000_terminal_api_layer.sql'
/** Pure DROP CONSTRAINT + ADD CONSTRAINT. The correct idiom; must never be flagged. */
const ORDERS_POS_CHANNEL = '20260629150000_orders_pos_channel.sql'
/** Correct idiom for its role constraints, but ALSO one real inline CHECK on a column. */
const CASHIER_KITCHEN_ROLES = '20260628110000_add_cashier_kitchen_roles.sql'

describe('#212 — inline CHECK on ADD COLUMN IF NOT EXISTS', () => {
  describe('the property that makes it worth having: it is multiline', () => {
    it('same-line grep is blind to every real violation in the repo', () => {
      // The naive check, run over the real migrations. If this ever finds
      // something, the rest of this file still holds — but the point is that
      // today it finds NOTHING while the parser finds five files.
      //
      // MASKED before grepping, and that is not a weakening of the control.
      // The contrast drawn here is SAME-LINE vs MULTI-LINE, not comment vs
      // code — masking is what keeps it measuring the one it names.
      //
      // Unmasked it false-positives on
      // 20260811120000_restaurant_terminals_status_check_live_vocabulary.sql,
      // whose comment block QUOTES the offending pattern three times while
      // explaining the defect it corrects. That file's only executable SQL is
      // DROP CONSTRAINT + ADD CONSTRAINT — zero ADD COLUMN. The parser masks
      // and correctly ignores it; only this grep was fooled, which left the
      // control weaker than the code it defends at exactly the property it
      // tests hardest.
      //
      // That migration is a deliberate main/staging divergence and is never
      // reconciled, so unmasked this red would be PERMANENT on staging — the
      // #257 shape, a standing failure a real regression can hide behind.
      const sameLinePattern = /ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS.*CHECK\s*\(/i
      const caughtBySameLineGrep = readdirSync(MIGRATIONS_DIR)
        .filter((f) => f.endsWith('.sql'))
        .filter((f) =>
          maskNonCode(read(f))
            .split('\n')
            .some((line) => sameLinePattern.test(line))
        )

      expect(caughtBySameLineGrep).toEqual([])

      // ...and yet there are real violations, on continuation lines.
      const caughtByParser = [...scanDirectory(MIGRATIONS_DIR).keys()]
      expect(caughtByParser.length).toBeGreaterThan(0)
    })

    it('reports the column and the CHECK on DIFFERENT lines, because they are', () => {
      const [violation] = findInlineChecks(read(TERMINAL_API_LAYER))
      expect(violation).toBeDefined()
      expect(violation.checkLine).toBeGreaterThan(violation.columnLine)
    })

    it('catches a CHECK separated from its column by blank lines and a comment', () => {
      const sql = [
        'ALTER TABLE t',
        '  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT \'open\'',
        '',
        '  -- a comment in the middle of the column definition',
        '',
        '  CHECK (status IN (\'open\', \'closed\'));',
      ].join('\n')

      expect(findInlineChecks(sql)).toHaveLength(1)
    })
  })

  describe('must catch', () => {
    it(`${TERMINAL_API_LAYER} — the terminal status column`, () => {
      const violations = findInlineChecks(read(TERMINAL_API_LAYER))
      expect(violations).toHaveLength(1)
      expect(violations[0].snippet).toMatch(/ADD COLUMN IF NOT EXISTS status/i)
      expect(violations[0].snippet).toMatch(/CHECK \(status IN/i)
    })

    it('the offending column in a multi-action ALTER TABLE, and only that one', () => {
      // 20260620150000 adds FOUR columns in one statement; exactly one has a CHECK.
      const sql = read(TERMINAL_API_LAYER)
      expect((sql.match(/ADD COLUMN IF NOT EXISTS/gi) || []).length).toBe(4)
      expect(findInlineChecks(sql)).toHaveLength(1)
    })
  })

  describe('must NOT flag', () => {
    it(`${ORDERS_POS_CHANNEL} — DROP CONSTRAINT + ADD CONSTRAINT, the correct idiom`, () => {
      expect(findInlineChecks(read(ORDERS_POS_CHANNEL))).toEqual([])
    })

    it('a standalone ADD CONSTRAINT ... CHECK, however it is line-wrapped', () => {
      const sql = [
        'ALTER TABLE t ADD COLUMN IF NOT EXISTS role text;',
        'ALTER TABLE t',
        '  DROP CONSTRAINT IF EXISTS t_role_check;',
        'ALTER TABLE t',
        '  ADD CONSTRAINT t_role_check',
        '  CHECK (role IN (\'a\', \'b\'));',
      ].join('\n')

      expect(findInlineChecks(sql)).toEqual([])
    })

    it('the DROP+ADD constraint blocks inside a file that also has a real violation', () => {
      // This file uses the correct idiom THREE times (restaurant_users,
      // staff_invites, staff_members) and the wrong one ONCE
      // (staff_permissions.effect). Only the wrong one may be reported.
      //
      // Counted on the MASKED sql on purpose: the raw file contains a fourth
      // "Add constraint" in a COMMENT on line 15, and counting that as code is
      // precisely the mistake this whole script exists to avoid. Getting this
      // assertion wrong the first time is why the note is here.
      const sql = read(CASHIER_KITCHEN_ROLES)
      expect((maskNonCode(sql).match(/ADD CONSTRAINT/gi) || []).length).toBe(3)
      expect((sql.match(/ADD CONSTRAINT/gi) || []).length).toBe(4)

      const violations = findInlineChecks(sql)
      expect(violations).toHaveLength(1)
      expect(violations[0].snippet).toMatch(/ADD COLUMN IF NOT EXISTS effect/i)
    })

    it('a plain ADD COLUMN IF NOT EXISTS with no constraint', () => {
      expect(findInlineChecks('ALTER TABLE t ADD COLUMN IF NOT EXISTS note text;')).toEqual([])
    })

    it('an ADD COLUMN IF NOT EXISTS whose next sibling action carries the CHECK', () => {
      // The CHECK belongs to `b`, not to `a`. Splitting on top-level commas is
      // what keeps these apart; a whole-statement search would blame both.
      const sql = [
        'ALTER TABLE t',
        '  ADD COLUMN IF NOT EXISTS a text,',
        '  ADD COLUMN IF NOT EXISTS b text CHECK (b IN (\'x\', \'y\'));',
      ].join('\n')

      const violations = findInlineChecks(sql)
      expect(violations).toHaveLength(1)
      expect(violations[0].snippet).toMatch(/ADD COLUMN IF NOT EXISTS b/i)
    })
  })

  describe('masking — the scan must not read text that is not code', () => {
    it('ignores a violation written inside a line comment', () => {
      const sql = [
        "-- ALTER TABLE t ADD COLUMN IF NOT EXISTS s text CHECK (s IN ('a'));",
        'ALTER TABLE t ADD COLUMN IF NOT EXISTS s text;',
      ].join('\n')
      expect(findInlineChecks(sql)).toEqual([])
    })

    it('ignores a violation written inside a block comment', () => {
      const sql = [
        '/* ALTER TABLE t',
        "     ADD COLUMN IF NOT EXISTS s text CHECK (s IN ('a')); */",
        'ALTER TABLE t ADD COLUMN IF NOT EXISTS s text;',
      ].join('\n')
      expect(findInlineChecks(sql)).toEqual([])
    })

    it('ignores a violation inside a dollar-quoted function body', () => {
      const sql = [
        'CREATE OR REPLACE FUNCTION f() RETURNS void AS $$',
        'BEGIN',
        "  EXECUTE 'ALTER TABLE t ADD COLUMN IF NOT EXISTS s text CHECK (s IN (''a''))';",
        'END;',
        '$$ LANGUAGE plpgsql;',
      ].join('\n')
      expect(findInlineChecks(sql)).toEqual([])
    })

    it('is not confused by an apostrophe inside a comment', () => {
      // An unbalanced quote in prose used to swallow the rest of the file.
      const sql = [
        "-- we don't attach constraints inline",
        'ALTER TABLE t',
        "  ADD COLUMN IF NOT EXISTS s text NOT NULL DEFAULT 'x'",
        "  CHECK (s IN ('x', 'y'));",
      ].join('\n')
      expect(findInlineChecks(sql)).toHaveLength(1)
    })

    it('preserves line numbers exactly while masking', () => {
      const sql = "-- comment\n/* block */\n$$ body $$\n'literal'\nSELECT 1;"
      const masked = maskNonCode(sql)
      expect(masked).toHaveLength(sql.length)
      expect(masked.split('\n')).toHaveLength(sql.split('\n').length)
    })

    it('does not mistake a column named like a check for a constraint', () => {
      expect(findInlineChecks('ALTER TABLE t ADD COLUMN IF NOT EXISTS checked_at timestamptz;')).toEqual([])
    })
  })

  describe('the baseline stays honest', () => {
    it('every baselined file still actually violates, so the list cannot rot', () => {
      const offenders = scanDirectory(MIGRATIONS_DIR)
      const stale = [...BASELINE.keys()].filter((name) => !offenders.has(name))
      expect(stale).toEqual([])
    })

    it('the baseline covers every current offender, so CI is green on history', () => {
      const offenders = scanDirectory(MIGRATIONS_DIR)
      const unbaselined = [...offenders.keys()].filter((name) => !BASELINE.has(name))
      expect(unbaselined).toEqual([])
    })
  })
})
