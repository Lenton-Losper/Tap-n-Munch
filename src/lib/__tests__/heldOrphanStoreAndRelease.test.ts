/**
 * #344 RULING 3 — the rule that decides whether a card transaction stops existing on this device.
 *
 * THE TEST THAT MATTERS is 'a 200 saying stored:false does not release'. Every other case here
 * exists so that one cannot be satisfied trivially: a classifier that returned 'kept' for
 * everything would also pass it, and would make the button a permanent no-op.
 *
 * The failure this guards against is asymmetric and that asymmetry is the whole design. Keeping a
 * record that was in fact stored costs a duplicate row and a second press. Releasing a record that
 * was not stored destroys the only remaining evidence of a card payment — `consumeOrphanedPaymentResult`
 * is destructive, so there is no third copy anywhere.
 */
import {
  classifyHeldOrphanStore,
  heldOrphanIdempotencyKey,
  heldOrphanStoreRequest,
  storeAndReleaseHeldOrphan,
  type HeldOrphanStoreResponse,
} from '../heldOrphanStore';
import type {HeldOrphanPayment} from '../storage';

const row = (over: Partial<HeldOrphanPayment> = {}): HeldOrphanPayment => ({
  orphanOrderId: 'order-A',
  seenWhileChargingOrderId: 'order-B',
  reason: 'different_order',
  outcomeKind: 'orphaned_success',
  voucherNo: 'V-001',
  businessOrderNo: 'FT1787292588945',
  heldAt: '2026-08-26T09:15:00.123Z',
  ...over,
});

const ok = (stored: boolean, receiptId = 'HP-77'): HeldOrphanStoreResponse => ({
  stored,
  receiptId,
});

describe('ruling 2 — the idempotency key is businessOrderNo + heldAt', () => {
  it('is exactly those two fields', () => {
    expect(heldOrphanIdempotencyKey(row())).toBe(
      '15|FT1787292588945|2026-08-26T09:15:00.123Z',
    );
  });

  it('is NOT the local four-field identity', () => {
    // storage.heldOrphanIdentity addresses a row in the local list; this addresses a row on the
    // server. Merging them would silently change one of the two.
    const key = heldOrphanIdempotencyKey(row());
    expect(key).not.toContain('V-001');
    expect(key).not.toContain('order-A');
  });

  it('two holds of the SAME transaction take different keys', () => {
    // The deliberate asymmetry: re-holding produces a new heldAt, so it is stored twice. A
    // duplicate row is an annoyance; a released-but-unstored record is a lost transaction.
    const a = heldOrphanIdempotencyKey(row({heldAt: '2026-08-26T09:15:00.123Z'}));
    const b = heldOrphanIdempotencyKey(row({heldAt: '2026-08-26T09:19:44.900Z'}));
    expect(a).not.toBe(b);
  });

  it('survives a record with no businessOrderNo rather than throwing', () => {
    // A record we cannot key well is still a record that must be stored. Refusing to send it is
    // the discard this ruling exists to prevent.
    expect(heldOrphanIdempotencyKey(row({businessOrderNo: undefined}))).toBe(
      '0||2026-08-26T09:15:00.123Z',
    );
  });

  it('cannot be collided into by a field containing the separator', () => {
    // THIS TEST FOUND A REAL DEFECT rather than confirming a design. The first implementation
    // joined the two fields with a bare '|', and both of these rendered 'A|B|C' -- one key for two
    // transactions. The second would then be answered 409 and released under ruling 3 as "already
    // stored", having never been stored. The length prefix is what makes the join injective.
    const a = heldOrphanIdempotencyKey(
      row({businessOrderNo: 'A', heldAt: 'B|C'}),
    );
    const b = heldOrphanIdempotencyKey(
      row({businessOrderNo: 'A|B', heldAt: 'C'}),
    );
    expect(a).not.toBe(b);
  });
});

describe('ruling 4 — the request carries the evidence, the response carries two fields', () => {
  it('sends every fact the device holds about the transaction', () => {
    const body = heldOrphanStoreRequest(row());
    expect(body).toEqual({
      idempotencyKey: '15|FT1787292588945|2026-08-26T09:15:00.123Z',
      businessOrderNo: 'FT1787292588945',
      voucherNo: 'V-001',
      heldAt: '2026-08-26T09:15:00.123Z',
      orphanOrderId: 'order-A',
      seenWhileChargingOrderId: 'order-B',
      reason: 'different_order',
      outcomeKind: 'orphaned_success',
    });
  });

  it('normalises blank and missing fields to null, not to empty strings', () => {
    const body = heldOrphanStoreRequest(
      row({voucherNo: '   ', orphanOrderId: '', outcomeKind: undefined}),
    );
    expect(body.voucherNo).toBeNull();
    expect(body.orphanOrderId).toBeNull();
    expect(body.outcomeKind).toBeNull();
  });

  it('a case-3 record — no order at all — is still a complete request', () => {
    // This is the record verify-payment can never resolve, and the reason ruling 1 replaced
    // reconciliation with a durable write.
    const body = heldOrphanStoreRequest(
      row({orphanOrderId: '', reason: 'unknown_order'}),
    );
    expect(body.orphanOrderId).toBeNull();
    expect(body.reason).toBe('unknown_order');
    expect(body.idempotencyKey).toBe(
      '15|FT1787292588945|2026-08-26T09:15:00.123Z',
    );
  });
});

