/**
 * #344 RULING 3 — WHAT ACKNOWLEDGING A HELD PAYMENT REQUIRES.
 *
 * The question this module answers was left open in vc96 and is now ruled. "I have checked this
 * payment" deleted the only remaining record of a card transaction on this device and told nobody.
 * `PaymentModule.consumeOrphanedPaymentResult` is destructive, so once JS holds a record it exists
 * in exactly one place; the button emptied that place.
 *
 * THE RULING, IN THE OWNER'S WORDS, ALL FOUR ANSWERS:
 *
 *   1. A DURABLE WRITE IS THE ACKNOWLEDGEMENT. Stored means released. Reconciliation is a separate
 *      concern and the device never waits on it.
 *   2. THE IDEMPOTENCY KEY IS businessOrderNo + heldAt.
 *   3. A 409 ON AN ALREADY-STORED RECORD IS AN ACKNOWLEDGEMENT. Release.
 *   4. THE RESPONSE IS `stored` AND `receiptId`, NOTHING ELSE. No matchedOrderId, no reconciliation
 *      field — "a field the device must ignore is a field someone will eventually read."
 *
 * WHY THIS IS THE RIGHT BAR AND RECONCILIATION IS NOT. `runOrphanReportPass` releases a record only
 * when the named order settles, which a case-3 record — one naming NO order — can never do. Under
 * that rule a case-3 record is held forever and the operator has no honest way to clear it, so the
 * button either lied or the record accumulated. Ruling 1 replaces "has it been reconciled" with
 * "does it exist somewhere other than this device", which is a question the device can actually
 * answer, and which is the property that made deleting it dangerous in the first place.
 *
 * THE TWO KEYS ARE DIFFERENT AND MUST NOT BE MERGED. `heldOrphanIdentity` (storage.ts) is four
 * fields and addresses a row in the LOCAL list. The ruling's key is two fields and addresses a row
 * on the SERVER. They answer different questions — "which of these list entries did the operator
 * press" versus "is this the same transaction we already wrote" — and collapsing them would silently
 * change one of the two.
 *
 * WHICH DIRECTION THE KEY ERRS, stated because it is a deliberate asymmetry. Re-holding the same
 * transaction produces a new `heldAt`, so it takes a new key and is stored twice. A duplicate row is
 * a bookkeeping annoyance; a released-but-never-stored record is a lost card transaction. The key is
 * chosen to fail toward the annoyance.
 *
 * Kept free of React Native native modules so it is unit-testable in plain Node.
 */
import type {HeldOrphanPayment} from './storage';

/**
 * The server's answer. TWO FIELDS, AND THE TYPE IS THE ENFORCEMENT — ruling 4.
 *
 * The owner ruled out `matchedOrderId` and every other reconciliation field explicitly: a field the
 * device must ignore is a field someone will eventually read, and reading it would rebuild the
 * coupling ruling 1 just removed. Declaring only these two means a server that starts sending more
 * cannot be consumed here without someone editing this type on purpose.
 */
export type HeldOrphanStoreResponse = {
  /** Did the server durably write this record? This, and only this, is the acknowledgement. */
  stored: boolean;
  /** The server's handle on the stored record, for a human to quote. Displayed, never branched on. */
  receiptId: string;
};

/** What one attempt at storing a held record concluded. */
export type StoreAndReleaseOutcome =
  /** Durably written (or already was). The local record has been removed. */
  | 'released'
  /** Not written, for any reason. The local record is untouched and stays visible. */
  | 'kept';

/**
 * RULING 2 — the idempotency key.
 *
 * businessOrderNo identifies the transaction at the gateway; heldAt distinguishes two holds of the
 * same transaction. `businessOrderNo` is optional on the type, so an absent one contributes an empty
 * segment rather than throwing: a record we cannot key well is still a record that must be stored,
 * and refusing to send it is the discard this whole ruling exists to prevent.
 *
 * LENGTH-PREFIXED, NOT MERELY DELIMITED, AND A TEST IS WHY. A bare `a|b` join collides:
 * ('A', 'B|C') and ('A|B', 'C') both render 'A|B|C'. A collision here is not cosmetic — two
 * distinct transactions would share a key, the second would be answered 409, and ruling 3 would
 * release it as "already stored" when nothing of it had been stored. That is the one outcome this
 * module exists to make impossible, and it would have been reached through the key rather than
 * through the classifier, which is where nobody would have looked.
 *
 * `businessOrderNo` comes from the gateway and its charset is not ours to assume, so the join does
 * not depend on it. The prefix says where the first field ends, which makes the encoding injective
 * whatever either field contains. It is still exactly the two fields ruling 2 named.
 */
export function heldOrphanIdempotencyKey(row: HeldOrphanPayment): string {
  const businessOrderNo = (row.businessOrderNo ?? '').trim();
  return `${businessOrderNo.length}|${businessOrderNo}|${row.heldAt}`;
}

