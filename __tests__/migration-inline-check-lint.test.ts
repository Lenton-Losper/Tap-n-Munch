/**
 * #212 — the CI check that rejects an inline CHECK on `ADD COLUMN IF NOT EXISTS`.
 *
 * WHY THIS SUITE SPAWNS THE SCRIPT INSTEAD OF IMPORTING THE RULE
 * The rule ships as scripts/check-migration-inline-checks.mjs, which is what the workflow runs.
 * A test that reimplemented the regex would stay green against a script that had been broken or
 * reverted — the #205 failure mode. Every case below runs the real artifact via `node` and reads
 * its --json output, so a change to the shipped file is what these assertions actually bind to.
 *
 * WHY THE POSITIVE CASES ARE TWO-SIDED
 * The whole point of #212 is that a SAME-LINE grep for this pattern matches NOTHING in this
 * repository and reports a clean sheet, because in all five real hits the CHECK sits on a
 * continuation line. So "the rule found nothing" and "the rule works" are indistinguishable
 * unless the negative side is pinned too. Each fixture below therefore asserts both what IS
 * flagged and what is NOT, and `sameLineGrepFindsNothing` pins the false clean sheet itself so
 * that anyone who later "simplifies" this to a one-line grep gets a red test naming the reason.
 */
import { execFileSync } from 'child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const SCRIPT = join(__dirname, '..', 'scripts', 'check-migration-inline-checks.mjs')
const MIGRATIONS = join(__dirname, '..', 'supabase', 'migrations')

type Hit = { file: string; key: string; column: string; line: number; checkLine: number }
type Report = { scanned: number; baselined: Hit[]; unexpected: Hit[]; missing: string[] }

/** Runs the shipped script and returns its report. Exit code is carried, not thrown on. */
function run(dir?: string): { report: Report; exitCode: number } {
  const args = dir ? [SCRIPT, dir, '--json'] : [SCRIPT, '--json']
  try {
    const stdout = execFileSync(process.execPath, args, { encoding: 'utf8' })
    return { report: JSON.parse(stdout) as Report, exitCode: 0 }
  } catch (err) {
    const e = err as { status?: number; stdout?: string }
    if (typeof e.stdout !== 'string' || !e.stdout.trim()) throw err
    return { report: JSON.parse(e.stdout) as Report, exitCode: e.status ?? 1 }
  }
}

