/**
 * Opaque, per-tab member keys (#262).
 *
 * `tabs.members` is a JSONB array of `{ session_id, display_name, joined_at }`, and the anon
 * SELECT grant in 20260726200000 covers that column under a policy with no restaurant scope.
 * A `session_id` is a credential -- lib/guest-orders/queries.ts fetchGuestOrdersBySession
 * looks a diner's orders up by it -- so the published anon key could enumerate every diner's
 * credential on every open tab in every restaurant.
 *
 * The two client screens that still need the array do not need the credential: they need to
 * pair a member with THEIR OWN orders to print a name next to a line. So the server hands out
 * a per-tab, per-member key derived from a secret the client never has, and applies the SAME
 * derivation to `orders.member_session_id` on its way out, so the join the client was already
 * doing still resolves against values that are useless anywhere else.
 *
 * CONSTRUCTION
 *
 *   PRK        = HKDF-Extract(salt = "flashtap:tab-member-key:v1", ikm = SUPABASE_SERVICE_ROLE_KEY)
 *   K_tab      = HKDF-Expand(PRK, info = <tab id>, 32 bytes)
 *   member_key = "mk_" || hex(HMAC-SHA256(K_tab, "flashtap:tab-member-key:v1|" || session_id)[0..16])
 *
 * The four properties this has to have, and where each one lives:
 *
 *   1. VERSIONED DOMAIN SEPARATION -- TAB_MEMBER_KEY_DOMAIN below is the HKDF salt, so this
 *      derivation cannot collide with any other use of the same service-role secret however
 *      that other use is parameterised. The `:v1` is the escape hatch: bumping it rotates every
 *      member key in the product without touching the secret itself, which is what you want if
 *      a key ever has to be invalidated independently of Supabase credentials.
 *
 *   2. NO SECRET, NO KEYS -- readServiceRoleSecret() throws. There is deliberately no fallback,
 *      no default and no empty-string branch: an absent secret must be a loud 500, never a
 *      quietly-guessable key (a constant fallback would make every deployment derive the same
 *      keys) and never a silent pass-through of the raw session id.
 *
 *   3. NEVER PERSISTED -- this module imports NOTHING. It has no database client and cannot
 *      write. Both sides map at READ time: the seam maps `members[].session_id` as it responds,
 *      and the guest-orders reader maps `member_session_id` as it responds. The stored rows
 *      still hold real session ids, so staff tooling, the Accept path and the settle path are
 *      untouched. A row that ever came back holding a `mk_` value would be a defect.
 *
 *   4. PER TAB -- the tab id is the HKDF `info`, so the same diner in two tabs gets two
 *      unrelated keys and a key harvested from one tab says nothing about any other.
 *
 * Web Crypto, not node:crypto. Both worker configs run `nodejs_compat`, but the rest of the
 * codebase's crypto (lib/terminal-auth/pin-credentials.ts, lib/terminals/refresh-token.ts)
 * uses `crypto.subtle` and nothing imports node:crypto at all; this stays on the path that is
 * already proven in the Workers runtime.
 */

/**
 * The versioned domain-separation label. Used as the HKDF salt AND as a prefix on the HMAC
 * message, so neither stage can be made to agree with another derivation from the same secret.
 * Changing this string rotates every member key. That is the point -- see (1) above.
 */
export const TAB_MEMBER_KEY_DOMAIN = 'flashtap:tab-member-key:v1'

/**
 * Marks a value as derived rather than stored. Cheap, but it is what makes (3) auditable: a
 * `mk_` prefix showing up in a write payload, a log line or a database row is unambiguous.
 */
const MEMBER_KEY_PREFIX = 'mk_'

/** 128 bits of a SHA-256 MAC. Collision-free in practice for the handful of members on a tab. */
const MEMBER_KEY_BYTES = 16

/** What a client is allowed to know about another diner on the same tab. No session_id. */
export type PublicTabMember = {
  display_name: string
  joined_at: unknown
  member_key: string
}

