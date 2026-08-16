/**
 * #220 - "View Menu" on the QR landing must not destroy the customer's tab.
 *
 * WHY THIS IS A SOURCE SCAN AND NOT A BEHAVIOUR TEST. The fix is a deletion at one call site
 * inside a client page component. There is no rule to import: a test bound to a shared rule
 * would stay green with the deletion reverted, and `tsc` says nothing about a call that is
 * merely present. #232 taught that the hard way -- reverting a call site left jest at 10 passed
 * and tsc at exit 0, and only a scan of the shipped source turned red. So this reads the file.
 *
 * WHAT THE DEFECT WAS. `handleViewMenu` began life as `handleOrderSeparately` (98e98b9), where
 * `clearTab()` was correct -- the customer was declining to join the shared tab. `82baa3e`
 * renamed it to `handleViewMenu` and kept the call, so a button meaning "let me look at the
 * menu" still behaved like one meaning "I am not joining this tab".
 *
 * `clearTab()` is `persistTabId(null)`, which calls `clearTabSession()`. It does not clear a
 * render flag; it wipes the browser's link to the tab. A customer with an open unpaid tab lost
 * their orders and their bill and had to rejoin by PIN, and a joiner who never knew the PIN
 * could not get back at all.
 */
import fs from 'fs'
import path from 'path'

const LANDING = path.join(process.cwd(), 'app', 'menu', '[restaurantId]', 'v2', 'page.tsx')
const source = fs.readFileSync(LANDING, 'utf8')

/** Brace-match the handler body so the assertion cannot be satisfied or broken by other code. */
function bodyOf(declaration: string): string {
  const start = source.indexOf(declaration)
  if (start < 0) throw new Error(`declaration not found in page.tsx: ${declaration}`)
  const open = source.indexOf('{', start + declaration.length - 1)
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

describe('#220 - browsing the menu is not leaving the tab', () => {
  const body = bodyOf('const handleViewMenu = () =>')

  it('the extractor actually found the handler', () => {
    // Guards the scan itself: if a refactor renames the handler, this fails loudly rather than
    // letting an empty string satisfy every assertion below.
    expect(body).toContain('router.push(browseBase)')
  })

  it.each(['clearTab(', 'clearTabSession(', 'clearActiveOrderBannerState('])(
    'handleViewMenu does not call %s',
    (call) => {
      expect(body).not.toContain(call)
    }
  )

  it('the tab-elsewhere card still promises the tab stays open beside that button', () => {
    // The sharpest form of the defect: this card told the customer "Your Table N tab stays open"
    // and the button under it forgot the tab. If anyone reintroduces the clear, this pairing is
    // the contradiction they would be reintroducing.
    // Anchored on the JSX call, not the bare name: the docblock above `handleViewMenu` quotes
    // `TAB_ELSEWHERE_COPY.staysOpen(` too, and indexOf found the comment first.
    const at = source.indexOf('TAB_ELSEWHERE_COPY.staysOpen(myStoredTab')
    expect(at).toBeGreaterThan(0)
    expect(source.slice(at, at + 900)).toContain('onClick={handleViewMenu}')
  })

  it('clearing still happens where a session genuinely ends', () => {
    // The other side of the probe. This test must not be satisfiable by deleting tab-clearing
    // everywhere -- the three sites that legitimately end or invalidate a session must survive:
    // the session-ended notice, the view-only table scrub, and endTabSession.
    expect(bodyOf('const endTabSession = useCallback(')).toContain('clearTab()')
    expect(source).toContain('consumeSessionEndedNotice()')
    expect((source.match(/clearTab\(\)/g) ?? []).length).toBeGreaterThanOrEqual(3)
  })
})
