/**
 * Issue #172 — the production deploy gate's `npx tsc --noEmit` (#141) is blind to every file
 * carrying `@ts-nocheck`, and 14 files in the gated directories carry it, two of them payment
 * routes. This suite pins the RATCHET: the 14 are frozen in `.github/ts-nocheck-allowlist.txt`
 * and a new one fails the build. It does not clear the 14 — that is separate, designed work.
 *
 * The YAML assertions below are the weak half. They prove the step is CONFIGURED, which is the
 * same limitation #172 called out in `production-deploy-gate.test.ts`: parsing a workflow proves
 * nothing about whether the command discriminates.
 *
 * So the second half runs the real checker against synthetic trees and asserts it passes the
 * clean one and fails each broken one, for the right reason. That is the half that would notice
 * if the checker were quietly turned into something that always exits 0 — which is precisely how
 * the instruments catalogued in #169 and #172 failed: they ran, they were green, and the green
 * meant nothing.
 */
import { execFileSync } from 'child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join, dirname } from 'path'
import { parse } from 'yaml'

const REPO = join(__dirname, '..')
const CHECKER = join(REPO, 'scripts', 'check-ts-nocheck-allowlist.mjs')
const ALLOWLIST = join(REPO, '.github', 'ts-nocheck-allowlist.txt')
const WORKFLOW = join(REPO, '.github', 'workflows', 'production-worker.yml')

type Step = { name?: string; run?: string; uses?: string }
type Job = { steps?: Step[] }
type Workflow = { jobs: Record<string, Job> }

function allowlistEntries(): string[] {
  return readFileSync(ALLOWLIST, 'utf8')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('#'))
}

/** Runs the real checker. Returns its exit code and combined output rather than throwing. */
function runChecker(args: string[]): { code: number; out: string } {
  try {
    const out = execFileSync('node', [CHECKER, ...args], { encoding: 'utf8', stdio: 'pipe' })
    return { code: 0, out }
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string }
    return { code: err.status ?? -1, out: `${err.stdout ?? ''}${err.stderr ?? ''}` }
  }
}

/**
 * Builds a throwaway tree with the gated directory layout. `files` maps repo-relative paths to
 * contents; `allowlist` is the list the checker will be given.
 */
function fixture(files: Record<string, string>, allowlist: string[]): string {
  const root = mkdtempSync(join(tmpdir(), 'nocheck-ratchet-'))
  for (const [rel, body] of Object.entries(files)) {
    const abs = join(root, rel)
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, body, 'utf8')
  }
  const listPath = join(root, 'allowlist.txt')
  writeFileSync(listPath, `# fixture\n${allowlist.join('\n')}\n`, 'utf8')
  return root
}

const PRAGMA_FILE = '// @ts-nocheck\nexport const x = 1\n'
const CLEAN_FILE = 'export const x: number = 1\n'

