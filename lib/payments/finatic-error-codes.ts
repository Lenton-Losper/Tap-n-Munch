/**
 * Finatic / PayCloud gateway business error codes.
 *
 * `queryPaymentOrder` (payments/paycloud.js) throws a `PaycloudRequestError` with
 * `phase: 'business'` whenever the gateway answers HTTP 200 with a non-success
 * `body.code`. The code is carried structurally on `err.responseBody.code`, but
 * until now every caller string-matched `err.message` instead -- which is why
 * E04111, the single most operationally significant code we see, was swallowed
 * identically to a network timeout in three separate places.
 */

/** Finatic has no record of the merchant_order_no. Time-dependent -- see isE04111. */
export const FINATIC_ORDER_NOT_REGISTERED = 'E04111'

/** Structural gateway code from a thrown PaycloudRequestError, or null. */
export function finaticErrorCode(err: unknown): string | null {
  if (!err || typeof err !== 'object') return null
  const body = (err as { responseBody?: unknown }).responseBody
  if (body && typeof body === 'object' && !Array.isArray(body)) {
    const code = (body as { code?: unknown }).code
    if (typeof code === 'string' && code.trim()) return code.trim().toUpperCase()
    if (typeof code === 'number' && Number.isFinite(code)) return String(code)
  }
  return null
}

/**
 * True when Finatic reports it has no record of this merchant_order_no.
 *
 * IMPORTANT: this is NOT proof that no payment exists. E04111 is time-dependent --
 * order #149 returned E04111 at 13:58:48 and was confirmed PAID on the same
 * reference 22 seconds later (docs/finatic-questions-for-vernon.md). It means
 * "not registered at the gateway *yet*". A single E04111 is never a terminal answer;
 * only persistence across many observations, with a live control probe, is evidence.
 *
 * Prefers the structural `responseBody.code`; falls back to the message because the
 * staging stub and several ops scripts construct the error by hand.
 */
export function isE04111(err: unknown): boolean {
  if (finaticErrorCode(err) === FINATIC_ORDER_NOT_REGISTERED) return true
  const message = err instanceof Error ? err.message : typeof err === 'string' ? err : ''
  return /\bE04111\b/i.test(message)
}
