/**
 * #206 -- what a customer is allowed to be shown when a request fails.
 *
 * THE RULING TAKEN HERE, recorded because the issue offered it as a suggestion and not a rule:
 * **default-deny**. A server error string reaches a customer's screen only if it appears in the
 * allowlist below. Everything else -- including every string nobody has thought about yet, which
 * is the whole population that matters -- becomes the caller's generic fallback.
 *
 * The alternative, a denylist of internal-looking patterns, was rejected: it is safe only for
 * the strings someone remembered to ban, and `#206` exists precisely because a route can return
 * `updateError.message` straight from Supabase. A filter whose failure mode is "leaks the one you
 * did not think of" is the wrong shape for the moment a customer is trying to work out whether
 * they have just been charged.
 *
 * WHY THE ALLOWLIST IS PATTERNS AND NOT STRINGS. Six of the customer-facing messages are
 * templated -- they interpolate a payment method, an item label, a quantity cap. Exact-string
 * matching cannot admit those, so each entry is anchored at both ends and pins the fixed words
 * around the hole. `^` and `$` are not decoration: an unanchored pattern would admit a raw
 * Postgres error that happens to contain the same sentence.
 *
 * THE ENUMERATION. Every entry below was read out of the route or the module that produces it,
 * at `cloudflare-staging`. `__tests__/customer-safe-error.test.ts` carries the full census of
 * what `/api/orders` can put in `error`, both families, so the two halves cannot drift silently:
 * add a message to a route and the census test is where it has to be classified.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO. It does not touch any route. The routes still return what
 * they return, operators still get the real text in logs and in the network tab, and no error
 * handling changes. This is a rendering filter on five client call sites.
 */

/** A message written for a customer, safe to render verbatim. */
type SafeMessage = {
  /** Anchored. Both ends. See the docblock. */
  pattern: RegExp
  /** Where it comes from, so the next person can re-read the source rather than trust this file. */
  source: string
}

export const CUSTOMER_SAFE_MESSAGES: SafeMessage[] = [
  // --- app/api/orders/route.ts, sentences written for the customer -------------------------
  {
    pattern: /^This is a view-only menu [-—] ordering is not available here\.$/,
    source: 'app/api/orders/route.ts (view-only table)',
  },
    // REMOVED 2026-08-18 (#303). The sentence 'This tab is ready to pay — you cannot add more
    // items.' was allowlisted here as customer-visible, and measurement showed no caller could
    // ever reach it: requireSessionToken runs first and validateSessionToken refuses any tab that
    // is not 'open' with a 410. The route now answers with the session-ended sentence already in
    // this list, so there is one message rather than two. An allowlist entry for an unreachable
    // path documents a guarantee that does not exist.
  {
    pattern: /^This table has been closed\. Please scan the QR code to start a new session\.$/,
    source: 'app/api/orders/route.ts (table session closed)',
  },
  {
    pattern: /^This restaurant does not accept [a-z_ ]+ payments\.$/,
    source: 'app/api/orders/route.ts (payment method not accepted)',
  },
  {
    pattern: /^This table is not available for ordering\.$/,
    source: 'app/api/orders/route.ts (table not orderable)',
  },
  {
    pattern: /^This link is not configured as a kiosk\.$/,
    source: 'app/api/orders/route.ts (kiosk misconfiguration)',
  },

  // --- app/api/tabs/[tabId]/*, sentences written for the customer ----------------------------
  // Reached by the tab page's two toasts. Enumerated by reading every `error:` literal in the
  // seven tab routes: the rest are operator text ('Missing tab id', 'Failed to load tab',
  // 'Tab is missing table_id') and are correctly denied.
  {
    pattern: /^Payment is currently being processed for this table\.$/,
    source: 'app/api/tabs/[tabId]/join/route.ts',
  },
  {
    pattern: /^This recovery link has expired or already been used\. Ask staff to generate a new one\.$/,
    source: 'app/api/tabs/[tabId]/join/route.ts',
  },
  {
    pattern: /^This tab is not available right now\.$/,
    source: 'app/api/tabs/[tabId]/join/route.ts',
  },
  // PIN wording is customer copy too. Allowlisted for the same reason as the rest -- turning
  // 'Incorrect PIN' into 'Please try again.' would be a worse screen, not a safer one -- and
  // allowlisting a string for DISPLAY changes no auth behaviour anywhere.
  { pattern: /^Incorrect PIN$/, source: 'app/api/tabs/[tabId]/join/route.ts' },
  { pattern: /^PIN required to join this tab$/, source: 'app/api/tabs/[tabId]/join/route.ts' },

  // --- lib/orders/quantity-limits.ts ---------------------------------------------------------
  {
    pattern: /^Please choose how many of .+ you would like\.$/,
    source: 'lib/orders/quantity-limits.ts',
  },
  {
    pattern: /^You can only order whole numbers of .+\.$/,
    source: 'lib/orders/quantity-limits.ts',
  },
  {
    pattern: /^Please order at least \d+ of .+\.$/,
    source: 'lib/orders/quantity-limits.ts',
  },
  {
    pattern: /^You can order up to \d+ of .+ at a time\. For a larger order, please ask a member of staff\.$/,
    source: 'lib/orders/quantity-limits.ts',
  },

  // --- lib/orders/check-stock-sufficiency.ts -------------------------------------------------
  {
    pattern: /^.+ is out of stock and cannot be ordered right now\.$/,
    source: 'lib/orders/check-stock-sufficiency.ts (single item)',
  },
  {
    pattern: /^.+ are out of stock and cannot be ordered right now\. Please remove them and try again\.$/,
    source: 'lib/orders/check-stock-sufficiency.ts (several items)',
  },
]

export type CustomerErrorVerdict = {
  /** What to render. Either the server's own sentence, or the caller's fallback. */
  text: string
  /** True when the server's sentence was recognised and is being shown verbatim. */
  allowed: boolean
  /** The matching entry's `source`, or null. Diagnostic only -- never rendered. */
  matched: string | null
}

function messageOf(raw: unknown): string {
  if (typeof raw === 'string') return raw
  if (raw instanceof Error) return raw.message
  if (raw && typeof raw === 'object' && 'message' in raw) {
    const m = (raw as { message?: unknown }).message
    if (typeof m === 'string') return m
  }
  return ''
}

/** The decision, separated from the rendering so a test can assert WHY, not only what. */
export function classifyCustomerError(raw: unknown, fallback: string): CustomerErrorVerdict {
  const message = messageOf(raw).trim()
  if (!message) return { text: fallback, allowed: false, matched: null }

  const hit = CUSTOMER_SAFE_MESSAGES.find((entry) => entry.pattern.test(message))
  if (!hit) return { text: fallback, allowed: false, matched: null }
  return { text: message, allowed: true, matched: hit.source }
}

/**
 * Render-ready. Use this at every customer-facing toast that would otherwise print `err.message`.
 *
 * `fallback` is the sentence the customer sees for everything unrecognised, so it has to stand on
 * its own -- it is the message for the majority of real failures, not an edge case.
 */
export function customerSafeError(raw: unknown, fallback: string): string {
  return classifyCustomerError(raw, fallback).text
}
