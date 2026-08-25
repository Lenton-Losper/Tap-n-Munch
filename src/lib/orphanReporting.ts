/**
 * #344 (expanded scope) — reporting a held orphan to the server, so the hold has a consumer.
 *
 * "A HOLD WITH NO CONSUMER IS THE SLOWER DISCARD." Nothing on the device reads a held record
 * except the notice that displays it, and the native store it came from is destructive, so a
 * payment that is only held is a payment nobody will ever reconcile. This is the leg that turns
 * holding into resolving.
 *
 * THE SHAPE, and it is deliberately not a new server endpoint for case 2. The orphan names an
 * order; that order already has a `paycloud_merchant_order_no` persisted by prepare-payment before
 * the reader was launched. So `POST /api/terminal/orders/{thatOrderId}/verify-payment` resolves it
 * through the path that already works: the server queries Finatic on the order's OWN merchant order
 * number and settles through `markOrderPaidConfirmed`, which re-checks payment_status so a
 * concurrent claim cannot double-apply.
 *
 * THE SERVER DOES NOT HAVE TO TRUST THE DEVICE'S VOUCHER. That is the property that makes this the
 * right endpoint rather than a "here is a payment, please record it" write: the device is only
 * asking the server to go and look at an order it already knows about. A device that reported a
 * voucher it invented would achieve nothing.
 *
 * WHAT COUNTS AS AN ACKNOWLEDGEMENT — the rule this module exists to state precisely.
 * ONLY `ok && paid`. That is the one answer meaning the order is now settled, so the held record
 * has been consumed by something durable and may be released. Every other answer leaves the order
 * exactly as unresolved as before:
 *
 *   ok:false            the server could not be reached or errored. Says nothing.
 *   paid:false          Finatic has no record (E04111) or the order has no merchant order number.
 *                       NOT "not paid" — it is #327's `left_pending_finatic_uncertain` state, and
 *                       the standing ruling is that not knowing never authorises the favourable
 *                       action. Releasing here would discard a real card transaction.
 *
 * So a report that does not resolve leaves the record held and is retried. Holding forever is an
 * acceptable outcome; dropping is not.
 *
 * Kept free of React Native native modules so it is unit-testable in plain Node.
 */
import type {VerifyTerminalPaymentResult} from './api';
import type {HeldOrphanPayment} from './storage';

export type OrphanReportOutcome =
  /** The named order is settled. The held record has been consumed and may be released. */
  | 'resolved'
  /** Reported, but the order is still unresolved. Keep holding, retry later. */
  | 'still_unresolved'
  /** Could not report at all — no order to name. Keep holding. See reportableHeldOrphans. */
  | 'not_reportable';

/**
 * Can this held record be reported at all?
 *
 * CASE 3 CANNOT BE. A `verify-payment` call is addressed to an order id, and a case-3 orphan names
 * none — there is nothing to put in the URL. Reporting it needs a destination that does not exist
 * today (see the handoff: there is no table for a payment with no order). Until there is one, these
 * records are held and displayed and nothing more, which is why they are separated here rather than
 * being quietly attempted and failing.
 */
export function isReportableHeldOrphan(row: HeldOrphanPayment): boolean {
  return row.orphanOrderId.trim().length > 0;
}

/**
 * Classify one verify-payment answer for one held record.
 *
 * `result` is null when the call threw — a transport failure, which is indistinguishable from the
 * server never having heard, and therefore never an acknowledgement.
 */
export function classifyOrphanReport(
  row: HeldOrphanPayment,
  result: VerifyTerminalPaymentResult | null,
): OrphanReportOutcome {
  if (!isReportableHeldOrphan(row)) {
    return 'not_reportable';
  }
  if (!result) {
    return 'still_unresolved';
  }
  // The single acknowledgement. Both halves are required: `ok` alone means the request completed,
  // not that anything was settled.
  return result.ok && result.paid ? 'resolved' : 'still_unresolved';
}

/**
 * Which records to keep after a reporting pass.
 *
 * Written as a pure function over (records, outcomes) so the release rule can be tested without a
 * network or a store. ONLY 'resolved' is dropped — everything else is kept, including outcomes this
 * client does not recognise, because the failure that matters is releasing a record too early.
 */
export function retainAfterReport(
  rows: HeldOrphanPayment[],
  outcomes: OrphanReportOutcome[],
): HeldOrphanPayment[] {
  return rows.filter((_, i) => outcomes[i] !== 'resolved');
}

/**
 * Run one reporting pass over every held record, and write back what is still unresolved.
 *
 * DEPENDENCIES ARE INJECTED so the pass is testable without a network or a real store, and so this
 * module stays free of native imports.
 *
 * NEVER THROWS. A reporting pass runs opportunistically, alongside a payment the operator is
 * actually taking; failing loudly here would turn a bookkeeping retry into a visible error on an
 * unrelated sale. A failed pass simply leaves everything held for the next one.
 *
 * ONE ORDER AT A TIME, deliberately sequential. Each call can settle an order through
 * markOrderPaidConfirmed, and firing them concurrently makes the log of what happened harder to
 * read for no gain — there is at most a handful of these, ever.
 */
export async function runOrphanReportPass(deps: {
  getHeld: () => Promise<HeldOrphanPayment[]>;
  setHeld: (rows: HeldOrphanPayment[]) => Promise<void>;
  verify: (orderId: string) => Promise<VerifyTerminalPaymentResult>;
  onOutcome?: (row: HeldOrphanPayment, outcome: OrphanReportOutcome) => void;
}): Promise<{reported: number; resolved: number}> {
  let rows: HeldOrphanPayment[] = [];
  try {
    rows = await deps.getHeld();
  } catch {
    return {reported: 0, resolved: 0};
  }
  if (rows.length === 0) {
    return {reported: 0, resolved: 0};
  }

  const outcomes: OrphanReportOutcome[] = [];
  let reported = 0;

  for (const row of rows) {
    if (!isReportableHeldOrphan(row)) {
      outcomes.push('not_reportable');
      deps.onOutcome?.(row, 'not_reportable');
      continue;
    }
    let result: VerifyTerminalPaymentResult | null = null;
    try {
      result = await deps.verify(row.orphanOrderId);
      reported += 1;
    } catch {
      // Transport failure. Indistinguishable from the server never having heard, so it is not an
      // acknowledgement and the record stays.
      result = null;
    }
    const outcome = classifyOrphanReport(row, result);
    outcomes.push(outcome);
    deps.onOutcome?.(row, outcome);
  }

  const keep = retainAfterReport(rows, outcomes);
  if (keep.length !== rows.length) {
    try {
      await deps.setHeld(keep);
    } catch {
      // Failing to shorten the list only means a resolved record is reported again next pass.
      // verify-payment is idempotent, so a repeat costs nothing.
    }
  }

  return {
    reported,
    resolved: outcomes.filter(o => o === 'resolved').length,
  };
}
