/**
 * What the browse tab strip says, built in one place.
 *
 * Redesign spec section 9. The strip used to be a single dense sentence carrying tab status,
 * money, people, the PIN and a settlement CTA:
 *
 *     Tab open • NAD0.00 • 1 person • PIN: 1490 — Tap to settle →
 *
 * and it was assembled inline in JSX as a three-way ternary, one arm of which was JSX and two of
 * which were template strings.
 *
 * THE DEFECT THAT SHAPE PRODUCED, found while restructuring and fixed here. The pending figure
 * was appended as `stripPendingSuffix` to the two TEMPLATE-STRING arms — and the JSX arm, the one
 * taken whenever the tab has a PIN, did not carry it at all. So a customer on a PIN-protected tab
 * who had just ordered saw the payable figure alone, with nothing naming the amount the
 * restaurant had not yet confirmed. That is precisely the "told a customer who had just ordered
 * N$132 that they owed NAD0.00" failure the two-figure ruling exists to prevent, still live in
 * one arm of the branch that was supposed to have fixed it.
 *
 * The structural answer is that the money line is built ONCE, before anything branches on the
 * PIN. A caller cannot render an amount without also rendering its pending note, because they
 * come out of the same call.
 *
 * RULED 2026-08-15/16 and imported, never restated: anything that DECIDES uses payable; anything
 * that DISPLAYS shows both. The strip displays.
 *
 * `total` here is payable + pending — `tabTotal` from `contexts/tab-context.tsx`, which reads
 * `payable_total` / `pending_total` from `GET /api/tabs/[tabId]/view`. Both are server-derived.
 * Nothing in this module sums anything.
 */
import { TAB_FIGURES_COPY } from '@/lib/tabs/tab-outstanding'
import { QR_REDESIGN_PENDING_COPY } from '@/lib/customer-copy/qr-redesign-copy'

export type BrowseTabStripInput = {
  /** `tabs.status` as the browse page holds it. */
  tabStatus: string | null | undefined
  currency: string
  /** payable + pending, server-derived. */
  total: number
  /** submitted and unanswered, server-derived. */
  pending: number
  memberCount: number
  /** null when the server withheld it or the customer holds no session token. */
  tabPin: string | null | undefined
  tabPinRequired: boolean
}

export type BrowseTabStrip = {
  /** Short state word. Leads the strip. */
  headline: string
  /** Formatted money, or null when the state has no meaningful amount. */
  amount: string | null
  /** Named whenever pending is non-zero, in EVERY state that shows an amount. */
  pendingNote: string | null
  /** Demoted second line: PIN and people. Null when there is nothing to say. */
  meta: string | null
  /** The navigation affordance. The strip navigates; it does not settle. */
  cta: string
}

function formatMoney(currency: string, value: number): string {
  return `${currency}${(Number(value) || 0).toFixed(2)}`
}

/** Statuses in which the tab no longer represents a live running bill. */
const CLOSED_TAB_STATUSES = ['closed', 'settled', 'completed', 'cancelled']

export function buildBrowseTabStrip(input: BrowseTabStripInput): BrowseTabStrip {
  const status = String(input.tabStatus ?? '').toLowerCase()
  const pending = Number(input.pending) || 0

  /**
   * Built before the branch, deliberately. The previous inline version decided whether to show
   * the pending figure INSIDE the PIN branch, and one arm forgot.
   */
  const pendingNote =
    pending > 0
      ? TAB_FIGURES_COPY.tabPendingSuffix.replace('{pending}', formatMoney(input.currency, pending))
      : null

  const metaParts: string[] = []
  // Format kept literally as `PIN: <pin>`: it is what the customer has been reading, and
  // __tests__/browse-tab-pin-visible-to-joined-member.test.tsx asserts that exact substring
  // and asserts it appears exactly once on the page.
  if (input.tabPin && input.tabPinRequired) metaParts.push(`PIN: ${input.tabPin}`)
  if (input.memberCount > 0) {
    metaParts.push(`${input.memberCount} ${input.memberCount === 1 ? 'person' : 'people'}`)
  }
  const meta = metaParts.length > 0 ? metaParts.join(' · ') : null

  if (CLOSED_TAB_STATUSES.includes(status)) {
    return {
      headline: QR_REDESIGN_PENDING_COPY.stripHeadlineClosed,
      amount: null,
      pendingNote: null,
      meta: null,
      cta: QR_REDESIGN_PENDING_COPY.stripCta,
    }
  }

  if (status === 'ready_to_pay') {
    return {
      headline: QR_REDESIGN_PENDING_COPY.stripHeadlineReadyToPay,
      amount: formatMoney(input.currency, input.total),
      pendingNote,
      meta,
      cta: QR_REDESIGN_PENDING_COPY.stripCta,
    }
  }

  return {
    headline: QR_REDESIGN_PENDING_COPY.stripHeadlineOpen,
    amount: formatMoney(input.currency, input.total),
    pendingNote,
    meta,
    cta: QR_REDESIGN_PENDING_COPY.stripCta,
  }
}