const encoder = new TextEncoder()

function toHex(bytes: Uint8Array): string {
  let out = ''
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0')
  return out
}

/**
 * Requirement (2). Throws rather than returning anything usable.
 *
 * Read on every derivation instead of at module scope so the failure lands on the request that
 * needed a key, with a stack that points at it -- a module-scope throw in a Worker would fail
 * whichever request happened to warm the isolate.
 */
function readServiceRoleSecret(): string {
  const secret = String(process.env.SUPABASE_SERVICE_ROLE_KEY ?? '').trim()
  if (!secret) {
    throw new Error(
      'SUPABASE_SERVICE_ROLE_KEY is required to derive tab member keys. There is no fallback ' +
        'by design: a default secret would make every deployment derive identical keys, and an ' +
        'empty one would mean handing out raw session ids.',
    )
  }
  return secret
}

/**
 * One HKDF per tab, then one HMAC per member. Returns the per-member function so a caller with
 * a whole members array pays for the expand step once.
 */
export async function createTabMemberKeyDeriver(
  tabId: string,
): Promise<(sessionId: string) => Promise<string>> {
  const tab = String(tabId ?? '').trim()
  if (!tab) {
    // Not a user-input failure: every call site has a tab row in hand. An empty info parameter
    // would make keys shared across tabs, which is exactly the property (4) exists to provide.
    throw new Error('Cannot derive a tab member key without a tab id')
  }

  const ikm = await crypto.subtle.importKey(
    'raw',
    encoder.encode(readServiceRoleSecret()),
    'HKDF',
    false,
    ['deriveBits'],
  )

  const tabKeyBits = await crypto.subtle.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: encoder.encode(TAB_MEMBER_KEY_DOMAIN),
      info: encoder.encode(tab),
    },
    ikm,
    256,
  )

  const macKey = await crypto.subtle.importKey(
    'raw',
    tabKeyBits,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )

  return async (sessionId: string): Promise<string> => {
    const sid = String(sessionId ?? '').trim()
    // A member row with no session id has no key. tab/page.tsx already drops such rows; giving
    // them a key derived from '' would collide every one of them onto the same value.
    if (!sid) return ''
    const mac = await crypto.subtle.sign(
      'HMAC',
      macKey,
      encoder.encode(`${TAB_MEMBER_KEY_DOMAIN}|${sid}`),
    )
    return MEMBER_KEY_PREFIX + toHex(new Uint8Array(mac).subarray(0, MEMBER_KEY_BYTES))
  }
}

/** Single-shot form. Prefer createTabMemberKeyDeriver when deriving more than one key. */
export async function deriveTabMemberKey(tabId: string, sessionId: string): Promise<string> {
  const derive = await createTabMemberKeyDeriver(tabId)
  return derive(sessionId)
}

/**
 * The stored `tabs.members` array, as a client is allowed to see it.
 *
 * Builds NEW objects rather than spreading the stored row and deleting `session_id`: a spread
 * would carry any column added to the JSONB later straight out to the client, which is how
 * this leak got here. Whitelist, not blacklist. The input is never mutated -- see (3).
 */
export async function redactTabMembers(
  tabId: string,
  members: unknown,
): Promise<PublicTabMember[]> {
  const rows = Array.isArray(members) ? members : []
  if (rows.length === 0) return []

  const derive = await createTabMemberKeyDeriver(tabId)
  const out: PublicTabMember[] = []
  for (const raw of rows) {
    const member = (raw ?? {}) as Record<string, unknown>
    out.push({
      display_name: String(member.display_name ?? '').trim(),
      joined_at: member.joined_at ?? null,
      member_key: await derive(String(member.session_id ?? '')),
    })
  }
  return out
}

