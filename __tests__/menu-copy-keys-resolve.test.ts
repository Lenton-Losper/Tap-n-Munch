import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { MENU_COPY } from '@/lib/customer-copy/menu-copy'

/**
 * #334 — EVERY `MENU_COPY.x` UNDER app/menu/** MUST RESOLVE.
 *
 * `MENU_COPY.tabTotl` is not a type error in a file carrying `@ts-nocheck`; it is `undefined`, and
 * React renders `undefined` as nothing at all. The customer sees a blank where a sentence belongs
 * and no build step complains.
 *
 * Two of the screens the #334 move touched are exactly that: `v2/page.tsx` — which took 55 of the
 * 188 call sites, more than any other file — and `my-orders/page.tsx`. A green `tsc` says nothing
 * about either of them, so this is the only thing standing between a mistyped key and a silently
 * empty screen.
 *
 * It is deliberately a filesystem scan rather than a set of imports. The question is about every
 * reference that exists, and only reading the files can answer that — an import list would protect
 * the files somebody remembered to add, which is the opt-in failure #334 exists to end.
 */
function tsxFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) tsxFiles(full, out)
    else if (name.endsWith('.tsx') || name.endsWith('.ts')) out.push(full)
  }
  return out
}

describe('every MENU_COPY key referenced by a menu screen exists', () => {
  /**
   * #334 ROUND TWO widened the gate to the customer-reachable half of components/ and contexts/,
   * so the references that must resolve now live there too — and those files are exactly the ones
   * where a mistyped key is invisible: several carry `@ts-nocheck`, and React renders `undefined`
   * as nothing at all.
   */
  const files = [...tsxFiles('app/menu'), ...tsxFiles('components'), ...tsxFiles('contexts')]
  const references: { file: string; key: string }[] = []
  for (const file of files) {
    const source = readFileSync(file, 'utf8')
    for (const m of source.matchAll(/MENU_COPY\.([A-Za-z0-9_]+)/g)) {
      references.push({ file, key: m[1] })
    }
  }

  it('finds references at all, so a passing run means something', () => {
    // Without this, deleting the scan or renaming the directory turns every assertion below into a
    // vacuous pass over an empty list.
    expect(references.length).toBeGreaterThan(150)
    expect(files.length).toBeGreaterThan(10)
  })

  it('resolves every one of them', () => {
    const missing = references.filter((r) => !(r.key in MENU_COPY))
    expect(missing.map((r) => `${r.file} -> MENU_COPY.${r.key}`)).toEqual([])
  })

  it('never resolves one to an empty string', () => {
    // A key that exists but holds '' fails just as invisibly as a missing one.
    const empty = references.filter((r) => String(MENU_COPY[r.key as keyof typeof MENU_COPY] ?? '').trim() === '')
    expect(empty.map((r) => `${r.file} -> MENU_COPY.${r.key}`)).toEqual([])
  })

  it('has no key in the module that no screen uses', () => {
    // A stale key is wording nobody can see, still going through sign-off as if it shipped. The
    // seventeen keys signed off before the move are rendered by components outside app/menu, so
    // they are checked against the whole app rather than the menu screens alone.
    // `contexts` joined this list with round two: tab-context renders five keys and nothing else
    // does, so without it every one of them reads as stale.
    const everywhere = [...tsxFiles('app'), ...tsxFiles('components'), ...tsxFiles('contexts'), ...tsxFiles('lib')]
      .map((f) => readFileSync(f, 'utf8'))
      .join('\n')
    const unused = Object.keys(MENU_COPY).filter((key) => !everywhere.includes(`MENU_COPY.${key}`))
    expect(unused).toEqual([])
  })
})
