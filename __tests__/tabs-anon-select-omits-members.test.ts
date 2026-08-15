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
 *   - lib/tab-session.ts fetchTabById           — FIXED, and it is the one that needed the seam.
 *                                                Its consumers (menu/[id]/tab and
 *                                                menu/[id]/receipt) pair a member to that
 *                                                member's orders to print a name, so simply
 *                                                stripping the column was REJECTED: both pages
 *                                                fall into their `members.length === 0` branch
 *                                                and label everybody "Guest". It now reads
 *                                                GET /api/tabs/[tabId]/view, which substitutes
 *                                                an opaque per-tab `member_key` for each
 *                                                `session_id` (lib/tab-member-key.ts).
 *
 *   - contexts/tab-context.tsx loadTab          — FIXED the same way. Feeds TabProvider, which
 *                                                browse/page.tsx reads for a count and
 *                                                menu/[id]/tab reads for the pairing.
 *
 * That earlier rejection was pinned here by an assertion that fetchTabById DID still select
 * members, with a note saying it was expected to be updated by the change that landed the seam —
 * and by nothing else. This is that change; the assertion is now its inverse.
 *
 * FAILS WITHOUT THE FIX: at 97e4fe1 v2/page.tsx, fetchActiveTabForTable, fetchTabById and
 * loadTab all name `members` in their anon select.
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

/**
 * Every first-party file that builds -- or has historically built -- a `tabs` query on the
 * BROWSER (anon) Supabase client. Originally derived from importers of '@/lib/supabase/client'
 * rather than by grepping for `members`.
 *
 * Files that no longer import that client are KEPT in this list deliberately. As of 2026-08-15
 * FOUR of them no longer import it at all -- contexts/tab-context.tsx,
 * app/menu/[restaurantId]/receipt/page.tsx, hooks/useSessionTokenGuard.ts and
 * hooks/useTabSessionEndedRedirect.ts -- having had their dead `tabs` realtime subscriptions
 * removed (QRA-17). Dropping them would leave the next anon `tabs` select added to any of them
 * unguarded, and the sweep costs nothing on a file with no matches.
 * components/orders-dashboard.tsx is deliberately absent: it runs for signed-in staff, whose
 * grants come from the `authenticated` role and are untouched by the migration.
 */
const CLIENT_TABS_READERS = [
  'app/menu/[restaurantId]/v2/page.tsx',
  'app/menu/[restaurantId]/receipt/page.tsx',
  'contexts/tab-context.tsx',
  'hooks/useSessionTokenGuard.ts',
  'hooks/useTabSessionEndedRedirect.ts',
  'lib/tab-session.ts',
  'lib/session-token.ts',
]

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

  it('fetchTabById no longer touches PostgREST at all — it reads the redacting seam', () => {
    const body = fnBody(tabSession, 'fetchTabById')
    // Not merely "does not name members": it must not build an anon `tabs` query at all, or a
    // later edit could re-add the column to a query this file still owns.
    expect(anonTabsSelects(body)).toHaveLength(0)
    expect(body).toContain('/view?')
    expect(body).not.toContain('members')
  })

  it('lib/tab-session.ts holds no anon `tabs` select naming members, at any call site', () => {
    // The whole-file sweep, because the column name lives inside this library and five of its
    // six call sites never mention the word — enumerating by call site would miss it.
    for (const columns of anonTabsSelects(tabSession)) {
      expect(columns).not.toContain('members')
    }
  })

  it('tab-context loadTab reads the seam instead of selecting members under the anon key', () => {
    const tabContext = read('contexts/tab-context.tsx')
    for (const columns of anonTabsSelects(tabContext)) {
      expect(columns).not.toContain('members')
    }
    expect(tabContext).toContain('/view?')
    expect(tabContext).toContain('self_member_keys')
  })

  it('no client anon `tabs` select anywhere names members — the grant can now be narrowed', () => {
    // PostgREST refuses the ENTIRE query when the select list names an ungranted column, so this
    // is the precondition for supabase/migrations/20260811120000_tabs_anon_grant_drop_members.sql:
    // one surviving select would be a full guest outage, not a cosmetic degradation.
    const offenders: string[] = []
    for (const relativePath of CLIENT_TABS_READERS) {
      for (const columns of anonTabsSelects(read(relativePath))) {
        if (columns.includes('members')) offenders.push(`${relativePath}: ${columns}`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('the migration removes exactly `members` and `customer_name` from the anon grant', () => {
    const grantedColumns = (sql: string): string[] => {
      const grant = /GRANT SELECT \(([^)]*)\)\s*ON TABLE public\.tabs TO anon;/.exec(sql)
      if (!grant) throw new Error('no anon column grant on public.tabs')
      return grant[1]
        .split(',')
        .map((column) => column.replace(/--.*$/gm, '').trim())
        .filter(Boolean)
    }

    const before = grantedColumns(
      read('supabase/migrations/20260726200000_enable_rls_tabs_restaurants_users_sessions.sql'),
    )
    const after = grantedColumns(
      read('supabase/migrations/20260811120000_tabs_anon_grant_drop_members.sql'),
    )

    // Column grants are not individually revocable, so the whole anon privilege set is dropped
    // and the survivors are granted back. That makes it very easy to lose a column by accident,
    // and losing one is a full guest outage: PostgREST refuses the ENTIRE query when the select
    // list names an ungranted column.
    expect(before.filter((column) => !after.includes(column))).toEqual([
      'members',
      'customer_name',
    ])
    expect(after.filter((column) => !before.includes(column))).toEqual([])
  })

  it('the migration revokes before it re-grants, or the removals do not take', () => {
    // Statements only. The header quotes the 20260726200000 policy verbatim to explain what was
    // wrong, and a comment is not a statement.
    const sql = read('supabase/migrations/20260811120000_tabs_anon_grant_drop_members.sql')
      .replace(/^[ \t]*--.*$/gm, '')

    const revoke = sql.indexOf('REVOKE ALL ON TABLE public.tabs FROM anon;')
    const grant = sql.indexOf('GRANT SELECT (')
    expect(revoke).toBeGreaterThan(-1)
    expect(grant).toBeGreaterThan(revoke)
    // The policy, the authenticated grant and the service_role grant are all out of scope.
    expect(sql).not.toContain('POLICY')
    expect(sql).not.toContain('TO authenticated')
    expect(sql).not.toContain('TO service_role')
  })

  it('the seam and the orders side derive the SAME key, or the pairing silently breaks', () => {
    // Both halves must go through lib/tab-member-key.ts. A second, independent derivation would
    // leave every line labelled "Guest" with nothing failing.
    expect(read('app/api/tabs/[tabId]/view/route.ts')).toContain("from '@/lib/tab-member-key'")
    expect(read('lib/guest-orders/queries.ts')).toContain("from '@/lib/tab-member-key'")
    // The zero-caller session-token route returned the row VERBATIM, members included; it is
    // redacted through the same helper so the two reads cannot disagree.
    expect(read('app/api/tabs/[tabId]/route.ts')).toContain('redactTabMembers')
  })
})
