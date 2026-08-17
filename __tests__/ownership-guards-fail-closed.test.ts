/**
 * An ownership guard must FAIL CLOSED when the field it reads is absent.
 *
 * THE SHAPE THIS BANS, and it looks completely reasonable:
 *
 *     const mine = String(row.session_id || '').trim()
 *     if (mine && mine !== scopedSessionId) return false     // <-- fails OPEN
 *
 * The `mine &&` is there to tolerate a missing field. It means that the moment the field IS
 * missing, the comparison is skipped and the row is ACCEPTED. That is the opposite of what an
 * ownership check is for, and it is invisible until something starts redacting the field.
 *
 * WHY THIS EXISTS. #302/#305 made `redactGuestOrderMemberIds` strip `session_id` from rows the
 * caller does not own. `hooks/useActiveOrders.ts` filtered a TABLE-WIDE read with exactly the
 * shape above, so a stranger's order — number, items, total — appeared in another customer's
 * Active Order Banner. A fix for a disclosure defect introduced a disclosure defect. It reached
 * production and was rolled back within the hour.
 *
 * NOTHING ELSE CAUGHT IT. `tsc` cannot: both branches typecheck. The unit suite cannot: no test
 * asserted the negative case. The staging chain probe and the production read-only probe cannot:
 * they read JSON server-side and a client-side filter is invisible to them. Only reading the file
 * caught it, which is why the guard is a scan — a scan is the only instrument that can see a
 * shape.
 *
 * WHAT IT DOES NOT DO. It does not verify that any particular guard is CORRECT, only that it does
 * not use the fail-open shape. A guard comparing the wrong two things passes this and is still
 * wrong. It also only sees the customer app and the shared libs; a server route that builds its
 * own filter is out of scope here and covered by
 * `guest-routes-do-not-leak-foreign-order-ids.test.ts`.
 */
import { readFileSync, readdirSync, statSync } from 'fs'
import { join } from 'path'

/** Trees where a redacted guest-order row can reach a filter. */
const TREES = [
  join('app', 'menu'),
  join('app', 'order-confirmation'),
  'components',
  'hooks',
  'contexts',
  join('lib', 'guest-orders'),
  join('lib', 'tabs'),
]

/** Fields that `redactGuestOrderMemberIds` can set to null, so any guard on them can go absent. */
const REDACTABLE = ['session_id', 'member_session_id']

function walk(dir: string): string[] {
  const out: string[] = []
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return out
  }
  for (const entry of entries) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...walk(full))
    else if (/\.tsx?$/.test(entry)) out.push(full)
  }
  return out
}

/**
 * Comments and CRLF stripped. Both load-bearing: this file's own docblock contains the banned
 * shape as an example, and a scan authored on Windows has failed on a fresh checkout over line
 * endings before.
 */
const codeOnly = (s: string) =>
  s.replace(/\r\n/g, '\n').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')

/**
 * `if (x && x !== y)` / `if (x && x != y)` where `x` is a variable holding a redactable field.
 *
 * Deliberately crude. A parser would be more precise and would also be a second thing to
 * maintain, and the failure mode of a crude matcher here is a false positive somebody reads and
 * dismisses — not a missed fail-open guard.
 */
const FAIL_OPEN = /if\s*\(\s*([A-Za-z_$][\w$]*)\s*&&\s*\1\s*!==?\s*[^)]+\)/g

/** Does this variable get its value from a redactable field? */
function boundToRedactableField(source: string, variable: string): boolean {
  const decl = new RegExp(
    `(?:const|let|var)\\s+${variable}\\s*=\\s*[^\\n;]*(?:${REDACTABLE.join('|')})`,
  )
  return decl.test(source)
}

describe('ownership guards fail closed when a redacted field is absent', () => {
  const files = TREES.flatMap((t) => walk(join(process.cwd(), t)))

  it('found the customer app, so an empty scan cannot report green', () => {
    // Without this a renamed directory turns the whole file into a no-op that passes — the exact
    // failure mode this suite exists to prevent, committed in the guard itself.
    expect(files.length).toBeGreaterThan(30)
  })

  it('has a matcher that actually matches, so a silent zero cannot look like compliance', () => {
    const bad = "const mine = String(row.session_id || '').trim()\nif (mine && mine !== scoped) return false"
    const good = "const mine = String(row.session_id || '').trim()\nif (mine !== scoped) return false"
    const unrelated = "if (name && name !== other) return false"

    expect([...bad.matchAll(FAIL_OPEN)].length).toBe(1)
    expect(boundToRedactableField(bad, 'mine')).toBe(true)

    expect([...good.matchAll(FAIL_OPEN)].length).toBe(0)

    // A guard on something that is never redacted is not this defect and must not be flagged.
    expect([...unrelated.matchAll(FAIL_OPEN)].length).toBe(1)
    expect(boundToRedactableField(unrelated, 'name')).toBe(false)

    // And the comment stripper must strip, or this file's own docblock trips the scan.
    expect(codeOnly("// if (mine && mine !== scoped) return false\nconst a = 1")).not.toMatch(/if\s*\(/)
  })

  it('no guard on a redactable field uses the fail-open shape', () => {
    const offenders: string[] = []

    for (const file of files) {
      const source = codeOnly(readFileSync(file, 'utf8'))
      for (const match of source.matchAll(FAIL_OPEN)) {
        const variable = match[1]
        if (!boundToRedactableField(source, variable)) continue
        const line = source.slice(0, match.index ?? 0).split('\n').length
        offenders.push(`${file.replace(process.cwd(), '').replace(/\\/g, '/')}:${line}  ${match[0].trim()}`)
      }
    }

    if (offenders.length) {
      throw new Error(
        'These guards read a field that redaction can null, and SKIP the check when it is absent,\n' +
          'which accepts the row instead of rejecting it:\n  ' +
          offenders.join('\n  ') +
          '\n\nDrop the `x &&` and compare directly, so absent means not-mine:\n' +
          '    if (mine !== scopedSessionId) return false\n' +
          'If the surface genuinely must show rows it cannot attribute, it needs its own\n' +
          'authorisation — not a guard that gives up. See hooks/useActiveOrders.ts for the ruling.',
      )
    }
    expect(offenders).toEqual([])
  })
})
