/**
 * No guest-reachable route may hand an order id to a session that does not own it.
 *
 * WHY THIS EXISTS. #305 was a working takeover — a tab-less order's raw `member_session_id` left
 * in a guest read and was still a valid edit credential. What kept it from being trivially
 * exploitable was that no listing surface returned a foreign tab-less order id, so an attacker had
 * to obtain the id some other way. That was measured and true.
 *
 * **It is not an invariant.** Nothing enforced it. It was a property of the seventeen routes that
 * happened to exist on 2026-08-17, and the eighteenth route would have reopened #305 silently,
 * with no test going red anywhere. This file is that missing enforcement.
 *
 * WHAT IT ACTUALLY GUARANTEES, stated honestly, because a scan that is oversold is worse than no
 * scan. The load-bearing half is the MANIFEST COMPLETENESS check: a new guest-reachable route
 * fails this test until somebody classifies it, which forces the question "does this return order
 * ids, and to whom?" to be answered by a person at review time. The source assertions underneath
 * are a weaker second line — they can catch a route that quietly starts reading orders, but they
 * cannot prove an ownership filter is CORRECT. Only the live chain probe
 * (`scripts/probe-302-edit-auth-chain.ts`) does that, and it is the instrument to reach for when
 * changing one of these routes.
 *
 * Same shape as `customer-screens-do-not-log-credentials.test.ts`: it scans shipped source,
 * because the property is about which routes exist, and no render or unit test can see that.
 */
import { readFileSync, readdirSync, statSync } from 'fs'
import { join } from 'path'

/**
 * How a route is allowed to relate to order ids. Every guest-reachable route must be given one.
 */
type Class =
  /** Reads no order rows at all. The strictest class, and the one most likely to drift. */
  | 'NO_ORDER_READ'
  /** Returns order ids, filtered to the CALLER'S OWN orders by the lib/guest-orders helpers. */
  | 'OWNERSHIP_FILTERED'
  /**
   * Returns OTHER diners' order ids on purpose — a shared tab is a shared bill. Gated on tab
   * membership and a server-issued session token. This is the class to be suspicious of: it is
   * the door #302 came through, and adding a route here is a security decision, not a routing one.
   */
  | 'SHARED_TAB_BY_DESIGN'
  /** Acts on ONE order the caller named and authorised; never lists ids back. */
  | 'SINGLE_ORDER_MUTATION'
  /**
   * Reads order rows but selects no `id` column, so no order id can leave however the caller is
   * authorised. The tab view sums a bill this way. Cheap to verify and easy to break: adding
   * `id` to the shared column constant would start returning ids from every caller of it at once.
   */
  | 'AGGREGATE_NO_IDS'

/**
 * THE MANIFEST — the guest-reachable surface as of #305, every entry classified deliberately.
 *
 * Adding a route without adding it here fails the test. That is the point: the failure message is
 * the review prompt.
 */
const MANIFEST: Record<string, Class> = {
  'guest/orders/[orderId]/route.ts': 'OWNERSHIP_FILTERED',
  'guest/orders/[orderId]/receipt/route.ts': 'OWNERSHIP_FILTERED',
  'guest/orders/active-table/route.ts': 'OWNERSHIP_FILTERED',
  'guest/orders/by-session/route.ts': 'OWNERSHIP_FILTERED',
  'guest/orders/by-payment-ref/route.ts': 'OWNERSHIP_FILTERED',
  'tabs/[tabId]/route.ts': 'OWNERSHIP_FILTERED',

  'tabs/[tabId]/orders/route.ts': 'SHARED_TAB_BY_DESIGN',

  /**
   * Reads orders only to sum the bill: TAB_TOTAL_ORDER_COLUMNS selects `total, payment_status,
   * tab_settlement_for_tab_id`, no id. Classified from the CODE, not from a grep -- both of these
   * mention `fetchGuestOrdersBySession` in prose only, and reading the comment instead of the
   * statement is how this manifest first got them wrong.
   */
  'tabs/[tabId]/view/route.ts': 'AGGREGATE_NO_IDS',
  'tabs/active/route.ts': 'NO_ORDER_READ',

  'guest/orders/[orderId]/edit/route.ts': 'SINGLE_ORDER_MUTATION',
  'guest/orders/[orderId]/receipt/email/route.ts': 'SINGLE_ORDER_MUTATION',

  'tabs/route.ts': 'NO_ORDER_READ',
  'tabs/join/route.ts': 'NO_ORDER_READ',
  'tabs/[tabId]/join/route.ts': 'NO_ORDER_READ',
  'tabs/[tabId]/member/route.ts': 'NO_ORDER_READ',
  'tabs/[tabId]/ready-to-pay/route.ts': 'NO_ORDER_READ',
  'tabs/[tabId]/reset-pin/route.ts': 'NO_ORDER_READ',
}

/** The trees a guest can reach without staff authentication. */
const GUEST_TREES = [join('app', 'api', 'guest'), join('app', 'api', 'tabs')]

function walkRoutes(dir: string): string[] {
  const out: string[] = []
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return out
  }
  for (const entry of entries) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...walkRoutes(full))
    else if (entry === 'route.ts') out.push(full)
  }
  return out
}

