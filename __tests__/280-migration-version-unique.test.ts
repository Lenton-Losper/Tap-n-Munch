/**
 * #280 — two-sided against the collision that actually happened on 2026-08-26.
 *
 * RED against the two filenames that collided, GREEN after the rename. A gate asserted only in the
 * clean direction cannot distinguish "no collisions" from "no longer detecting collisions", which
 * is the exact failure mode of the drift guard it backstops.
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SCRIPT = 'scripts/check-migration-version-unique.mjs'

function runOn(files: string[]): { code: number; out: string } {
  const dir = mkdtempSync(join(tmpdir(), 'mig-'))
  try {
    for (const f of files) writeFileSync(join(dir, f), '-- fixture\n')
    try {
      const out = execFileSync('node', [SCRIPT, `--root=${dir}`], { encoding: 'utf8' })
      return { code: 0, out }
    } catch (e) {
      const err = e as { status?: number; stdout?: string; stderr?: string }
      return { code: err.status ?? -1, out: `${err.stdout ?? ''}${err.stderr ?? ''}` }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('#280 migration version uniqueness gate', () => {
  it('goes RED on the exact two filenames that collided on 2026-08-26', () => {
    const { code, out } = runOn([
      '20260826160000_order_requests_claimed_at.sql',
      '20260826160000_restaurants_drop_payment_methods.sql',
    ])
    expect(code).toBe(1)
    expect(out).toContain('20260826160000')
    expect(out).toContain('order_requests_claimed_at')
    expect(out).toContain('restaurants_drop_payment_methods')
  })

  it('goes GREEN after the rename that resolved it', () => {
    const { code } = runOn([
      '20260826160000_order_requests_claimed_at.sql',
      '20260826170000_restaurants_drop_payment_methods.sql',
    ])
    expect(code).toBe(0)
  })

  it('does NOT flag one filename regardless of how many times it appears', () => {
    // The noisy first scan counted prefix occurrences across branches and reported ~140
    // "duplicates" on a clean tree. Within one directory a name can only appear once, so this
    // pins the de-duplication rule itself: distinct NAMES per version, never occurrences.
    const { code } = runOn([
      '20260824150000_reap_abandoned_tabs.sql',
      '20260825020000_tabs_revoke_anon_select.sql',
      '20260826120000_held_payments.sql',
    ])
    expect(code).toBe(0)
  })

  it('ignores non-migration files rather than treating them as a collision', () => {
    const { code } = runOn([
      '20260826160000_only_one.sql',
      'README.md',
      '.gitkeep',
    ])
    expect(code).toBe(0)
  })

  it('passes on the real repository', () => {
    const out = execFileSync('node', [SCRIPT], { encoding: 'utf8' })
    expect(out).toContain('OK')
  })
})

/**
 * THE VERSION IT CANNOT READ — found 2026-08-27 by mutating the real migrations directory.
 *
 * `VERSION` is /^(\d{14})_/. `check-migration-drift.mjs:85` reads the same filenames with
 * /^(\d+)_/ and accepts any digit count. Anything between the two — a thirteen-digit prefix, one
 * fat-fingered keystroke — was skipped here in silence while the drift guard still parsed it.
 *
 * Two thirteen-digit files sharing a prefix, which is precisely #280's collision, produced
 * "OK — 153 migration(s), every version maps to one filename" against a directory holding exactly
 * that collision. The count was the sharper half of the lie: it came from the raw listing while
 * the detector had read only the parseable names, so the number vouched for two files nobody
 * looked at.
 */
describe('a .sql file whose version cannot be read is reported, not skipped', () => {
  it('goes RED on a thirteen-digit prefix — the mutation that got past this gate', () => {
    const { code, out } = runOn(['2026082616000_probe_a.sql'])
    expect(code).toBe(1)
    expect(out).toContain('2026082616000_probe_a.sql')
  })

  it('goes RED on a thirteen-digit COLLISION, which the old gate called OK', () => {
    const { code } = runOn(['2026082616000_probe_a.sql', '2026082616000_probe_b.sql'])
    expect(code).toBe(1)
  })

  it('does NOT fire on README.md or .gitkeep', () => {
    // FALSE-POSITIVE GUARD. The rule was widened from "collisions" to "collisions plus anything
    // unreadable", and the cost of widening is firing on the directory's own housekeeping files.
    // A gate that fails on a README is a gate somebody switches off.
    const { code } = runOn(['20260826160000_only_one.sql', 'README.md', '.gitkeep'])
    expect(code).toBe(0)
  })

  it('counts only what the detector actually read', () => {
    // The count must never again vouch for a file the detector skipped. With the unreadable arm
    // failing first this can only be reached on an all-parseable directory, so the two numbers
    // agree by construction — this pins that they are DERIVED from the same filter.
    const { out } = runOn([
      '20260826160000_a.sql',
      '20260826170000_b.sql',
      'README.md',
    ])
    expect(out).toContain('2 migration(s) read')
  })
})
