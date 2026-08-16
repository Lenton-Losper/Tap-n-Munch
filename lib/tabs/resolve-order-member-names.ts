/**
 * Whose order is this? — for STAFF surfaces (#288).
 *
 * `TableDetailScreen.tsx:665` on the terminal renders each order's headline as
 * `{item.member_name || 'Guest'}`, and `member_name` did not exist anywhere in the web app.
 * Verified two-sided, exit codes read directly rather than through a pipe:
 *
 *     git grep -q "member_name"       -- '*.ts' '*.tsx' '*.sql'  -> exit 1  ABSENT
 *     git grep -q "member_session_id" -- '*.ts'                  -> exit 0  control, search works
 *
 * So the fallback fired on every row, always, and staff saw a table of orders all labelled
 * "Guest". That is not cosmetic: the terminal ships a per-order multi-select and a "Settle
 * Selected" button, which is the feature that answers *"I'll pay mine"* — and it cannot be used
 * as intended if staff cannot tell which orders are whose.
 *
 * WHY THIS IS NOT THE SAME FUNCTION THE CUSTOMER TAB USES. `lib/tab-member-key.ts` hands the
 * CUSTOMER an opaque per-tab `member_key`, because a raw `session_id` is a credential and one
 * diner must not learn another's. The terminal is staff-facing and already authenticated by
 * `requireTerminalAuth`, so it needs the NAME and never the key. Deriving keys here would add a
 * per-tab HKDF for no benefit and would hand staff a value they cannot use.
 *
 * WHAT IT DOES NOT DO: it never invents an owner. An order whose `member_session_id` matches no
 * member returns `null`, and the terminal's own `|| 'Guest'` fallback handles it — which is the
 * honest answer for an order placed before its placer joined, or by a member who has since been
 * removed. Guessing (first member, most recent member) would put one diner's food under another
 * diner's name on a screen that is about to charge somebody.
 */

/** The shape of one entry in the `tabs.members` JSONB array. */
type StoredTabMember = {
  session_id?: unknown
  display_name?: unknown
}

function str(value: unknown): string {
  return String(value ?? '').trim()
}

/**
 * `session_id` -> display name, for one tab's members.
 *
 * Members with no session id or no name are skipped rather than mapped to an empty string: an
 * empty name would suppress the terminal's `|| 'Guest'` fallback and render a blank headline.
 */
export function buildMemberNameLookup(members: unknown): Map<string, string> {
  const lookup = new Map<string, string>()
  if (!Array.isArray(members)) return lookup
  for (const raw of members) {
    const member = (raw ?? {}) as StoredTabMember
    const sessionId = str(member.session_id)
    const displayName = str(member.display_name)
    if (!sessionId || !displayName) continue
    lookup.set(sessionId, displayName)
  }
  return lookup
}

/**
 * The name to show against an order, or `null` when it cannot be established.
 *
 * `member_session_id` first, falling back to `session_id` — the same precedence every other
 * surface applies (`lib/tab-member-key.ts`, the customer tab page). Restating it differently
 * here is the #278 class of bug: one question, several private answers.
 */
export function resolveOrderMemberName(
  order: { member_session_id?: unknown; session_id?: unknown },
  lookup: Map<string, string>,
): string | null {
  const sessionId = str(order?.member_session_id) || str(order?.session_id)
  if (!sessionId) return null
  return lookup.get(sessionId) ?? null
}
