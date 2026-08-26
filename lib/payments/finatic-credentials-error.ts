/**
 * #153 — the discriminator that separates "we could not reach Finatic" from "there is nothing
 * to reach Finatic WITH".
 *
 * WHY IT IS A SEPARATE MODULE from finatic-restaurant-credentials.ts, which is where the throw
 * lives and where you would expect to find this.
 *
 * Eighteen test files call `jest.mock('@/lib/payments/finatic-restaurant-credentials', ...)` with
 * a factory that returns ONLY `getRestaurantFinaticCredentials`. A factory mock replaces the whole
 * module, so any predicate exported from there reads as `undefined` inside those suites, and the
 * catch blocks that call it throw a TypeError instead of classifying. The classification would
 * then be untestable in exactly the suites that exercise the paths it guards. Putting the
 * predicate in its own module — which nothing mocks — makes the discrimination survive the mocks,
 * and it is why the two call sites import it from here rather than from the throwing module.
 *
 * THE MESSAGE IS PART OF THE CONTRACT. It is unchanged from before this file existed, byte for
 * byte, because it is already written into production audit rows (Digi Cofee order #28,
 * 2026-08-26, five `payment.verification_uncertain` rows carrying it verbatim) and into the
 * hand-written cancellation_reason on order #19. Changing the string would orphan that history.
 */

/** The exact message thrown when a restaurant has no usable Finatic merchant/store pair. */
export const MISSING_FINATIC_CREDENTIALS_MESSAGE =
  'No Finatic credentials configured for restaurant'

/**
 * Thrown by getRestaurantFinaticCredentials when the restaurant row carries no merchant/store
 * pair. Subclasses Error and keeps the message identical, so every existing
 * `catch (e) { e instanceof Error ? e.message : ... }` handler behaves exactly as it did.
 */
export class MissingFinaticCredentialsError extends Error {
  readonly restaurantId: string

  constructor(restaurantId: string) {
    super(MISSING_FINATIC_CREDENTIALS_MESSAGE)
    this.name = 'MissingFinaticCredentialsError'
    this.restaurantId = restaurantId
  }
}

/**
 * True when an error means the venue has no Finatic credentials — a PERMANENT condition that
 * nothing external will resolve — as opposed to the gateway being unreachable or erroring, which
 * are transient and are correctly retried.
 *
 * The message fallback is not belt-and-braces padding: `instanceof` is identity-checked against
 * one module instance, and the Cloudflare bundle, jest's module registry and a `jest.mock` factory
 * do not always agree on which instance that is. A missed classification here would silently
 * restore the forever-retry, so both are checked.
 */
export function isMissingFinaticCredentialsError(err: unknown): boolean {
  if (err instanceof MissingFinaticCredentialsError) return true
  return err instanceof Error && err.message === MISSING_FINATIC_CREDENTIALS_MESSAGE
}
