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
