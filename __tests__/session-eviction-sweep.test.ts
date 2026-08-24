/**
 * #294 -- which failures may end a customer's dining session, and which may not.
 *
 * `handleSessionExpired` is not a redirect. It clears the session token, the tab id, the table
 * and the cart, then hard-navigates to /session-ended. Calling it destroys the customer's route
 * back to their own bill, and a joiner who never knew the PIN cannot get back at all.
 *
 * THE RULE, applied across every call site in the sweep:
 *
 *   - an explicit 410 from the server                 -> the session IS over. Evict.
 *   - a tab read that succeeds and says settled/gone  -> the session IS over. Evict.
 *   - the customer pressing an "end session" control  -> evict.
 *   - ANY thrown request (500, network, parse)        -> the session is NOT over. Keep it.
 *   - one 404 on one order                            -> the session is NOT over. Keep it.
 *
 * WHY A SOURCE SCAN. These are catch blocks and early returns inside three large client page
 * components. There is no rule to import; the defect is which branch calls which function. `tsc`
 * type-checks every version of this identically, and jest cannot reach the branch without
 * standing up a router, a tab context and three fetch clients. #232 settled that a call-site
 * fact needs a call-site instrument.
 *
 * A browser CAN see this one, and should: `tests/e2e/session-not-evicted.spec.ts` drives it.
 * This file is the cheap guard that runs on every commit.
 */
import { MENU_COPY } from '@/lib/customer-copy/menu-copy'
import fs from 'fs'
import path from 'path'

/**
 * Normalised to LF. This repo checks out CRLF on Windows and every assertion below anchors on a
 * bare newline. The #292 test was written in a worktree that happened to hold LF: it passed there
 * and FAILED on a fresh checkout of the same commit, which is a test reporting on the checkout
 * rather than on the code.
 */
const read = (...p: string[]) =>
  fs.readFileSync(path.join(process.cwd(), ...p), 'utf8').replace(/\r\n/g, '\n')

const CONFIRM = read('app', 'menu', '[restaurantId]', 'order-confirmation', '[orderId]', 'page.tsx')
const RECEIPT = read('app', 'menu', '[restaurantId]', 'receipt', 'page.tsx')
const TAB = read('app', 'menu', '[restaurantId]', 'tab', 'page.tsx')
const FETCH_WITH_SESSION = read('lib', 'fetch-with-session.ts')

/**
 * Strip comments before asserting on CODE.
 *
 * Earned three times over in this run: a docblock that explains a fix necessarily quotes the
 * thing it removed, so `not.toContain('router.push')` failed on the comment describing why
 * `router.push` is gone. An assertion that reads comments is testing the prose.
 */
function codeOnly(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}

/** Brace-match a block so an assertion cannot be satisfied by unrelated code in the same file. */
function blockAfter(source: string, marker: string): string {
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

describe('#294 order-confirmation: a missing order is not an ended session', () => {
  it('the scan found the real page', () => {
    expect(CONFIRM).toContain('fetchGuestOrderById')
  })

  it('does not bounce to the landing when the order is missing', () => {
    // The landing validates the stored token and evicts on 410, so pushing there turned a 404 on
    // ONE order into "Your dining session has ended".
    //
    // BRACE-MATCHED, not a proximity regex. The first version of this assertion was
    // `not.toMatch(/if \(!row\) \{\s*\n\s*router\.push/)` and the two-sided probe caught it:
    // restoring the defect left the suite GREEN, because the docblock explaining the fix now sits
    // between the `if` and the push. An assertion the defect walks straight through is worse than
    // no assertion, because it reads as coverage.
    const branch = blockAfter(codeOnly(CONFIRM), 'if (!row)')
    expect(branch).not.toContain('router.push')
    expect(branch).toContain('setLoading(false)')
  })

  it('renders its own Order Not Found screen instead', () => {
    // TWO-SIDED since #334 moved the literal into the copy module. The screen still renders exactly
    // this sentence; only its home changed. Asserting the key in the page AND the text in the copy
    // module means neither half can be deleted without a failure -- a one-sided check on the page
    // would now pass while the string itself was silently reworded.
    expect(CONFIRM).toContain('MENU_COPY.orderNotFound')
    expect(MENU_COPY.orderNotFound).toBe('Order Not Found')
  })

  it('never calls handleSessionExpired at all', () => {
    // This screen has no business ending a session. If that ever changes it should be a decision,
    // not an import that crept in.
    //
    // Asserted on the IMPORT and on a call with parentheses, not on the bare name: the docblock
    // explaining this fix quotes `handleSessionExpired`, and a naive substring match failed on my
    // own comment.
    expect(CONFIRM).not.toContain("from '@/lib/handle-session-expired'")
    expect(codeOnly(CONFIRM)).not.toMatch(/handleSessionExpired\(/)
  })
})

describe('#294 receipt: a failed request is not an ended session', () => {
  const body = blockAfter(RECEIPT, 'const validateAndLoad = async (isRefresh = false) =>')

  it('the catch no longer evicts', () => {
    const afterCatch = codeOnly(body).slice(codeOnly(body).indexOf('} catch (error) {'))
    expect(afterCatch).not.toContain('handleSessionExpired')
    expect(afterCatch).toContain('setLoadError(true)')
  })

  it('a settled or missing tab STILL evicts, because that is real state', () => {
    // The fix must not swallow a genuinely ended session. fetchTabById throws on any non-ok
    // response and returns null only on a clean 200 with no tab, so this branch is real state.
    //
    // Scoped to the settled BRANCH, not the whole function. The first version asserted
    // `body.toContain('handleSessionExpired(restaurantId)')`, and the probe caught it: deleting
    // the eviction from this branch left the suite green, because two other eviction sites in the
    // same function satisfied the substring. "Something in here still evicts" is not the claim.
    const settled = blockAfter(
      codeOnly(body),
      "if (!tab || String(tab.status || '').toLowerCase() === 'settled')",
    )
    expect(settled).toContain('handleSessionExpired(restaurantId)')
  })

  it('the poll refreshes in place rather than blanking the screen', () => {
    // The same defect as #292, on a second screen, found by this sweep.
    expect(body).toContain('if (!isRefresh) setLoading(true)')
    expect(body).not.toMatch(/\n\s*setLoading\(true\)/)
    expect(RECEIPT).toMatch(/setInterval\(\(\) => \{\s*\n\s*void validateAndLoad\(true\)/)
  })
})

describe('#294 the sites that SHOULD evict still do', () => {
  it('fetch-with-session evicts on 410 and nothing else', () => {
    expect(FETCH_WITH_SESSION).toMatch(/if \(response\.status === 410\) \{\s*\n\s*handleSessionExpired/)
    // No other status may trigger it -- a 500 wrapper would silently evict every screen at once.
    const calls = codeOnly(FETCH_WITH_SESSION).match(/handleSessionExpired/g) ?? []
    expect(calls.length).toBe(2) // the import and the single 410 call
  })

  it('the tab screen still evicts on a settled tab', () => {
    expect(TAB).toMatch(/if \(!tab \|\| String\(tab\.status \|\| ''\)\.toLowerCase\(\) === 'settled'\)/)
  })

  it('the tab screen still refuses to evict on a failed refresh (#292 stays fixed)', () => {
    const body = blockAfter(TAB, 'const load = async (isRefresh = false) =>')
    const afterCatch = body.slice(body.indexOf('} catch {'))
    expect(afterCatch).toContain('if (isRefresh) {')
  })
})
