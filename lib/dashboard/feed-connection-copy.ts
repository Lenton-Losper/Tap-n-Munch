/**
 * THE FEED-CONNECTION INDICATOR'S LABELS. #350. **NOT SIGNED OFF — PLACEHOLDERS.**
 *
 * Every string below is a `PENDING COPY - ...` marker awaiting the owner's wording. They are here,
 * in a module of their own rather than inline in `components/orders-dashboard.tsx`, for two
 * reasons:
 *
 *  1. The precedent `ORDER_ALERT_COPY` and `lib/customer-copy/*` set: one place to read, and one
 *     place a marker can be found by grep. A string living inside a component is invisible to
 *     every copy gate.
 *  2. `__tests__/order-alert-copy-signed-off.test.ts` asserts that
 *     `components/orders-dashboard.tsx` carries NO `PENDING COPY` marker, because the sound labels
 *     were the last placeholders rendering on production and that test is what keeps them gone.
 *     Placeholder wording for a different feature must not be smuggled past that gate by living in
 *     the same file — so it lives here, still marked, still greppable, and pinned by
 *     `__tests__/350-feed-connection-copy-pending.test.ts` until a human replaces it.
 *
 * WHAT EACH STRING HAS TO CONVEY (this is the brief for whoever writes them, not the wording):
 *
 *  - `live`        — a STATEMENT OF FACT: orders are arriving on this screen as they happen.
 *                    No instruction. Nothing for staff to do.
 *  - `reconnecting`— a STATEMENT OF FACT: the live feed dropped and is being re-established; the
 *                    list may be a moment behind. No instruction — this state resolves itself and
 *                    telling staff to act on a two-second blip would train them to ignore it.
 *  - `offline`     — the ONE INSTRUCTION. The live feed is not working, the list is only refreshing
 *                    slowly, and orders may be arriving that this screen has not shown. It must say
 *                    what to do (check the connection / reload) because this is the only state
 *                    where a human has something to do. Same rule as `ORDER_ALERT_COPY`: two state
 *                    facts and exactly one imperative, or a status readout turns into three
 *                    competing buttons.
 *
 * Each string is used THREE times per state — visible label, `aria-label` and `title` — so each has
 * to read as a standalone statement, not as a fragment that only makes sense beside an icon.
 */
export const FEED_CONNECTION_COPY = {
  live: 'PENDING COPY - feed live',
  reconnecting: 'PENDING COPY - feed reconnecting',
  offline: 'PENDING COPY - feed offline, list refreshing slowly',
} as const
