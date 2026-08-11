/**
 * Issue #262 — which anon-key queries are still allowed to ask PostgREST for `tabs.members`.
 *
 * The anon SELECT grant in
 * supabase/migrations/20260726200000_enable_rls_tabs_restaurants_users_sessions.sql covers
 * `members` under a policy with no restaurant scope, so the published anon key can list every
 * diner's `session_id` on every open tab in every restaurant. `session_id` is a credential:
 * fetchGuestOrdersBySession looks a customer's orders up by it.
 *
 * The grant cannot be narrowed until the client stops asking, because PostgREST refuses the
 * ENTIRE query when the select list names an ungranted column — it does not drop the column.
 * Code first, migration last. That makes the select lists themselves the thing to pin, and it
 * makes them pinnable only at the source level: nothing at runtime distinguishes "asked for
 * members and ignored them" from "did not ask".
 *
 * Enumerated by CLIENT-CONSTRUCTION site, never by grepping for the word `members`: five of
 * lib/tab-session.ts's six call sites never mention it, because the column name lives inside
 * the library, not at the call.
 *
 * The three anon `tabs` readers, and the state of each:
 *
 *   - app/menu/[restaurantId]/v2/page.tsx      — FIXED. Needed a count; now calls
 *                                                GET /api/tabs/active, which counts server-side.
 *   - lib/tab-session.ts fetchActiveTabForTable — FIXED. Its only consumer
 *                                                (useSessionTokenGuard's evaluateTabRow) reads
 *                                                `status` and `session_token`, never members.
 *   - lib/tab-session.ts fetchTabById           — STILL SELECTS members, deliberately. Its
 *                                                consumers (menu/[id]/tab and menu/[id]/receipt)
 *                                                pair session_id to display_name to label each
 *                                                diner's orders. Stripping the column was
 *                                                explicitly REJECTED: both pages fall into their
 *                                                `members.length === 0` branch and label
 *                                                everybody "Guest". It is the redacting seam's
 *                                                job, via an opaque per-tab member key.
 *
 * The last assertion pins that rejection. It is expected to be updated by the change that lands
 * the seam — and by nothing else.
 *
 * FAILS WITHOUT THE FIX: the first two assertions fail; v2/page.tsx and fetchActiveTabForTable
 * both name `members` in their anon select at 237caec.
 */
import { readFileSync } from 'fs'
import { join } from 'path'

const ROOT = join(__dirname, '..')

function read(relativePath: string) {
  return readFileSync(join(ROOT, relativePath), 'utf8')
}

/**
 * Every column list this source hands to PostgREST for the `tabs` table, via the anon browser
 * client. Matching on `.from('tabs')` finds the query by the client it is built on, so a select
 * added later is caught whether or not it happens to mention `members`.
 */
function anonTabsSelects(source: string): string[] {
  const selects: string[] = []
  const from = /\.from\(\s*['"]tabs['"]\s*\)/g
  let match: RegExpExecArray | null
  while ((match = from.exec(source)) !== null) {
    const tail = source.slice(match.index, match.index + 800)
    const select = /\.select\(\s*(?:\r?\n\s*)?['"`]([^'"`]*)['"`]/.exec(tail)
    if (select) selects.push(select[1])
  }
  return selects
}

function fnBody(source: string, name: string): string {
  const start = source.indexOf(`export async function ${name}(`)
  if (start < 0) throw new Error(`${name} not found`)
  const next = source.indexOf('\nexport ', start + 1)
  return source.slice(start, next < 0 ? source.length : next)
}

describe('anon `tabs` selects and `members` (#262)', () => {
  const v2 = read('app/menu/[restaurantId]/v2/page.tsx')
  const tabSession = read('lib/tab-session.ts')

  it('the QR landing page asks PostgREST for no tabs columns at all beyond its stored-tab check', () => {
    const selects = anonTabsSelects(v2)
    // Sanity: the extractor must actually be finding something, or the assertion below is vacuous.
    expect(selects.length).toBeGreaterThan(0)
    for (const columns of selects) {
      expect(columns).not.toContain('members')
    }
  })

  it('the landing page fetches its open-tab summary from the server route, not from PostgREST', () => {
    expect(v2).toContain('/api/tabs/active?')
    expect(v2).toContain('member_count')
  })

  it('fetchActiveTabForTable no longer selects members', () => {
    const selects = anonTabsSelects(fnBody(tabSession, 'fetchActiveTabForTable'))
    expect(selects).toHaveLength(1)
    expect(selects[0]).not.toContain('members')
    // Control: the rest of the column list is untouched, so this is a removal and not a rewrite.
    for (const column of ['id', 'status', 'total', 'pin_required', 'settled_type']) {
      expect(selects[0]).toContain(column)
    }
  })

  it('fetchTabById DOES still select members — the pairing tab/ and receipt/ render (recorded decision)', () => {
    const selects = anonTabsSelects(fnBody(tabSession, 'fetchTabById'))
    expect(selects).toHaveLength(1)
    expect(selects[0]).toContain('members')
  })
})
