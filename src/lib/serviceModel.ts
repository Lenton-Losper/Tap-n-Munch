/**
 * Which ordering flow this venue uses, resolved from `GET /api/terminal/me`.
 *
 * Source of truth: `restaurants.is_counter_service`, surfaced on /terminal/me as `isCounterService`
 * and read at REQUEST TIME rather than carried in the terminal JWT. That placement is deliberate:
 * the access token lives an hour, so a venue that switched model would keep the old flow for up to
 * an hour if the flag rode in the claims. Polling /me picks the change up on the next refresh.
 *
 * THE FAIL-SAFE DIRECTION IS "LEAVE THE APP ALONE".
 *
 * The two failure directions are not symmetrical, and this is the whole reason the resolver exists
 * as a named function instead of an inline `!info.isCounterService`:
 *
 *   absent field read as TABLE SERVICE -> every terminal on an older deploy, and every terminal
 *                                         whose /me call was served from a cache, silently loses
 *                                         the Sale tab it has had since June. Staff arrive to a
 *                                         till that cannot ring up a sale.
 *   absent field read as UNKNOWN       -> the device keeps behaving exactly as today's build does.
 *                                         Nothing is lost; the new flow simply has not switched on
 *                                         yet, and the next successful poll switches it on.
 *
 * So ONLY an explicit `isCounterService === false` selects table service. `true`, `undefined`, a
 * missing field, a non-boolean, or a failed /me call all mean UNKNOWN, and UNKNOWN is rendered
 * identically to counter service. Never infer table service from the absence of anything.
 *
 * Note that this is the OPPOSITE default from hasTerminalPermission, which treats an unreadable
 * permission list as "allowed". That is not an inconsistency: there, showing a control the server
 * will refuse is recoverable and self-reporting; here, hiding the Sale tab is not recoverable by
 * the person holding the device.
 */
export type ServiceModel = 'counter' | 'table' | 'unknown';

export interface ServiceModelSource {
  /** The field /api/terminal/me sends. */
  isCounterService?: boolean;
  /** Snake-case spelling, accepted because every other flag on this route has both. */
  is_counter_service?: boolean;
}

export function resolveServiceModel(
  info: ServiceModelSource | null | undefined,
): ServiceModel {
  const raw = info?.isCounterService ?? info?.is_counter_service;
  if (raw === true) {
    return 'counter';
  }
  if (raw === false) {
    return 'table';
  }
  return 'unknown';
}

/**
 * Does the waiter-led service flow replace the Sale tab on this device?
 *
 * TRUE ONLY FOR AN EXPLICIT table-service answer. Both 'counter' and 'unknown' leave the app in
 * the shape it ships in today — Tables, Orders, Sale.
 */
export function usesWaiterLedService(model: ServiceModel): boolean {
  return model === 'table';
}

/**
 * Is the counter-service Sale tab shown?
 *
 * The exact complement of the above, written out rather than negated at each call site so the two
 * questions a navigator asks — "which Tables screen" and "is there a Sale tab" — can never drift
 * into disagreeing about the same venue.
 */
export function showsCounterSaleTab(model: ServiceModel): boolean {
  return !usesWaiterLedService(model);
}