/**
 * The request body. Everything the device knows about the transaction, so the server has the
 * evidence to reconcile it later WITHOUT the device being told the outcome (ruling 1).
 */
export type HeldOrphanStoreRequest = {
  idempotencyKey: string;
  businessOrderNo: string | null;
  voucherNo: string | null;
  heldAt: string;
  orphanOrderId: string | null;
  seenWhileChargingOrderId: string | null;
  reason: HeldOrphanPayment['reason'];
  outcomeKind: string | null;
};

const orNull = (v: string | undefined | null): string | null => {
  const t = (v ?? '').trim();
  return t.length > 0 ? t : null;
};

export function heldOrphanStoreRequest(
  row: HeldOrphanPayment,
): HeldOrphanStoreRequest {
  return {
    idempotencyKey: heldOrphanIdempotencyKey(row),
    businessOrderNo: orNull(row.businessOrderNo),
    voucherNo: orNull(row.voucherNo),
    heldAt: row.heldAt,
    orphanOrderId: orNull(row.orphanOrderId),
    seenWhileChargingOrderId: orNull(row.seenWhileChargingOrderId),
    reason: row.reason,
    outcomeKind: orNull(row.outcomeKind),
  };
}

/**
 * Decide whether one HTTP answer released the record.
 *
 * WRITTEN AS A PURE FUNCTION OVER (status, body) so the release rule can be read, and tested,
 * without a network. This is the rule that decides whether a card transaction stops existing on
 * this device, so it is one expression in one place rather than conditions scattered through a
 * component.
 *
 * RELEASES ON EXACTLY TWO ANSWERS:
 *   - 2xx carrying `stored: true` — ruling 1, the durable write.
 *   - 409 — ruling 3, the record is already there. The write happened on an earlier attempt whose
 *     response we lost; the state the ruling cares about is identical.
 *
 * AND KEEPS ON EVERYTHING ELSE, INCLUDING 2xx WITH `stored` NOT TRUE. That case is the server
 * saying, in so many words, that it did not write. Treating it as an acknowledgement because the
 * HTTP call succeeded is the same defect as reading E04111 as "not paid": the request completing
 * and the fact being recorded are different facts. `status: 0` is the transport-failure sentinel
 * and is likewise never an acknowledgement — a request that never arrived says nothing at all.
 */
export function classifyHeldOrphanStore(
  status: number,
  body: HeldOrphanStoreResponse | null,
): StoreAndReleaseOutcome {
  if (status === 409) {
    return 'released';
  }
  if (status >= 200 && status < 300 && body?.stored === true) {
    return 'released';
  }
  return 'kept';
}

/**
 * Store one held record and, only if that was durable, release it locally.
 *
 * DEPENDENCIES ARE INJECTED so the path is testable without a network or a real store, and so this
 * module stays free of native imports.
 *
 * NEVER THROWS. This runs from a button on a screen where a payment may be in progress; a thrown
 * error here would surface as a failure of that unrelated sale. A failure is reported by returning
 * 'kept', which is also the safe direction — the record stays visible and can be tried again.
 *
 * THE LOCAL REMOVE IS DELIBERATELY AFTER THE WRITE AND NEVER BEFORE IT. Removing first and storing
 * second would lose the record on any failure between the two, which is precisely the window this
 * ruling closes.
 *
 * A FAILED LOCAL REMOVE STILL COUNTS AS RELEASED. The server holds it now, which is what the ruling
 * asked for; a record that lingers on screen is a nuisance, and the next acknowledge takes the 409
 * path and clears it. Reporting 'kept' here would tell the operator the payment was not stored,
 * which would be false.
 */
export async function storeAndReleaseHeldOrphan(
  row: HeldOrphanPayment,
  deps: {
    store: (
      body: HeldOrphanStoreRequest,
    ) => Promise<{status: number; body: HeldOrphanStoreResponse | null}>;
    release: (row: HeldOrphanPayment) => Promise<void>;
    onOutcome?: (
      row: HeldOrphanPayment,
      outcome: StoreAndReleaseOutcome,
      status: number,
    ) => void;
  },
): Promise<{outcome: StoreAndReleaseOutcome; receiptId: string | null}> {
  let status = 0;
  let body: HeldOrphanStoreResponse | null = null;

  try {
    const answer = await deps.store(heldOrphanStoreRequest(row));
    status = answer.status;
    body = answer.body;
  } catch {
    // Transport failure, or an auth error thrown by the api layer. Indistinguishable from the
    // server never having heard, so it is not an acknowledgement.
    status = 0;
    body = null;
  }

  const outcome = classifyHeldOrphanStore(status, body);
  deps.onOutcome?.(row, outcome, status);

  if (outcome === 'released') {
    try {
      await deps.release(row);
    } catch {
      // See the note above: the durable write already happened, so this stays 'released'.
    }
  }

  return {
    outcome,
    receiptId: outcome === 'released' ? body?.receiptId ?? null : null,
  };
}
