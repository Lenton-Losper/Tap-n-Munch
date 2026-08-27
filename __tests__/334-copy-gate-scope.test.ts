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

  // ------------------------------------------------------------------ hooks/, added 2026-08-27
  //
  // A customer screen importing a HOOK. Before this round the gate walked the import graph all the
  // way here and then threw the result away: `reachableFromMenu` filtered its findings down to
  // `['components','contexts']` at the last step, so a customer sentence in a hook two live screens
  // import passed GREEN. Proven by mutation against the real tree, not hypothesised.
  write(
    root,
    'app/menu/[restaurantId]/cart/page.tsx',
    [
      "import { useReachableHook } from '@/hooks/useReachableHook'",
      'export default function Page() { return <p>{useReachableHook()}</p> }',
    ].join('\n'),
  )
  write(root, 'hooks/useReachableHook.ts', "export const useReachableHook = () => 'A sentence a hook hands to a screen'\n")

  // A hook only a STAFF screen imports: OUT OF SCOPE, by the same derivation as StaffOnly.tsx.
  write(
    root,
    'app/(staff)/reports/page.tsx',
    "import { useStaffHook } from '@/hooks/useStaffHook'\nexport default useStaffHook\n",
  )
  write(root, 'hooks/useStaffHook.ts', "export const useStaffHook = () => 'A staff sentence nobody signed'\n")

  // A hook nothing imports: OUT OF SCOPE.
  write(root, 'hooks/useOrphanHook.ts', "export const useOrphanHook = () => 'A sentence no screen reaches'\n")

  // FALSE-POSITIVE GUARD. `lib/customer-copy` is the SANCTIONED HOME for customer wording and the
  // destination this gate pushes strings towards. The customer screen above reaches it through the
  // hook, so a "just derive everything, drop the directory bound" widening would fire the gate on
  // every correctly-placed string in the repo. That is the false positive that gets a gate switched
  // off, so the bound stays and this pins it.
  write(
    root,
    'hooks/useReachableHook.ts',
    [
      "import { MENU_COPY } from '@/lib/customer-copy/menu-copy'",
      "export const useReachableHook = () => 'A sentence a hook hands to a screen'",
      'export const copy = MENU_COPY',
    ].join('\n'),
  )
  write(root, 'lib/customer-copy/menu-copy.ts', "export const MENU_COPY = { k: 'A signed sentence that lives where it should' }\n")
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

  it('finds prose in a HOOK a customer screen imports', () => {
    // THE 2026-08-27 HOLE. A hook is not a component, and the gate's final prefix filter listed
    // only components/ and contexts/ -- so `hooks/useTabSessionEndedRedirect.ts`, imported by both
    // the browse and cart screens, could hold a customer sentence and the gate said OK. Same shape
    // as the original #334 miss (`a screen is not where copy lives`), one directory over.
    const files = runGate(root).map((h) => h.file)
    expect(files).toContain('hooks/useReachableHook.ts')
  })
})

describe('the scope stops where the ruling said it stops', () => {
  it('does NOT scan a component only a staff screen imports', () => {
    const files = runGate(root).map((h) => h.file)
    expect(files).not.toContain('components/StaffOnly.tsx')
  })

  it('does NOT scan a hook only a staff screen imports', () => {
    const files = runGate(root).map((h) => h.file)
    expect(files).not.toContain('hooks/useStaffHook.ts')
  })

  it('does NOT scan a hook nothing imports', () => {
    const files = runGate(root).map((h) => h.file)
    expect(files).not.toContain('hooks/useOrphanHook.ts')
  })

  it('does NOT scan lib/customer-copy, the place the gate is pushing copy TO', () => {
    // The false-positive guard for widening the directory bound. `lib/` is reachable from a
    // customer screen through the hook above, so a gate that derived scope from reachability ALONE
    // would report the sanctioned copy module as a violation -- firing on every correct string in
    // the repo. Widening a scope trades a false negative for a false positive unless something
    // pins the other side; this is that pin.
    const files = runGate(root).map((h) => h.file)
    expect(files).not.toContain('lib/customer-copy/menu-copy.ts')
    expect(files.some((f) => f.startsWith('lib/'))).toBe(false)
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
    expect(out).toMatch(/customer-reachable file\(s\) under components\/, contexts\/, hooks\//)
  })

  it('actually reaches hook files on the REAL tree, not just in the fixture', () => {
    // CONTROL for the widening itself. The fixture proves the rule; this proves the rule is
    // pointed at something. `hooks/useTabSessionEndedRedirect.ts` is imported by the browse and
    // cart screens, so a correct scope MUST include at least one hooks/ file -- otherwise the
    // widening is green because it scanned nothing, which is the decorative failure this whole
    // audit exists to find.
    const raw = execFileSync('node', [SCRIPT, '--json'], { encoding: 'utf8' })
    expect(JSON.parse(raw)).toEqual([])
    const out = execFileSync('node', [SCRIPT], { encoding: 'utf8' })
    const reachable = Number(/(\d+) customer-reachable file\(s\)/.exec(out)?.[1] ?? 0)
    const scanned = Number(/\((\d+) files scanned\)/.exec(out)?.[1] ?? 0)
    // 27 reachable / 41 scanned before hooks/ was added; the widening must have moved both.
    expect(reachable).toBeGreaterThan(27)
    expect(scanned).toBeGreaterThan(41)
  })
})