describe('#172 — @ts-nocheck ratchet', () => {
  describe('the allowlist itself is honest', () => {
    it('exists and lists at least one path', () => {
      expect(existsSync(ALLOWLIST)).toBe(true)
      expect(allowlistEntries().length).toBeGreaterThan(0)
    })

    it('says it is a shrinking list that must never be added to', () => {
      const header = readFileSync(ALLOWLIST, 'utf8')
      expect(header).toMatch(/SHRINKING LIST/i)
      expect(header).toMatch(/NEVER ADD TO IT/i)
    })

    it('has no duplicate entries', () => {
      const entries = allowlistEntries()
      expect(entries.length).toBe(new Set(entries).size)
    })

    it('uses forward slashes so the runner and Windows agree', () => {
      for (const e of allowlistEntries()) expect(e).not.toContain('\\')
    })

    it('names only files that exist and still carry the pragma', () => {
      for (const rel of allowlistEntries()) {
        const abs = join(REPO, rel)
        expect(existsSync(abs)).toBe(true)
        expect(readFileSync(abs, 'utf8')).toContain('@ts-nocheck')
      }
    })
  })

  describe('the checker discriminates — controls, not confirmation', () => {
    const cleanup: string[] = []
    afterAll(() => {
      for (const d of cleanup) rmSync(d, { recursive: true, force: true })
    })

    function build(files: Record<string, string>, allowlist: string[]): string {
      const root = fixture(files, allowlist)
      cleanup.push(root)
      return root
    }

    it('POSITIVE CONTROL: tree matching the allowlist exactly passes', () => {
      const root = build({ 'lib/a.ts': PRAGMA_FILE, 'app/b.tsx': PRAGMA_FILE }, ['lib/a.ts', 'app/b.tsx'])
      const { code, out } = runChecker(['--root', root, '--allowlist', join(root, 'allowlist.txt')])
      expect(out).toContain('Allowlist matches the tree exactly')
      expect(code).toBe(0)
    })

    it('NEGATIVE CONTROL: a NEW @ts-nocheck file fails', () => {
      const root = build(
        { 'lib/a.ts': PRAGMA_FILE, 'components/sneaky.tsx': PRAGMA_FILE },
        ['lib/a.ts'],
      )
      const { code, out } = runChecker(['--root', root, '--allowlist', join(root, 'allowlist.txt')])
      expect(code).toBe(1)
      expect(out).toContain('NEW @ts-nocheck')
      expect(out).toContain('components/sneaky.tsx')
    })

    it('NEGATIVE CONTROL: an allowlisted path that no longer exists fails, so the list cannot rot', () => {
      const root = build({ 'lib/a.ts': PRAGMA_FILE }, ['lib/a.ts', 'lib/deleted-last-sprint.ts'])
      const { code, out } = runChecker(['--root', root, '--allowlist', join(root, 'allowlist.txt')])
      expect(code).toBe(1)
      expect(out).toContain('no longer exist')
      expect(out).toContain('lib/deleted-last-sprint.ts')
    })

    it('NEGATIVE CONTROL: an allowlisted file whose pragma was cleared fails, so the count stays honest', () => {
      const root = build({ 'lib/a.ts': PRAGMA_FILE, 'lib/fixed.ts': CLEAN_FILE }, ['lib/a.ts', 'lib/fixed.ts'])
      const { code, out } = runChecker(['--root', root, '--allowlist', join(root, 'allowlist.txt')])
      expect(code).toBe(1)
      expect(out).toContain('no longer carry @ts-nocheck')
      expect(out).toContain('lib/fixed.ts')
    })

    it('ignores node_modules, which really does ship @ts-nocheck files', () => {
      const root = build(
        { 'lib/a.ts': PRAGMA_FILE, 'lib/node_modules/dep/index.ts': PRAGMA_FILE },
        ['lib/a.ts'],
      )
      const { code, out } = runChecker(['--root', root, '--allowlist', join(root, 'allowlist.txt')])
      expect(out).not.toContain('node_modules')
      expect(code).toBe(0)
    })

    it('ignores directories outside the gated set', () => {
      const root = build({ 'lib/a.ts': PRAGMA_FILE, 'scripts/tool.ts': PRAGMA_FILE }, ['lib/a.ts'])
      const { code } = runChecker(['--root', root, '--allowlist', join(root, 'allowlist.txt')])
      expect(code).toBe(0)
    })
  })

  describe('the real repository passes its own ratchet', () => {
    it('exits 0 against the committed tree and allowlist', () => {
      const { code, out } = runChecker(['--root', REPO, '--allowlist', ALLOWLIST])
      expect(out).toContain('No new @ts-nocheck')
      expect(code).toBe(0)
    })
  })

  describe('the gate actually runs it', () => {
    function gate(): Job {
      const wf = parse(readFileSync(WORKFLOW, 'utf8')) as Workflow
      return wf.jobs['build-verification']
    }

    it('build-verification has a step invoking the checker', () => {
      const step = (gate().steps ?? []).find((s) => (s.run ?? '').includes('check-ts-nocheck-allowlist.mjs'))
      expect(step).toBeDefined()
      expect(step?.name ?? '').toMatch(/ts-nocheck/i)
    })

    it('runs the ratchet BEFORE npm ci, so node_modules cannot pollute the scan', () => {
      const steps = gate().steps ?? []
      const ratchet = steps.findIndex((s) => (s.run ?? '').includes('check-ts-nocheck-allowlist.mjs'))
      const install = steps.findIndex((s) => (s.run ?? '').trim() === 'npm ci')
      expect(ratchet).toBeGreaterThanOrEqual(0)
      expect(install).toBeGreaterThanOrEqual(0)
      expect(ratchet).toBeLessThan(install)
    })

    it('still runs the typecheck the ratchet protects', () => {
      const step = (gate().steps ?? []).find((s) => (s.run ?? '').includes('tsc --noEmit'))
      expect(step).toBeDefined()
    })
  })
})