describe('the release rule — what counts as an acknowledgement', () => {
  it('200 with stored:true RELEASES — ruling 1, the durable write', () => {
    expect(classifyHeldOrphanStore(200, ok(true))).toBe('released');
    expect(classifyHeldOrphanStore(201, ok(true))).toBe('released');
  });

  it('409 RELEASES — ruling 3, it is already stored', () => {
    expect(classifyHeldOrphanStore(409, null)).toBe('released');
    expect(classifyHeldOrphanStore(409, ok(false))).toBe('released');
  });

  it('a 200 saying stored:false does NOT release', () => {
    // The server said, in so many words, that it did not write. Treating that as an
    // acknowledgement because the HTTP call succeeded is the same defect as reading E04111 as
    // "not paid": the request completing and the fact being recorded are different facts.
    expect(classifyHeldOrphanStore(200, ok(false))).toBe('kept');
  });

  it('a 200 with no parseable body does NOT release', () => {
    expect(classifyHeldOrphanStore(200, null)).toBe('kept');
  });

  it.each([0, 400, 401, 403, 404, 422, 500, 502, 503])(
    'status %s does NOT release',
    status => {
      // 0 is the transport-failure sentinel. 404 matters today: the server route does not exist
      // yet, and until it does every acknowledge must keep its record rather than delete it.
      expect(classifyHeldOrphanStore(status, ok(true))).toBe('kept');
    },
  );
});

describe('storeAndReleaseHeldOrphan — store first, release second, never the reverse', () => {
  it('releases locally only after a durable write', async () => {
    const order: string[] = [];
    const result = await storeAndReleaseHeldOrphan(row(), {
      store: async () => {
        order.push('store');
        return {status: 200, body: ok(true, 'HP-1234')};
      },
      release: async () => {
        order.push('release');
      },
    });
    expect(order).toEqual(['store', 'release']);
    expect(result.outcome).toBe('released');
    expect(result.receiptId).toBe('HP-1234');
  });

  it('does not touch the local record when the store failed', async () => {
    let released = false;
    const result = await storeAndReleaseHeldOrphan(row(), {
      store: async () => ({status: 500, body: null}),
      release: async () => {
        released = true;
      },
    });
    expect(released).toBe(false);
    expect(result.outcome).toBe('kept');
    expect(result.receiptId).toBeNull();
  });

  it('does not touch the local record when the store threw', async () => {
    let released = false;
    const result = await storeAndReleaseHeldOrphan(row(), {
      store: async () => {
        throw new Error('Network request failed');
      },
      release: async () => {
        released = true;
      },
    });
    expect(released).toBe(false);
    expect(result.outcome).toBe('kept');
  });

  it('never throws, whatever the store does', async () => {
    // It runs from a button on a screen where a payment may be in progress. A thrown error here
    // would surface as a failure of that unrelated sale.
    await expect(
      storeAndReleaseHeldOrphan(row(), {
        store: () => Promise.reject(new Error('boom')),
        release: async () => {},
      }),
    ).resolves.toEqual({outcome: 'kept', receiptId: null});
  });

  it('a FAILED LOCAL REMOVE still counts as released', async () => {
    // The server holds it now, which is what the ruling asked for. Reporting 'kept' would tell the
    // operator the payment was not stored, which would be false.
    const result = await storeAndReleaseHeldOrphan(row(), {
      store: async () => ({status: 200, body: ok(true)}),
      release: async () => {
        throw new Error('EncryptedStorage unavailable');
      },
    });
    expect(result.outcome).toBe('released');
  });

  it('reports the outcome and the status to the wiretap', async () => {
    const seen: Array<[string, number]> = [];
    await storeAndReleaseHeldOrphan(row(), {
      store: async () => ({status: 409, body: null}),
      release: async () => {},
      onOutcome: (_r, outcome, status) => seen.push([outcome, status]),
    });
    expect(seen).toEqual([['released', 409]]);
  });

  it('reports status 0 when the call threw, not a fabricated one', async () => {
    const seen: Array<[string, number]> = [];
    await storeAndReleaseHeldOrphan(row(), {
      store: async () => {
        throw new Error('timeout');
      },
      release: async () => {},
      onOutcome: (_r, outcome, status) => seen.push([outcome, status]),
    });
    expect(seen).toEqual([['kept', 0]]);
  });

  it('sends the ruling-2 key on the wire', async () => {
    let sent: unknown = null;
    await storeAndReleaseHeldOrphan(row(), {
      store: async body => {
        sent = body;
        return {status: 200, body: ok(true)};
      },
      release: async () => {},
    });
    expect(sent).toMatchObject({
      idempotencyKey: '15|FT1787292588945|2026-08-26T09:15:00.123Z',
    });
  });

  it('releases the record it was GIVEN, not some other one', async () => {
    // The list is rewritten by the reporting pass underneath the render, so the record that
    // reaches release must be the one the operator pressed.
    const pressed = row({voucherNo: 'V-PRESSED', heldAt: '2026-08-26T10:00:00.000Z'});
    let releasedVoucher: string | undefined;
    await storeAndReleaseHeldOrphan(pressed, {
      store: async () => ({status: 200, body: ok(true)}),
      release: async r => {
        releasedVoucher = r.voucherNo;
      },
    });
    expect(releasedVoucher).toBe('V-PRESSED');
  });
});
