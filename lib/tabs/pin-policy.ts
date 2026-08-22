/**
 * #236 — what `pin_required` plus `tab_pin` actually mean, decided in ONE place.
 *
 * THE DEFECT. Two sites computed the same predicate inline:
 *
 *     const pinRequired = tab.pin_required !== false && Boolean(tab.tab_pin)
 *
 * With `pin_required = true` and `tab_pin = NULL`, `Boolean(null)` is false, so `pinRequired`
 * came out FALSE and the PIN check was skipped entirely. Setting the flag without a PIN did not
 * enforce protection — it silently REMOVED it, on the one route that lets a stranger join an open
 * tab. A restaurant that believed it had PIN protection had none.
 *
 * THE RULING IS NOT NEW. `app/api/tabs/route.ts` already resolves the identical question on its
 * 23505 branch, ruled by the owner 2026-08-15: "tab HAS a pin -> the caller must present it; tab
 * has NO pin -> refuse rather than mint." That branch fails CLOSED and names #236 as the place
 * where the same case was still being resolved the other way. This makes the two agree.
 *
 * WHY MISCONFIGURED BLOCKS RATHER THAN FALLING BACK TO NO-PIN:
 *
 *  - `pin_required` is the operator's stated intent that this tab be restricted. A missing PIN is
 *    a broken configuration, not a waiver. Reading it as a waiver lets a data problem silently
 *    switch off a security control, which is the defect itself, not a fix for it.
 *  - The failure modes are not symmetric. Blocking is visible and recoverable in seconds — staff
 *    set a PIN or clear the flag. Allowing is invisible and NOT recoverable: by the time anyone
 *    notices, strangers may already have joined and ordered against the tab.
 *  - Measured on production 2026-08-22, paginated: 37 tabs, 2 with the flag set, and BOTH have a
 *    PIN. Zero tabs are in the misconfigured state, so failing closed has no blast radius today.
 *    (Control: pin_required is varied — 35 false, 2 true — so the query was live, not empty.)
 *
 * WHAT IS DELIBERATELY NOT CHANGED: `GET /api/tabs/active` still reports `pin_required` straight
 * from the flag. A customer at a misconfigured tab is therefore shown a PIN prompt and then
 * refused, which is not ideal copy but IS honest — and changing what the customer is told about a
 * tab is a copy decision, not a code one.
 */
export type TabPinPolicy =
  /** No PIN is required. Join freely. */
  | { mode: 'none' }
  /** A PIN is required and exists. `pin` is the value to compare against. */
  | { mode: 'required'; pin: string }
  /**
   * The flag is set but no PIN exists. REFUSE — never treat this as 'none'.
   * Only staff can resolve it, by setting a PIN or clearing the flag.
   */
  | { mode: 'misconfigured' }

/**
 * Resolves the policy for one tab. The ONLY place this decision is made.
 *
 * `pin_required !== false` is deliberate rather than `=== true`: the column is nullable and a NULL
 * has always meant "required" at every existing call site. Changing that default is a separate
 * question and would alter behaviour for tabs nobody has looked at.
 */
export function resolveTabPinPolicy(tab: {
  pin_required?: unknown
  tab_pin?: unknown
}): TabPinPolicy {
  const flagSet = tab.pin_required !== false
  if (!flagSet) return { mode: 'none' }
  const pin = String(tab.tab_pin ?? '').trim()
  if (!pin) return { mode: 'misconfigured' }
  return { mode: 'required', pin }
}

/**
 * True only when there is a real PIN to disclose to an already-authorised token holder.
 *
 * Separated from enforcement on purpose. `GET /api/tabs/[tabId]` uses the predicate to decide
 * whether to RETURN the PIN, and a misconfigured tab must disclose nothing — inlining the
 * enforcement predicate there would try to disclose the string "null".
 */
export function tabPinIsDisclosable(policy: TabPinPolicy): policy is { mode: 'required'; pin: string } {
  return policy.mode === 'required'
}
