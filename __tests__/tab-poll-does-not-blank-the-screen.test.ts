/**
 * #292 -- the Tab screen's 5-second poll must refresh in place, not blank the page.
 *
 * WHY A SOURCE SCAN. The defect is the relationship between three things in one client
 * component: `setLoading(true)` at the top of `load()`, the `setInterval` that calls it, and the
 * early return at the bottom that swaps the whole page for a spinner when `loading` is true.
 * There is no rule to import, and rendering this component means standing up the tab context, the
 * router, three fetch clients and a Supabase client -- a test that heavy would be testing the
 * mocks. `tsc` sees nothing either: every version of this code type-checks.
 *
 * So this reads the shipped source, and asserts the three facts that together made the screen
 * unusable, plus the two that keep a real ended session still being caught.
 */
import fs from 'fs'
import path from 'path'

const PAGE = path.join(process.cwd(), 'app', 'menu', '[restaurantId]', 'tab', 'page.tsx')
const source = fs.readFileSync(PAGE, 'utf8')

/** Brace-match a block so an assertion cannot be satisfied by code elsewhere in the file. */
function blockAfter(marker: string): string {
  const start = source.indexOf(marker)
  if (start < 0) throw new Error(`marker not found: ${marker}`)
  const open = source.indexOf('{', start + marker.length - 1)
  let depth = 0
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++
    else if (source[i] === '}') {
      depth--
      if (depth === 0) return source.slice(open, i + 1)
    }
  }
  throw new Error('unbalanced braces')
}

describe('#292 the poll refreshes in place', () => {
  it('the scan found the real screen', () => {
    // Guards the scan itself: an empty or moved file must fail loudly, not pass vacuously.
    expect(source).toContain('GUEST_ORDER_POLL_MS')
    expect(source).toContain('showTabLoading')
  })

  it('the interval calls load as a REFRESH', () => {
    expect(source).toMatch(/setInterval\(\(\) => void load\(true\), GUEST_ORDER_POLL_MS\)/)
  })

  it('the first load is still a first load', () => {
    // The other direction: the fix must not remove the spinner from the case that needs it.
    expect(source).toMatch(/\n\s*void load\(\)\n/)
  })

  it('setLoading(true) never runs on a refresh', () => {
    const body = blockAfter('const load = async (isRefresh = false) =>')
    expect(body).toContain('if (!isRefresh) setLoading(true)')
    // The bare form is what blanked the screen every 5 seconds.
    expect(body).not.toMatch(/\n\s*setLoading\(true\)/)
  })

  it('the full-screen spinner is still gated on loading, so the guard above is load-bearing', () => {
    // If this early return ever stops depending on `loading`, the assertions above stop meaning
    // anything and this test should be re-read rather than trusted.
    expect(source).toMatch(/if \(missingTabSession \|\| redirecting \|\| showTabLoading\) \{/)
    expect(source).toMatch(/const showTabLoading = .*\bloading\b/)
  })
})

describe('#292 a failed background poll does not evict the customer', () => {
  const body = blockAfter('const load = async (isRefresh = false) =>')

  it('the catch returns early on a refresh instead of ending the session', () => {
    expect(body).toMatch(/if \(isRefresh\) \{/)
    // Brace-matched, not a fixed window: a char count overshoots into the code AFTER the branch,
    // where handleSessionExpired legitimately still lives for the first-load case.
    const afterCatch = body.slice(body.indexOf('} catch {'))
    const at = afterCatch.indexOf('if (isRefresh) {')
    let depth = 0
    let end = at
    for (let i = afterCatch.indexOf('{', at); i < afterCatch.length; i++) {
      if (afterCatch[i] === '{') depth++
      else if (afterCatch[i] === '}') {
        depth--
        if (depth === 0) { end = i; break }
      }
    }
    const refreshBranch = afterCatch.slice(at, end + 1)
    expect(refreshBranch).toContain('return')
    expect(refreshBranch).not.toContain('handleSessionExpired')
  })

  it('a FIRST load that cannot read the tab still ends the session', () => {
    // Not a licence to swallow every failure. Nothing on screen and no readable tab is a real
    // dead end, and the customer must be told rather than left on a blank page.
    const afterCatch = body.slice(body.indexOf('} catch {'))
    expect(afterCatch).toContain('handleSessionExpired(restaurantId)')
  })

  it('a settled or missing tab still evicts, because that is real state not a failed fetch', () => {
    expect(body).toMatch(/if \(!tab \|\| String\(tab\.status \|\| ''\)\.toLowerCase\(\) === 'settled'\)/)
  })
})