/**
 * The order side of the same mapping.
 *
 * `member_session_id` is what the tab and receipt screens join against the members array, so it
 * has to travel through the same derivation or the pairing silently degrades to "Guest" for
 * everybody. Falls back to `session_id` when `member_session_id` is null, because that is the
 * fallback the two screens already apply (`o.member_session_id || o.session_id`) and orders
 * placed before member_session_id existed still rely on it.
 *
 * Rows with no tab cannot have a key derived for them -- the deriver is keyed by `tab_id` -- so on
 * those rows `member_session_id` is WITHHELD from callers who do not own the row (#305) instead of
 * being substituted. Withholding is safe there precisely because such a row is never joined
 * against a members array: every consumer of the value is a members lookup that needs a tab.
 */
export async function redactGuestOrderMemberIds<T extends Record<string, unknown>>(
  rows: T[],
  /**
   * The session ids the CALLER holds. Rows they do not own have `session_id` stripped (#302).
   *
   * `member_session_id` has been substituted with an opaque per-tab key since #262, but
   * `session_id` was passed through untouched -- so `GET /api/guest/orders/<id>` handed another
   * diner's raw session id to anyone who could read the row. That value was the edit route's
   * credential, which turned "can see your order" into "can rewrite your order". Measured.
   *
   * Scoped to rows the caller does NOT own rather than stripped outright, because the customer's
   * own screens read it: `receipt/page.tsx:180` falls back to `order.session_id` to put a member
   * name on their own line. Blanket removal would replace real names with "Guest" on a screen
   * that is behaving correctly.
   *
   * Defaults to `[]`, so a caller that forgets to pass its ids gets the SAFE behaviour -- every
   * row redacted -- rather than the leaky one.
   */
  callerSessionIds: string[] = [],
): Promise<T[]> {
  const held = new Set(
    (Array.isArray(callerSessionIds) ? callerSessionIds : [])
      .map((id) => String(id ?? '').trim())
      .filter(Boolean),
  )
  if (!Array.isArray(rows) || rows.length === 0) return rows

  const derivers = new Map<string, (sessionId: string) => Promise<string>>()
  const out: T[] = []

  for (const row of rows) {
    const tabId = String(row?.tab_id ?? '').trim()
    const sessionId =
      String(row?.member_session_id ?? '').trim() || String(row?.session_id ?? '').trim()

    // Strip the raw session id from any row the caller does not own, whatever else happens below.
    const ownsRow = [row?.member_session_id, row?.session_id]
      .map((v) => String(v ?? '').trim())
      .filter(Boolean)
      .some((v) => held.has(v))
    const scrubbed = (ownsRow ? row : { ...row, session_id: null }) as T

    if (!tabId || !sessionId) {
      /**
       * #305 — the tab-less row, and the door #302 left open.
       *
       * There is no `tab_id` to key the deriver with, so the #262 substitution cannot run and
       * `member_session_id` would otherwise leave RAW. On the tab-less path that value is not
       * merely identifying, it is a working credential: the edit route authorises on session id
       * against `session_id` OR `member_session_id`, and it does not require a token here because
       * the token guard is scoped to `if (tabId)` -- correctly, since widening it would refuse
       * solo diners who never had a tab. Measured before the fix: foreign read -> raw id -> edit
       * lock 200 -> lines replaced.
       *
       * So WITHHOLD it rather than substitute it, but only for callers who do not own the row.
       * Nothing legitimate loses anything: every consumer is a members-array lookup that needs a
       * tab, and each already handles the miss. `orders/history/route.ts:101` gates its join on
       * `order.tab_id` outright; `getOrderCustomerLabel` falls through to `session_id` and then
       * 'Guest'; `resolveOrderMemberName` returns null. The owner keeps the value, which is what
       * their own receipt screen reads.
       */
      out.push(ownsRow ? scrubbed : ({ ...scrubbed, member_session_id: null } as T))
      continue
    }

    let derive = derivers.get(tabId)
    if (!derive) {
      derive = await createTabMemberKeyDeriver(tabId)
      derivers.set(tabId, derive)
    }

    out.push({ ...scrubbed, member_session_id: await derive(sessionId) } as T)
  }

  return out
}
