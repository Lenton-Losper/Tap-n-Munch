import { execFileSync } from 'child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

/**
 * THE GATE THAT SHOULD HAVE CAUGHT THE SWITCHER, TESTED ON A FIXTURE.
 *
 * `scripts/check-no-pending-copy.mjs` is the class check that four existing per-string assertions
 * could not be: each of those pins one string in one file, so a NEW file with a NEW placeholder was
 * invisible to all of them. That is how `PENDING COPY — Location` reached production and was read by
 * a restaurant owner on twenty staff screens.
 *
 * Asserted against a temp fixture rather than against this repo, because the repo's own answer
 * changes every time a string is signed off — a test pinned to "finds five" would go red the moment
 * the gate did its job.
 *
 * THE FALSE-POSITIVE CASE IS THE ONE THAT DECIDES WHETHER THIS SURVIVES. Roughly ten files
 * legitimately contain the words "PENDING COPY" in prose: the convention's own header, the block
 * comment above the switcher's copy, and the checker itself. A gate that fires on the documentation
 * explaining it would be disabled within a week, so the comment-stripping case below matters as
 * much as the detection case.
 */
const SCRIPT = join(process.cwd(), 'scripts', 'check-no-pending-copy.mjs')

function runGate(root: string): { status: number; out: string } {
  try {
    const out = execFileSync('node', [SCRIPT, `--root=${root}`], { encoding: 'utf8' })
    return { status: 0, out }
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string }
    return { status: err.status ?? 1, out: `${err.stdout ?? ''}${err.stderr ?? ''}` }
  }
}

function fixture(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'pendingcopy-'))
  for (const [rel, body] of Object.entries(files)) {
    const full = join(root, rel)
    mkdirSync(join(full, '..'), { recursive: true })
    writeFileSync(full, body, 'utf8')
  }
  return root
}

describe('the PENDING COPY gate', () => {
  it('FAILS on a placeholder in shippable source', () => {
    const root = fixture({
      'components/thing.tsx': `export const COPY = { label: 'PENDING COPY — Location' }\n`,
    })
    const { status, out } = runGate(root)
    expect(status).toBe(1)
    expect(out).toContain('components/thing.tsx')
    expect(out).toContain('PENDING COPY — Location')
  })

  it('PASSES once the string is signed off', () => {
    const root = fixture({
      'components/thing.tsx': `export const COPY = { label: 'Location' }\n`,
    })
    const { status, out } = runGate(root)
    expect(status).toBe(0)
    expect(out).toContain('OK')
  })

  it('does NOT fire on prose that explains the convention', () => {
    // The exact shape of every docblock that documents this rule, including the one in the
    // checker's own header and the one above the switcher's copy block.
    const root = fixture({
      'lib/copy.ts':
        `/**\n * Mark unsigned strings PENDING COPY rather than stopping for wording.\n` +
        ` *     git grep "PENDING COPY" -- lib/copy.ts\n */\n` +
        `// PENDING COPY markers are listed at the end.\n` +
        `export const COPY = { label: 'Location' }\n`,
    })
    const { status, out } = runGate(root)
    expect(status).toBe(0)
    expect(out).toContain('OK')
  })

  it('ignores tests, scripts and docs — a marker there is not readable by anyone', () => {
    const root = fixture({
      '__tests__/x.test.ts': `expect(s).not.toMatch(/PENDING COPY/)\n`,
      'components/ok.tsx': `export const COPY = { label: 'Location' }\n`,
    })
    expect(runGate(root).status).toBe(0)
  })

  it('--list reports without failing, so a sign-off list can be produced', () => {
    const root = fixture({
      'components/thing.tsx': `export const COPY = { label: 'PENDING COPY — Location' }\n`,
    })
    const out = execFileSync('node', [SCRIPT, `--root=${root}`, '--list'], { encoding: 'utf8' })
    expect(out).toContain('components/thing.tsx')
    expect(out).toContain('reporting only')
  })

  it('is wired into the PRODUCTION deploy, and deliberately not into staging', () => {
    // Staging is where a placeholder legitimately lives — mark it, build the screen, get the
    // wording signed off, then promote. Wiring this into staging.yml would break the workflow it
    // exists to protect.
    const prod = readFileSync(join(process.cwd(), '.github/workflows/production-worker.yml'), 'utf8')
    expect(prod).toContain('scripts/check-no-pending-copy.mjs')
    const staging = readFileSync(join(process.cwd(), '.github/workflows/staging.yml'), 'utf8')
    expect(staging).not.toContain('scripts/check-no-pending-copy.mjs')
  })
})
