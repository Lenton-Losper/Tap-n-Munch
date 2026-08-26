import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'

/**
 * #334 ROUND TWO — THE GATE'S SCOPE IS THE THING UNDER TEST, not its prose detector.
 *
 * The ruling was to widen `check-menu-copy-sourced.mjs` from `app/menu/**` to the CUSTOMER-RENDERING
 * files under components/ and contexts/ — not the whole tree, and not staff surfaces. That is three
 * separate claims, and each of them fails silently in a different direction:
 *
 *   too narrow   the file whose bare literal STARTED #334 (`components/ActiveOrderBanner.tsx`) is a
 *                component, not a screen. A gate that misses it is the original bug.
 *   too wide     scanning components/ wholesale drags in every staff dashboard, and a gate with a
 *                backlog nobody will clear is how the previous convention decayed.
 *   wrong basis  membership is DERIVED from the import graph. A hand-written include list would
 *                have the same failure mode as an exclude list: the one file nobody remembered.
 *
 * So this runs the real script against a FIXTURE tree via `--root=`, and asserts all three. A test
 * that only checked the repo would pass for the wrong reason the moment someone moved a file.
 */
const SCRIPT = 'scripts/check-menu-copy-sourced.mjs'

type Hit = { file: string; line: number; text: string; kind: string }

function write(root: string, rel: string, source: string) {
  const full = join(root, rel)
  mkdirSync(dirname(full), { recursive: true })
  writeFileSync(full, source, 'utf8')
}

function runGate(root: string): Hit[] {
  const raw = execFileSync('node', [SCRIPT, '--json', `--root=${root}`], { encoding: 'utf8' })
  return JSON.parse(raw) as Hit[]
}

let root: string

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'copy-gate-scope-'))

  // A customer screen, importing one component and one context.
  write(
    root,
    'app/menu/[restaurantId]/browse/page.tsx',
    [
      "import { Reachable } from '@/components/Reachable'",
      "import { useThing } from '@/contexts/thing-context'",
      'export default function Page() { return <Reachable /> }',
    ].join('\n'),
  )

  // Reached from a customer screen: IN SCOPE.
  write(root, 'components/Reachable.tsx', "export const Reachable = () => <p>A sentence the customer reads</p>\n")

  // Reached only through another reachable component: IN SCOPE, because reachability is transitive.
  write(
    root,
    'components/Reachable.tsx',
    [
      "import { Nested } from './nested/deeper'",
      'export const Reachable = () => <p>A sentence the customer reads</p>',
      'export const Also = Nested',
    ].join('\n'),
  )
  write(root, 'components/nested/deeper.tsx', "export const Nested = () => <p>A sentence two hops away</p>\n")

  // A context a customer screen imports: IN SCOPE. This is the shape #334 called out as the least
  // likely place anyone would look for copy.
  write(root, 'contexts/thing-context.tsx', "export const useThing = () => 'A sentence inside a provider'\n")

  // Imported by a STAFF screen only: OUT OF SCOPE.
  write(
    root,
    'app/(staff)/dashboard/page.tsx',
    "import { StaffOnly } from '@/components/StaffOnly'\nexport default StaffOnly\n",
  )
  write(root, 'components/StaffOnly.tsx', "export const StaffOnly = () => <p>A staff sentence nobody signed</p>\n")

  // Imported by nothing at all: OUT OF SCOPE.
  write(root, 'components/Orphan.tsx', "export const Orphan = () => <p>A sentence no screen reaches</p>\n")
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('the widened scope', () => {
  it('finds prose in a component a customer screen imports — the ActiveOrderBanner case', () => {
    const files = runGate(root).map((h) => h.file)
    expect(files).toContain('components/Reachable.tsx')
  })

  it('follows the graph transitively, not just one hop', () => {
    const files = runGate(root).map((h) => h.file)
    expect(files).toContain('components/nested/deeper.tsx')
  })

  it('finds prose in a context a customer screen imports', () => {
    const files = runGate(root).map((h) => h.file)
    expect(files).toContain('contexts/thing-context.tsx')
  })
})

describe('the scope stops where the ruling said it stops', () => {
  it('does NOT scan a component only a staff screen imports', () => {
    const files = runGate(root).map((h) => h.file)
    expect(files).not.toContain('components/StaffOnly.tsx')
  })

  it('does NOT scan a component nothing imports', () => {
    // "components/ and contexts/" is not "all of components/ and contexts/". A gate that opens with
    // a backlog nobody will clear is the failure mode the ruling named.
    const files = runGate(root).map((h) => h.file)
    expect(files).not.toContain('components/Orphan.tsx')
  })
})

describe('the real tree is GREEN, and the check is not vacuous', () => {
  it('exits 0 on this repo', () => {
    // The ruling: the gate must START green. If this goes red, prose was added to a customer file
    // without a copy key — which is the gate working, and the fix is to move the string.
    execFileSync('node', [SCRIPT], { encoding: 'utf8' })
  })

  it('scans more files than app/menu/ alone contains', () => {
    // CONTROL. Without this, "green" would also be the answer if the widening silently scanned
    // nothing — the failure that makes a gate decorative.
    const out = execFileSync('node', [SCRIPT], { encoding: 'utf8' })
    const scanned = Number(/\((\d+) files scanned\)/.exec(out)?.[1] ?? 0)
    expect(scanned).toBeGreaterThan(20)
    expect(out).toMatch(/customer-reachable file\(s\) under components\/, contexts\//)
  })
})