/** Manifest keys are posix-style and relative to app/api, so the file reads like a URL. */
function keyOf(absOrRel: string): string {
  return absOrRel
    .replace(process.cwd(), '')
    .replace(/\\/g, '/')
    .replace(/^\/?app\/api\//, '')
}

/**
 * Source with comments and strings-in-docblocks removed, and CRLF normalised.
 *
 * Both halves are load-bearing and both were learned the hard way: assertions have matched the
 * very comments that described them, and a scan authored in one worktree has passed there and
 * failed on a fresh checkout purely on line endings.
 */
function codeOnly(source: string): string {
  return source
    .replace(/\r\n/g, '\n')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
}

/** Does this route read order rows at all? */
const ORDER_READ = /from\(\s*['"](orders|order_requests)['"]\s*\)|fetchGuest\w*Order|buildTabOrderGroups/

/** Mechanisms that scope a read to who is asking. Presence is necessary, not sufficient. */
const OWNERSHIP_MECHANISM =
  /fetchGuest\w+|guestCanAccessOrder|requireSessionToken|assertSessionMatchesResource|sessionOwnsRow|buildTabOrderGroups/

describe('guest-reachable routes do not hand order ids to sessions that do not own them', () => {
  const files = GUEST_TREES.flatMap((t) => walkRoutes(join(process.cwd(), t)))
  const keys = files.map(keyOf).sort()

  it('finds the guest route surface at all, so an empty scan cannot report green', () => {
    // Without this, a renamed directory turns the whole file into a no-op that passes -- the
    // exact failure this suite exists to prevent, committed in the guard itself.
    expect(files.length).toBeGreaterThanOrEqual(15)
  })

  it('has a matcher that actually matches, so a silent zero cannot look like compliance', () => {
    // The positive control for a grep. `0 hits` means "clean" and "broken" identically, and a
    // security check that cannot tell those apart is not a check -- the #302 lesson, applied to
    // a regex instead of an HTTP status.
    expect(ORDER_READ.test("const x = await db.from('orders').select('id')")).toBe(true)
    expect(ORDER_READ.test("await db.from('menu_items').select('id')")).toBe(false)
    expect(OWNERSHIP_MECHANISM.test('await fetchGuestOrdersBySession(params)')).toBe(true)
    expect(codeOnly("// from('orders') in a comment\nconst a = 1")).not.toMatch(ORDER_READ)
  })

  it('classifies every guest-reachable route -- a new one fails until somebody decides', () => {
    const unclassified = keys.filter((k) => !(k in MANIFEST))
    expect(unclassified).toEqual([])
    if (unclassified.length) {
      throw new Error(
        `Unclassified guest route(s): ${unclassified.join(', ')}\n` +
          'Add each to MANIFEST in this file. Before you do, answer: does it return order ids, ' +
          'and can a session that does not own them receive any? If yes, it belongs in ' +
          'SHARED_TAB_BY_DESIGN and needs a tab-membership + token gate -- see #302 and #305.',
      )
    }
  })

  it('has no stale manifest entries pointing at deleted routes', () => {
    // A manifest that outlives its routes rots into decoration, and a rotten manifest is how the
    // completeness check above starts passing for the wrong reason.
    expect(Object.keys(MANIFEST).filter((k) => !keys.includes(k)).sort()).toEqual([])
  })

  it.each(Object.entries(MANIFEST).filter(([, c]) => c === 'NO_ORDER_READ'))(
    '%s reads no order rows',
    (key) => {
      const file = files.find((f) => keyOf(f) === key)
      if (!file) return // covered by the stale-entry test above
      const source = codeOnly(readFileSync(file, 'utf8'))
      const match = source.match(ORDER_READ)
      if (match) {
        throw new Error(
          `${key} is classified NO_ORDER_READ but now reads order rows (${match[0]}).\n` +
            'Either revert that, or reclassify it AND confirm the read is scoped to the caller. ' +
            'A route that starts listing orders is exactly how #305 would come back.',
        )
      }
      expect(match).toBeNull()
    },
  )

  it.each(
    Object.entries(MANIFEST).filter(
      ([, c]) => c === 'OWNERSHIP_FILTERED' || c === 'SHARED_TAB_BY_DESIGN',
    ),
  )('%s scopes its order read to who is asking', (key) => {
    const file = files.find((f) => keyOf(f) === key)
    if (!file) return
    const source = codeOnly(readFileSync(file, 'utf8'))
    // Necessary, not sufficient: this proves a mechanism is referenced, never that it is right.
    // Correctness of the filter is the chain probe's job, not this file's.
    expect(source).toMatch(OWNERSHIP_MECHANISM)
  })

  it('never lets an id into the shared order-column constants the tab view sums with', () => {
    // The direct form of the property, and the one with real teeth: AGGREGATE_NO_IDS holds only
    // while these strings select no id. They are shared, so adding one leaks from every caller at
    // once -- and it would look like a harmless widening in review.
    const source = codeOnly(readFileSync(join(process.cwd(), 'lib', 'tabs', 'tab-outstanding.ts'), 'utf8'))
    for (const constant of ['TAB_TOTAL_ORDER_COLUMNS', 'TAB_PENDING_REQUEST_COLUMNS']) {
      const declared = source.match(new RegExp(`${constant}\\s*(?::[^=]*)?=\\s*'([^']*)'`))
      expect(declared).not.toBeNull() // a renamed constant must fail loudly, not vanish
      const columns = (declared![1] ?? '').split(',').map((c) => c.trim())
      expect(columns.length).toBeGreaterThan(1)
      expect(columns).not.toContain('id')
      expect(columns.filter((c) => /(^|[^a-z_])id$/.test(c))).toEqual([])
    }
  })

  it('keeps the shared-tab class small, because every entry is a deliberate exposure', () => {
    // Not a style rule. SHARED_TAB_BY_DESIGN is the only class permitted to return another
    // diner's order id, so growth here should be rare enough to notice. If this fails, the new
    // route needs the #302 treatment: tab membership AND a server-issued token.
    const shared = Object.entries(MANIFEST).filter(([, c]) => c === 'SHARED_TAB_BY_DESIGN')
    expect(shared.map(([k]) => k).sort()).toEqual(['tabs/[tabId]/orders/route.ts'])
  })
})
