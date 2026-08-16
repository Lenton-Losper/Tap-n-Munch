/**
 * #209 -- what a customer is told when the method they chose is withdrawn mid-tab.
 *
 * THE DEFECT. `tab/page.tsx` named CASH unconditionally in a branch that is not gated on cash:
 *
 *     description: 'Cash payments are no longer available. Please select Card.'
 *
 * A customer who chose Card, and whose card option was turned off mid-session, was told cash was
 * gone and instructed to pick the method that had just been withdrawn. The handler then cleared
 * their preference and returned them to the selector with that wrong guidance.
 *
 * A CORRECTION TO THE ISSUE. #209 says the same applies to `'other'`. It does not. The route
 * guards with `paymentPreference !== 'other'`
 * (`app/api/tabs/[tabId]/ready-to-pay/route.ts:80`), so `'other'` can never reach this branch.
 * The 403 fires for CASH or CARD only -- so the old string was correct for one of TWO triggers,
 * not one of three. `'other'` is still handled here, because a client should not depend on a
 * server guard staying where it is, but it is a defensive path and not a live case.
 *
 * OPTION A, AND IT NEEDED NO API CHANGE. #209 offers A (name the withdrawn method) if the API
 * returns enough to distinguish, otherwise B (one neutral string). A is available for free: the
 * client already knows what it sent. `paymentPreference` is the value posted at `:283`, so it is
 * the authoritative answer to "which method was refused" without reading the response at all.
 *
 * WHY IT NO LONGER NAMES A REPLACEMENT. The old string ended "Please select Card." -- a hardcoded
 * suggestion that was wrong whenever card was the method withdrawn, and that this module cannot
 * make right either: nothing here knows which of the remaining methods are still enabled. So it
 * says to choose another and lets the selector, which has just been refreshed from settings, be
 * the thing that tells the truth about what is available.
 *
 * COPY STATUS. Not marked `PENDING COPY`. These strings are a mechanical parameterisation of
 * wording #204 Q1 already ruled ships as-written, and the marker renders verbatim to customers --
 * putting it on an already-live payment instruction would be a regression, not caution.
 */

export type PaymentPreference = 'cash' | 'card' | 'other'

const METHOD_NOUN: Record<PaymentPreference, string> = {
  cash: 'Cash',
  card: 'Card',
  other: 'That',
}

export const PAYMENT_METHOD_WITHDRAWN_TITLE = 'Payment option unavailable'

/**
 * The body of the toast raised when `/api/tabs/[tabId]/ready-to-pay` refuses the chosen method.
 *
 * `preference` is what the CLIENT sent, not what the server echoed -- see the docblock.
 */
export function paymentMethodWithdrawnCopy(preference: PaymentPreference | null): string {
  const noun = preference ? METHOD_NOUN[preference] : 'That'
  return `${noun} payments are no longer available. Please choose another method.`
}
