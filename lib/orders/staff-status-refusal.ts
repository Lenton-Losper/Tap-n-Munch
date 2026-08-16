/**
 * What a staff member is told when a status change is refused (#275).
 *
 * WHAT WAS WRONG. Two routes answered a rejected transition with the internal identifiers:
 *
 *     Invalid transition: pending → preparing
 *
 * and `components/orders-dashboard.tsx` renders `data?.error` straight into a toast at every call
 * site. So a staff member pressing **Start Preparing** at the wrong moment saw two database
 * status values and an arrow. It does not say what to do — and **"pending" is not the word the
 * dashboard uses for that state anywhere else**: its own badge for it reads **New**.
 *
 * THE REFUSAL ITSELF IS CORRECT AND IS NOT RELAXED HERE. `isValidStaffStatusTransition` has no
 * `pending → preparing` edge, deliberately: an order sitting in `pending` has not been accepted,
 * and accepting is what puts the figure in front of staff before the kitchen commits to it. This
 * module changes the WORDING and nothing else. If a future change makes the transition legal,
 * that belongs in `status-transitions.ts`, not here.
 *
 * HOW IT IS REACHED, and why this got more likely tonight rather than less. The issue's own
 * reproduction was: staff Accept, the customer REMOVES a line, the order returns to `pending` for
 * re-acceptance, staff press Start Preparing on a pre-refresh screen. As of the 2026-08-16
 * ruling a reduction no longer returns an order to `pending`, so that exact path is gone — but an
 * edit that ADDS an item does, and adding is newly possible. The path survives with a different
 * first step.
 *
 * A CODE TRAVELS WITH THE SENTENCE. #273's lesson: two verification scripts once substring-matched
 * a refusal's prose, so rewording it silently changed what they asserted while both kept passing.
 * Nothing matches these strings today — grepped across `*.ts`, `*.tsx` and `*.mjs`, and the only
 * hits are the two routes that produce them — but the next thing that wants to react to a refusal
 * should key on `code`, never on the sentence.
 */

/** The dashboard's OWN word for each status. Staff must not be shown two vocabularies. */
const STAFF_STATUS_LABEL: Record<string, string> = {
  pending: 'New',
  accepted: 'Accepted',
  preparing: 'Preparing',
  ready: 'Ready',
  ready_for_terminal: 'Ready for terminal',
  completed: 'Completed',
  cancelled: 'Cancelled',
}

/** What staff call a status. Falls back to the raw value rather than inventing one. */
export function staffStatusLabel(status: unknown): string {
  const s = String(status ?? '').trim()
  return STAFF_STATUS_LABEL[s] ?? s ?? 'unknown'
}

export type StaffStatusRefusal = {
  /** Stable identifier. React to THIS, never to the sentence. */
  code: 'NOT_ACCEPTED_YET' | 'ORDER_MOVED_ON' | 'ORDER_FINISHED' | 'UNKNOWN_STATUS'
  /** What the staff member is shown. */
  message: string
}

/**
 * Why this transition was refused, in words a staff member can act on.
 *
 * Every branch says what to DO. "Invalid transition" told them only that something was wrong,
 * which is the half they could already see.
 */
export function staffStatusRefusal(from: unknown, to: unknown): StaffStatusRefusal {
  const current = String(from ?? '').trim()
  const next = String(to ?? '').trim()
  const currentLabel = staffStatusLabel(current)
  const nextLabel = staffStatusLabel(next)

  if (current === 'completed' || current === 'cancelled') {
    return {
      code: 'ORDER_FINISHED',
      message: `This order is already ${currentLabel.toLowerCase()}, so it can't be changed.`,
    }
  }

  /**
   * The case the issue is about. An order in `pending` may be brand new, or may have come BACK
   * after a customer edit raised its total — the message covers both without asserting which,
   * because this route does not know.
   */
  if (current === 'pending' && next === 'preparing') {
    return {
      code: 'NOT_ACCEPTED_YET',
      message:
        'This order is waiting to be accepted — accept it first, then start preparing. ' +
        'If it was already accepted, the customer has changed it and it needs accepting again.',
    }
  }

  return {
    code: 'ORDER_MOVED_ON',
    message:
      `This order is ${currentLabel} and can't move straight to ${nextLabel}. ` +
      'Refresh to see where it is now.',
  }
}

/** An unrecognised target status. Separate from a refused transition: it is a client bug. */
export function staffUnknownStatusRefusal(to: unknown): StaffStatusRefusal {
  return {
    code: 'UNKNOWN_STATUS',
    message: `"${String(to ?? '').trim()}" is not a status this order can be set to.`,
  }
}
