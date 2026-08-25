/**
 * #344 (expanded scope) — the held record must reach a consumer, and must only be released once it
 * has.
 *
 * "A HOLD WITH NO CONSUMER IS THE SLOWER DISCARD." The release rule is the whole risk here: release
 * too eagerly and a real card transaction is dropped exactly as if it had never been held, and the
 * defect this issue exists to fix is re-created one layer along. So most of these assertions are
 * about what does NOT count as an acknowledgement.
 */
import {
  classifyOrphanReport,
  isReportableHeldOrphan,
  retainAfterReport,
  runOrphanReportPass,
} from '../orphanReporting';
import type {HeldOrphanPayment} from '../storage';

const A = '11111111-1111-4111-8111-111111111111';

function held(over: Partial<HeldOrphanPayment> = {}): HeldOrphanPayment {
  return {
    orphanOrderId: A,
    seenWhileChargingOrderId: 'other',
    reason: 'different_order',
    voucherNo: 'V-1',
    heldAt: '2026-08-25T10:00:00.000Z',
    ...over,
  };
}

describe('only ok AND paid is an acknowledgement', () => {
  it('resolves on ok:true paid:true', () => {
    expect(classifyOrphanReport(held(), {ok: true, paid: true})).toBe(
      'resolved',
    );
  });

  it('does NOT resolve on ok:true paid:false', () => {
    // Finatic has no record (E04111), or the order has no merchant order number. That is #327's
    // "cannot say" state, not "not paid" — releasing here discards a real transaction.
    expect(classifyOrphanReport(held(), {ok: true, paid: false})).toBe(
      'still_unresolved',
    );
  });

  it('does NOT resolve on ok:false, whatever paid says', () => {
    // A server error that still carried paid:true would be the worst possible release trigger.
    expect(classifyOrphanReport(held(), {ok: false, paid: true})).toBe(
      'still_unresolved',
    );
    expect(classifyOrphanReport(held(), {ok: false, paid: false})).toBe(
      'still_unresolved',
    );
  });

  it('does NOT resolve when the call threw', () => {
    // Transport failure is indistinguishable from the server never having heard.
    expect(classifyOrphanReport(held(), null)).toBe('still_unresolved');
  });
});

describe('case 3 cannot be reported at all', () => {
  it('is not reportable with no order id', () => {
    expect(isReportableHeldOrphan(held({orphanOrderId: ''}))).toBe(false);
    expect(isReportableHeldOrphan(held({orphanOrderId: '   '}))).toBe(false);
  });

  it('is reportable with one', () => {
    expect(isReportableHeldOrphan(held())).toBe(true);
  });

  it('classifies as not_reportable rather than being silently attempted', () => {
    expect(
      classifyOrphanReport(held({orphanOrderId: ''}), {ok: true, paid: true}),
    ).toBe('not_reportable');
  });
});

describe('retainAfterReport releases only what was acknowledged', () => {
  it('drops resolved and keeps everything else', () => {
    const rows = [held({voucherNo: 'V-1'}), held({voucherNo: 'V-2'}), held({voucherNo: 'V-3'})];
    const kept = retainAfterReport(rows, [
      'resolved',
      'still_unresolved',
      'not_reportable',
    ]);
    expect(kept.map(r => r.voucherNo)).toEqual(['V-2', 'V-3']);
  });

  it('keeps everything when nothing resolved', () => {
    const rows = [held(), held()];
    expect(
      retainAfterReport(rows, ['still_unresolved', 'still_unresolved']),
    ).toHaveLength(2);
  });
});

describe('runOrphanReportPass', () => {
  it('reports a held record against the order IT names, not the one on screen', () => {
    // The whole point of the leg: order A's payment resolves through order A.
    const seen: string[] = [];
    return runOrphanReportPass({
      getHeld: async () => [held({orphanOrderId: A, seenWhileChargingOrderId: 'B'})],
      setHeld: async () => {},
      verify: async orderId => {
        seen.push(orderId);
        return {ok: true, paid: true};
      },
    }).then(() => {
      expect(seen).toEqual([A]);
    });
  });

  it('writes back the shortened list when one resolves', async () => {
    let written: HeldOrphanPayment[] | null = null;
    const rows = [
      held({orphanOrderId: A, voucherNo: 'V-resolved'}),
      held({orphanOrderId: '', voucherNo: 'V-case3'}),
    ];
    const out = await runOrphanReportPass({
      getHeld: async () => rows,
      setHeld: async next => {
        written = next;
      },
      verify: async () => ({ok: true, paid: true}),
    });
    expect(out).toEqual({reported: 1, resolved: 1});
    expect(written!.map(r => r.voucherNo)).toEqual(['V-case3']);
  });

  it('does NOT write back when nothing resolved', async () => {
    let wrote = false;
    await runOrphanReportPass({
      getHeld: async () => [held()],
      setHeld: async () => {
        wrote = true;
      },
      verify: async () => ({ok: true, paid: false}),
    });
    expect(wrote).toBe(false);
  });

  it('never throws when the verify call rejects, and keeps the record', async () => {
    let written: HeldOrphanPayment[] | null = null;
    const out = await runOrphanReportPass({
      getHeld: async () => [held()],
      setHeld: async next => {
        written = next;
      },
      verify: async () => {
        throw new Error('network down');
      },
    });
    // A bookkeeping retry must never surface as an error on the unrelated sale in progress.
    expect(out).toEqual({reported: 0, resolved: 0});
    expect(written).toBeNull();
  });

  it('never calls verify for a case-3 record', async () => {
    // There is no order id to put in the URL; attempting it would be a request that cannot succeed.
    let calls = 0;
    await runOrphanReportPass({
      getHeld: async () => [held({orphanOrderId: ''})],
      setHeld: async () => {},
      verify: async () => {
        calls += 1;
        return {ok: true, paid: true};
      },
    });
    expect(calls).toBe(0);
  });

  it('survives the store failing to read', async () => {
    const out = await runOrphanReportPass({
      getHeld: async () => {
        throw new Error('storage unavailable');
      },
      setHeld: async () => {},
      verify: async () => ({ok: true, paid: true}),
    });
    expect(out).toEqual({reported: 0, resolved: 0});
  });
});
