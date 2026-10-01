/**
 * PAYMENT TIMELINE MARKS (perf/latency-sprint, 2026-10-01).
 *
 * A P5 showed WiseCashier's own screen still up, its timer counting (~32 s), after the customer had
 * paid -- so "how long does a card payment take" is several intervals, only some of them ours:
 *
 *   T0  FlashTap starts the payment ................. t0_start          (JS)
 *       prepare-payment answered .................... prepare_done      (JS)
 *   T1  WiseCashier intent about to launch .......... launch_requested  (JS) + native
 *                                                     launchPayment.dispatch (wiretap)
 *   T2  WiseCashier's screen appears  \
 *   T3  card presented                 >  NOT OBSERVABLE: inside WiseCashier. Its only contract is
 *   T4  WiseCashier decides the result/    setResult + finish() (docs/wisecashier-result-codes.md);
 *                                          there is no intermediate callback to listen to.
 *   T5  control returns to FlashTap ................. native onActivityResult (wiretap), then
 *                                                     result_in_js when the promise settles in JS
 *   T6  server's authoritative answer ............... report_done       (JS, POST .../payment)
 *   T7  the screen shows the outcome ................ ui_state          (JS)
 *
 * T1 -> T5 is therefore EXTERNAL (WiseCashier/Finatic) time, measured from outside as a whole.
 *
 * Every mark goes into the existing on-device wiretap (read on Diagnostics) as one event,
 * `payment.timeline`, with `mark` and `jsAt` (this device's clock, ms). Recording is fire-and-forget
 * and never throws (see wiretap.ts): nothing here awaits, delays, polls or changes an outcome.
 * Only correlation ids and outcome classes are recorded -- never card data, tokens or amounts.
 */
import {recordWiretapEvent} from './wiretap';

export type PaymentTimelineMark =
  | 't0_start'
  | 'prepare_done'
  | 'launch_requested'
  | 'result_in_js'
  | 'report_done'
  | 'ui_state';

export const PAYMENT_TIMELINE_EVENT = 'payment.timeline';

export function markPaymentTimeline(
  mark: PaymentTimelineMark,
  detail: Record<string, string | number | boolean | null | undefined> = {},
): void {
  recordWiretapEvent(PAYMENT_TIMELINE_EVENT, {mark, jsAt: Date.now(), ...detail});
}