/** Writes fixtures to a scratch directory and reports what the real script flags in them. */
function scan(fixtures: Record<string, string>): Hit[] {
  const dir = mkdtempSync(join(tmpdir(), 'flashtap-212-'))
  try {
    mkdirSync(dir, { recursive: true })
    for (const [name, sql] of Object.entries(fixtures)) {
      writeFileSync(join(dir, name), sql, 'utf8')
    }
    return run(dir).report.unexpected
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('#212 — the rule must be multiline, which is the entire requirement', () => {
  it('flags a CHECK on a continuation line', () => {
    const hits = scan({
      '20260101000000_x.sql': [
        'ALTER TABLE public.restaurant_terminals',
        "ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active'",
        "  CHECK (status IN ('active', 'revoked'));",
      ].join('\n'),
    })

    expect(hits.map((h) => h.column)).toEqual(['status'])
    // The two lines differ — which is exactly why a same-line matcher misses it.
    expect(hits[0].line).toBe(2)
    expect(hits[0].checkLine).toBe(3)
  })

  it('flags a CHECK several lines below, past blank lines and a comment', () => {
    const hits = scan({
      '20260101000000_x.sql': [
        'ALTER TABLE t',
        '  ADD COLUMN IF NOT EXISTS c TEXT',
        '',
        '  -- a comment between the column and its constraint',
        '',
        "  CHECK (c IN ('a','b'));",
      ].join('\n'),
    })
    expect(hits.map((h) => h.column)).toEqual(['c'])
  })

  it('sameLineGrepFindsNothing: no real migration has both tokens on ONE line', () => {
    // The failing half of the multiline requirement, pinned against the real directory. If this
    // ever finds a match, a same-line grep would start to look adequate — it is not, and the
    // next assertion is what says so.
    const sameLine = execFileSync(
      process.execPath,
      [
        '-e',
        `const fs=require('fs');const p=${JSON.stringify(MIGRATIONS)};
         const hits=[];for(const f of fs.readdirSync(p).filter(n=>n.endsWith('.sql'))){
           fs.readFileSync(p+'/'+f,'utf8').split('\\n').forEach((l,i)=>{
             if(/ADD\\s+COLUMN\\s+IF\\s+NOT\\s+EXISTS.*CHECK/i.test(l))hits.push(f+':'+(i+1));});}
         console.log(JSON.stringify(hits));`,
      ],
      { encoding: 'utf8' },
    )
    expect(JSON.parse(sameLine)).toEqual([])

    // ...while the shipped rule finds five. That gap IS #212.
    expect(run().report.baselined.length).toBe(5)
  })
})

describe('#212 — positive control: the known real hit', () => {
  it('flags 20260620150000_terminal_api_layer.sql restaurant_terminals.status', () => {
    const hit = run().report.baselined.find(
      (h) => h.file === '20260620150000_terminal_api_layer.sql',
    )
    expect(hit).toBeDefined()
    expect(hit!.column).toBe('status')
    expect(hit!.checkLine).toBeGreaterThan(hit!.line)
  })
})

describe('#212 — negative controls: the correct idiom must never be flagged', () => {
  it('does not flag 20260629150000_orders_pos_channel.sql (DROP + ADD CONSTRAINT)', () => {
    const { report } = run()
    const all = [...report.baselined, ...report.unexpected]
    expect(all.filter((h) => h.file === '20260629150000_orders_pos_channel.sql')).toEqual([])
  })

  it('does not flag the DROP+ADD CONSTRAINT block of 20260628110000', () => {
    // This file is a mixed case and the reason the brief's negative control was wrong: lines
    // 2-20 use the correct idiom three times, and line 25 then commits the slip. The rule must
    // separate them rather than judge the file.
    const hits = run().report.baselined.filter(
      (h) => h.file === '20260628110000_add_cashier_kitchen_roles.sql',
    )
    expect(hits.map((h) => h.column)).toEqual(['effect'])
    expect(hits[0].line).toBeGreaterThan(20)
  })

  it('does not flag a plain ADD COLUMN with an inline CHECK — that constraint DOES apply', () => {
    expect(
      scan({
        '20260101000000_x.sql': [
          'ALTER TABLE t',
          '  ADD COLUMN c TEXT',
          "  CHECK (c IN ('a','b'));",
        ].join('\n'),
      }),
    ).toEqual([])
  })

  it('does not flag a sibling ADD CONSTRAINT ... CHECK in the same ALTER', () => {
    // A separate ALTER item. IF NOT EXISTS short-circuits its own item only, so this constraint
    // is created unconditionally and is correct. Flagging it would be a false positive on the
    // very idiom the rule is telling people to use.
    expect(
      scan({
        '20260101000000_x.sql': [
          'ALTER TABLE t',
          '  ADD COLUMN IF NOT EXISTS c TEXT,',
          "  ADD CONSTRAINT t_c_check CHECK (c IN ('a','b'));",
        ].join('\n'),
      }),
    ).toEqual([])
  })

  it('does not flag a CHECK in a following, separate statement', () => {
    expect(
      scan({
        '20260101000000_x.sql': [
          'ALTER TABLE t ADD COLUMN IF NOT EXISTS c TEXT;',
          'ALTER TABLE t DROP CONSTRAINT IF EXISTS t_c_check;',
          "ALTER TABLE t ADD CONSTRAINT t_c_check CHECK (c IN ('a','b'));",
        ].join('\n'),
      }),
    ).toEqual([])
  })
})

describe('#212 — parsing that a naive scanner gets wrong', () => {
  it('attributes the CHECK to the right column in a multi-item ALTER', () => {
    const hits = scan({
      '20260101000000_x.sql': [
        'ALTER TABLE public.restaurants',
        '    ADD COLUMN IF NOT EXISTS "organization_id" uuid,',
        "    ADD COLUMN IF NOT EXISTS \"location_type\" text NOT NULL DEFAULT 'RETAIL'",
        '        CHECK ("location_type" IN (\'RETAIL\', \'KIOSK\'));',
      ].join('\n'),
    })
    // The quoted name, not the type: an earlier draft blanked quoted identifiers and reported
    // this column as "text".
    expect(hits.map((h) => h.column)).toEqual(['location_type'])
  })

  it('is not fooled by a CHECK inside a comment or a string literal', () => {
    expect(
      scan({
        '20260101000000_x.sql': [
          'ALTER TABLE t',
          '  ADD COLUMN IF NOT EXISTS c TEXT -- CHECK (c IN (1))',
          "  DEFAULT 'CHECK (nope)';",
        ].join('\n'),
      }),
    ).toEqual([])
  })

  it('does not tear a statement apart on a semicolon inside a dollar-quoted body', () => {
    // A function body's semicolons would otherwise split the statement and detach the CHECK
    // from its ADD COLUMN, silently losing the hit that follows.
    const hits = scan({
      '20260101000000_x.sql': [
        'CREATE OR REPLACE FUNCTION f() RETURNS void AS $$',
        'BEGIN',
        '  PERFORM 1;',
        '  PERFORM 2;',
        'END;',
        '$$ LANGUAGE plpgsql;',
        '',
        'ALTER TABLE t',
        '  ADD COLUMN IF NOT EXISTS c TEXT',
        "  CHECK (c IN ('a'));",
      ].join('\n'),
    })
    expect(hits.map((h) => h.column)).toEqual(['c'])
    expect(hits[0].checkLine).toBe(10)
  })

  it('sees DDL inside a DO $$ block — the one shape that got past the first version', () => {
    /*
     * Found by an adversarial pass AGAINST the rule, after the suite below was already green.
     * The first version blanked dollar-quoted bodies wholesale (so a function body's semicolons
     * could not tear the outer statement apart) and therefore could not see any DDL inside one.
     *
     * Not theoretical. Four committed migrations already put ALTER TABLE inside a dollar-quoted
     * body, and 20260725140000_orders_terminal_status.sql is this exact file one edit away: it
     * adds the column with ADD COLUMN IF NOT EXISTS and guards its CHECK in a DO block. Folding
     * the CHECK back onto the column is a one-line change, and the scanner would have called
     * the result clean.
     */
    const hits = scan({
      '20260101000000_x.sql': [
        'DO $$',
        'BEGIN',
        "  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'tabs') THEN",
        '    ALTER TABLE public.tabs',
        "      ADD COLUMN IF NOT EXISTS settlement_state text NOT NULL DEFAULT 'open'",
        "        CHECK (settlement_state IN ('open', 'settled'));",
        '  END IF;',
        'END $$;',
      ].join('\n'),
    })

    expect(hits.map((h) => h.column)).toEqual(['settlement_state'])
    // Lines are reported against the OUTER file, not the extracted body.
    expect(hits[0].line).toBe(5)
    expect(hits[0].checkLine).toBe(6)
  })

  it('still does not flag the correct idiom when it is inside a DO $$ block', () => {
    // The negative side of the case above, and the shape 20260725140000 actually ships.
    expect(
      scan({
        '20260101000000_x.sql': [
          'ALTER TABLE orders ADD COLUMN IF NOT EXISTS terminal_status text;',
          '',
          'DO $$',
          'BEGIN',
          "  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'orders_ts_check') THEN",
          '    ALTER TABLE orders',
          '      ADD CONSTRAINT orders_ts_check',
          "      CHECK (terminal_status IN ('pending', 'failed'));",
          '  END IF;',
          'END $$;',
        ].join('\n'),
      }),
    ).toEqual([])
  })

  it('matches case-insensitively and across irregular whitespace', () => {
    const hits = scan({
      '20260101000000_x.sql': 'alter table t\n  add   column\n  if not exists c text\n  check (c > 0);',
    })
    expect(hits.map((h) => h.column)).toEqual(['c'])
  })
})

describe('#212 — the ratchet', () => {
  it('passes on the real migrations today, with all five hits baselined', () => {
    const { report, exitCode } = run()
    expect(report.unexpected).toEqual([])
    expect(report.missing).toEqual([])
    expect(exitCode).toBe(0)
    expect(report.baselined.map((h) => h.key).sort()).toEqual([
      '20260620150000_terminal_api_layer.sql:status',
      '20260628110000_add_cashier_kitchen_roles.sql:effect',
      '20260629120000_add_order_channel.sql:channel',
      '20260719110000_organizations_and_membership.sql:location_type',
      '20260724180000_platform_ops_console.sql:status',
    ])
  })

  it('fails, non-zero, on a NEW hit', () => {
    const dir = mkdtempSync(join(tmpdir(), 'flashtap-212-'))
    try {
      writeFileSync(
        join(dir, '20260101000000_new.sql'),
        "ALTER TABLE t\n  ADD COLUMN IF NOT EXISTS c TEXT\n  CHECK (c IN ('a'));",
        'utf8',
      )
      const { report, exitCode } = run(dir)
      expect(report.unexpected).toHaveLength(1)
      expect(exitCode).toBe(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('exits 0 on a directory with no violations', () => {
    const dir = mkdtempSync(join(tmpdir(), 'flashtap-212-'))
    try {
      writeFileSync(join(dir, '20260101000000_ok.sql'), 'ALTER TABLE t ADD COLUMN IF NOT EXISTS c TEXT;', 'utf8')
      expect(run(dir).exitCode).toBe(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
