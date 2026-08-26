/**
 * #344 ruling 3 — the acknowledge button's OUTCOME reaches the screen.
 *
 * WHY THIS EXISTS, AND WHY IT IS NOT A DUPLICATE OF heldOrphanCopy.test.ts. That suite pins the
 * WORDING of HELD_ORPHAN_NOT_SAVED with 16 assertions, including owner decision 2's no-override
 * rule. Nothing pinned its WIRING. The constant reached a render at exactly one place —
 * HeldOrphanPaymentNotice.tsx:232 — and deleting that line left all 300 tests passing, because a
 * string can be perfectly guarded and never displayed. That is the #306 shape: a value written and
 * never selected, shipping a fix that does nothing.
 *
 * THE DIVISION OF LABOUR IS DELIBERATE AND MUST BE KEPT. heldOrphanCopy.test.ts owns "what the
 * sentence says". This file owns "the operator SEES it when the store fails" and asserts nothing
 * about the words. That is why every assertion below compares against the IMPORTED constant and
 * never against a hardcoded sentence: when the owner re-words the copy, this suite keeps passing;
 * when the wiring is deleted, it goes red. Overlap between the two would invite someone to delete
 * one believing it duplicated the other.
 *
 * WHY THE FAILURE BRANCH SPECIFICALLY. It is what stops the button being a silent no-op, which is
 * the property ruling 3 exists to create — the operator sends the record for checking, nothing is
 * stored, the record stays, and without this line the only reading available to them is that the
 * terminal is broken. It also fires ONLY when a store fails, so ordinary use on a device will not
 * surface a regression either.
 *
 * The label is deliberately NOT quoted in this file. Every assertion locates the button by the
 * IMPORTED constant, which is why this suite survived HELD_ORPHAN_ACKNOWLEDGE being re-signed on
 * 2026-08-26 without one line changing. Quoting copy in prose is how a comment goes stale.
 *
 * NO NETWORK, ON PURPOSE. The store function is injected by mocking lib/api, the same shape
 * heldOrphanStoreAndRelease.test.ts uses for its deps. lib/heldOrphanStore is deliberately NOT
 * mocked: the real ruling-3 decision (store first, release only on a durable write) runs here, so
 * these tests exercise the component against the genuine rule rather than a restatement of it.
 * POST /api/terminal/held-payments is never called.
 *
 * runOrphanReportPass IS stubbed to a no-op. The focus-time reporting pass is a different mechanism
 * with its own suite (orphanReporting.test.ts, 97% statements); leaving it live here would let it
 * rewrite the list underneath the assertions and make failures ambiguous.
 */
import React from 'react';
import renderer from 'react-test-renderer';

// src/constants throws at module scope when RuntimeConfig.API_BASE_URL is absent, which it is under
// jest — there is no native build here. lib/storage imports it only for the key names.
jest.mock('../../constants', () => ({
  TOKEN_STORAGE_KEY: 'flashtap_terminal_token',
  REFRESH_TOKEN_STORAGE_KEY: 'flashtap_refresh_token',
  RESTAURANT_ID_STORAGE_KEY: 'flashtap_restaurant_id',
  TERMINAL_ID_STORAGE_KEY: 'flashtap_terminal_id',
  RESTAURANT_NAME_STORAGE_KEY: 'flashtap_restaurant_name',
  MERCHANT_NO_STORAGE_KEY: 'flashtap_merchant_no',
  STORE_NO_STORAGE_KEY: 'flashtap_store_no',
  HELD_ORPHAN_PAYMENT_STORAGE_KEY: 'flashtap_held_orphan_payment',
}));
jest.mock('react-native-encrypted-storage', () => ({
  __esModule: true,
  default: {
    getItem: jest.fn(async () => null),
    setItem: jest.fn(async () => undefined),
    removeItem: jest.fn(async () => undefined),
  },
}));
jest.mock('react-native-vector-icons/MaterialCommunityIcons', () => 'Icon');

// The notice reads on focus. Outside a navigator there is no focus event, so the effect is run as
// an ordinary mount effect — the component's own dependency array is preserved.
jest.mock('@react-navigation/native', () => ({
  useFocusEffect: (cb: () => void | (() => void)) => {
    const {useEffect} = require('react');
    useEffect(cb, [cb]);
  },
}));

/** The live store, standing in for EncryptedStorage. Mutated by the acknowledge path below. */
let mockHeldRows: HeldOrphanPayment[] = [];

/** The injected server call. Each test decides what the store answers, or holds it open. */
const mockStoreHeldOrphanPayment = jest.fn();

/**
 * The device session. `null` models a terminal that is not activated, or whose token has been
 * cleared. That is the case with a money consequence: a device with no session cannot have stored
 * anything, so it must never be able to delete the record.
 */
let mockToken: string | null = 'terminal-token';

jest.mock('../../lib/storage', () => {
  const actual = jest.requireActual('../../lib/storage');
  return {
    ...actual,
    // heldOrphanIdentity and the types stay REAL — the component keys its per-record UI state by
    // that function, so a stand-in would test the stand-in.
    getTerminalToken: jest.fn(async () => mockToken),
    getHeldOrphanPayments: jest.fn(async () => mockHeldRows),
    setHeldOrphanPayments: jest.fn(async () => undefined),
    acknowledgeHeldOrphanPayment: jest.fn(async (identity: string) => {
      const before = mockHeldRows.length;
      mockHeldRows = mockHeldRows.filter(
        r => actual.heldOrphanIdentity(r) !== identity,
      );
      return mockHeldRows.length < before ? 'removed' : 'absent';
    }),
  };
});
jest.mock('../../lib/api', () => ({
  storeHeldOrphanPayment: (...args: unknown[]) =>
    mockStoreHeldOrphanPayment(...args),
  verifyTerminalPayment: jest.fn(async () => ({ok: true, paid: false})),
}));
jest.mock('../../lib/orphanReporting', () => ({
  runOrphanReportPass: jest.fn(async () => ({reported: 0, resolved: 0})),
}));
jest.mock('../../lib/wiretap', () => ({recordWiretapEvent: jest.fn()}));

import HeldOrphanPaymentNotice from '../HeldOrphanPaymentNotice';
import {
  HELD_ORPHAN_ACKNOWLEDGE,
  HELD_ORPHAN_BODY,
  HELD_ORPHAN_BODY_UNKNOWN_ORDER,
  HELD_ORPHAN_NEEDS_A_PERSON,
  HELD_ORPHAN_NOT_SAVED,
  HELD_ORPHAN_SAVING,
} from '../../constants/paymentCopy';
import {heldOrphanIdentity, type HeldOrphanPayment} from '../../lib/storage';

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

/** Text of a React element subtree, used to locate a button by its label. */
function elementText(node: unknown): string {
  if (node == null || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(elementText).join('');
  const props = (node as {props?: {children?: unknown}}).props;
  return props ? elementText(props.children) : '';
}

/** Every string the notice renders — what a member of staff actually looks at. */
function renderedText(json: unknown): string {
  const out: string[] = [];
  const walk = (node: unknown): void => {
    if (typeof node === 'string') {
      out.push(node);
      return;
    }
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    const children = (node as {children?: unknown[]} | null)?.children;
    if (children) children.forEach(walk);
  };
  walk(json);
  return out.join('\n');
}

async function flush() {
  await renderer.act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

// Mounting pays for transforming react-native's whole module graph — tens of seconds on a cold
// cache, far above jest's 5s default. Not a race.
jest.setTimeout(120000);

describe('#344 ruling 3 — the acknowledge outcome reaches the screen', () => {
  let trees: renderer.ReactTestRenderer[] = [];

  beforeEach(() => {
    mockHeldRows = [row()];
    mockStoreHeldOrphanPayment.mockReset();
    mockToken = 'terminal-token';
  });

  afterEach(async () => {
    await renderer.act(async () => {
      trees.forEach(tree => tree.unmount());
    });
    trees = [];
  });

  async function mountNotice(): Promise<renderer.ReactTestRenderer> {
    let tree!: renderer.ReactTestRenderer;
    await renderer.act(async () => {
      tree = renderer.create(<HeldOrphanPaymentNotice />);
    });
    trees.push(tree);
    await flush();
    return tree;
  }

  /** Press the record's own action, located by its label rather than by position. */
  async function pressAcknowledge(tree: renderer.ReactTestRenderer) {
    const buttons = tree.root.findAll(
      node =>
        typeof node.props?.onPress === 'function' &&
        elementText(node.props.children).includes(HELD_ORPHAN_ACKNOWLEDGE),
    );
    expect(buttons).toHaveLength(1);
    await renderer.act(async () => {
      buttons[0].props.onPress();
    });
    await flush();
  }

  it('shows the held record, and NOT the failure sentence, before anything is pressed', async () => {
    const tree = await mountNotice();
    const text = renderedText(tree.toJSON());

    expect(text).toContain(HELD_ORPHAN_BODY);
    // The negative control for the test below: if the sentence were rendered unconditionally,
    // that test would pass while proving nothing.
    expect(text).not.toContain(HELD_ORPHAN_NOT_SAVED);
  });

  /**
   * THE TEST THIS FILE EXISTS FOR. Deleting HeldOrphanPaymentNotice.tsx:232 must fail here.
   */
  it('puts the failure sentence on screen when the store does not succeed', async () => {
    mockStoreHeldOrphanPayment.mockResolvedValue({
      status: 200,
      body: {stored: false, receiptId: ''},
    });

    const tree = await mountNotice();
    await pressAcknowledge(tree);

    expect(renderedText(tree.toJSON())).toContain(HELD_ORPHAN_NOT_SAVED);
  });

  it('keeps the record on screen when the store does not succeed', async () => {
    mockStoreHeldOrphanPayment.mockResolvedValue({
      status: 200,
      body: {stored: false, receiptId: ''},
    });

    const tree = await mountNotice();
    await pressAcknowledge(tree);

    // Ruling 3's asymmetry, seen from the screen: nothing was stored, so nothing was removed.
    expect(renderedText(tree.toJSON())).toContain(HELD_ORPHAN_BODY);
    expect(mockHeldRows).toHaveLength(1);
  });

  it('reports a transport failure the same way — a throw is not an acknowledgement', async () => {
    mockStoreHeldOrphanPayment.mockRejectedValue(new Error('offline'));

    const tree = await mountNotice();
    await pressAcknowledge(tree);

    const text = renderedText(tree.toJSON());
    expect(text).toContain(HELD_ORPHAN_NOT_SAVED);
    expect(text).toContain(HELD_ORPHAN_BODY);
  });

  it('shows the saving label while the store is in flight', async () => {
    let releaseStore!: (v: unknown) => void;
    mockStoreHeldOrphanPayment.mockReturnValue(
      new Promise(resolve => {
        releaseStore = resolve;
      }),
    );

    const tree = await mountNotice();
    const buttons = tree.root.findAll(
      node =>
        typeof node.props?.onPress === 'function' &&
        elementText(node.props.children).includes(HELD_ORPHAN_ACKNOWLEDGE),
    );
    await renderer.act(async () => {
      buttons[0].props.onPress();
    });
    await flush();

    const inFlight = renderedText(tree.toJSON());
    expect(inFlight).toContain(HELD_ORPHAN_SAVING);
    // Nothing has failed yet, so the failure sentence must not be showing.
    expect(inFlight).not.toContain(HELD_ORPHAN_NOT_SAVED);

    await renderer.act(async () => {
      releaseStore({status: 200, body: {stored: true, receiptId: 'HP-77'}});
    });
    await flush();
  });

  /**
   * THE POSITIVE CONTROL, and the reason the failure tests mean anything. A component that rendered
   * the failure sentence unconditionally, or that never cleared a record, would satisfy every test
   * above. This one fails for both of those.
   */
  it('removes the record from the screen when the store DOES succeed', async () => {
    mockStoreHeldOrphanPayment.mockResolvedValue({
      status: 200,
      body: {stored: true, receiptId: 'HP-77'},
    });

    const tree = await mountNotice();
    expect(renderedText(tree.toJSON())).toContain(HELD_ORPHAN_BODY);

    await pressAcknowledge(tree);

    // The notice renders null once nothing is held.
    expect(mockHeldRows).toHaveLength(0);
    const text = renderedText(tree.toJSON());
    expect(text).not.toContain(HELD_ORPHAN_BODY);
    expect(text).not.toContain(HELD_ORPHAN_NOT_SAVED);
  });

  it('releases the record it was given, addressed by value identity', async () => {
    const other = row({heldAt: '2026-08-26T10:00:00.000Z', voucherNo: 'V-002'});
    mockHeldRows = [row(), other];
    mockStoreHeldOrphanPayment.mockResolvedValue({
      status: 200,
      body: {stored: true, receiptId: 'HP-78'},
    });

    const tree = await mountNotice();
    const buttons = tree.root.findAll(
      node =>
        typeof node.props?.onPress === 'function' &&
        elementText(node.props.children).includes(HELD_ORPHAN_ACKNOWLEDGE),
    );
    expect(buttons).toHaveLength(2);

    await renderer.act(async () => {
      buttons[0].props.onPress();
    });
    await flush();

    // One button per record, and pressing one must not wipe the store — the defect the
    // per-record action replaced.
    expect(mockHeldRows).toHaveLength(1);
    expect(heldOrphanIdentity(mockHeldRows[0])).toBe(heldOrphanIdentity(other));
  });
});

/**
 * CASE 3 — the record that can never clear itself.
 *
 * WHY IT IS PINNED SEPARATELY AND BEFORE vc98 SHIPS. A case-2 record names an order, is reported to
 * the server on every screen focus, and disappears by itself once that order settles. A case-3
 * record names NO order, so `isReportableHeldOrphan` refuses it, `runOrphanReportPass` can never
 * resolve it, and it sits on screen until a person acts. It is simultaneously the state most in
 * need of being correct and the least likely for anyone to encounter on a device.
 *
 * TWO CONDITIONS, NOT ONE, AND THE COMPONENT KEYS THEM DIFFERENTLY. The BODY variant is chosen by
 * `reason === 'unknown_order'`; the NEEDS_A_PERSON line is chosen by `orphanOrderId` being empty.
 * They travel together in practice but they are separate branches in the render, so they are
 * separate tests — pinning one would leave the other free to break.
 *
 * Every assertion compares against IMPORTED constants. Re-wording the copy cannot fail this file.
 */
describe('#344 case 3 — a held payment naming no order', () => {
  let trees: renderer.ReactTestRenderer[] = [];

  const caseThree = () =>
    row({orphanOrderId: '', reason: 'unknown_order', voucherNo: undefined});

  beforeEach(() => {
    mockHeldRows = [caseThree()];
    mockStoreHeldOrphanPayment.mockReset();
    mockToken = 'terminal-token';
  });

  afterEach(async () => {
    await renderer.act(async () => {
      trees.forEach(tree => tree.unmount());
    });
    trees = [];
  });

  async function mountNotice(): Promise<renderer.ReactTestRenderer> {
    let tree!: renderer.ReactTestRenderer;
    await renderer.act(async () => {
      tree = renderer.create(<HeldOrphanPaymentNotice />);
    });
    trees.push(tree);
    await flush();
    return tree;
  }

  it('shows the unknown-order body, not the different-order one', async () => {
    const tree = await mountNotice();
    const text = renderedText(tree.toJSON());

    expect(text).toContain(HELD_ORPHAN_BODY_UNKNOWN_ORDER);
    // The two bodies share a long tail, so the discriminating half is asserted directly:
    // saying "belongs to a different order" about a payment whose order is unknown is a lie.
    expect(text).not.toContain('belongs to a different order');
  });

  it('shows the needs-a-person line, because nothing will resolve this one', async () => {
    const tree = await mountNotice();

    expect(renderedText(tree.toJSON())).toContain(HELD_ORPHAN_NEEDS_A_PERSON);
  });

  it('omits the voucher line when there is no voucher', async () => {
    const tree = await mountNotice();

    // 'Voucher' is a bare label rendered beside the number, so its absence is the assertion.
    expect(renderedText(tree.toJSON())).not.toContain('Voucher');
  });

  /**
   * THE NEGATIVE CONTROLS. Without these, a component that rendered the case-3 line
   * unconditionally — or dropped the voucher line entirely — would satisfy every test above.
   */
  it('a case-2 record shows the different-order body and NOT the case-3 line', async () => {
    mockHeldRows = [row()];
    const tree = await mountNotice();
    const text = renderedText(tree.toJSON());

    expect(text).toContain(HELD_ORPHAN_BODY);
    expect(text).not.toContain(HELD_ORPHAN_BODY_UNKNOWN_ORDER);
    expect(text).not.toContain(HELD_ORPHAN_NEEDS_A_PERSON);
  });

  it('a record WITH a voucher still shows it', async () => {
    mockHeldRows = [row({voucherNo: 'V-123'})];
    const tree = await mountNotice();
    const text = renderedText(tree.toJSON());

    expect(text).toContain('Voucher');
    expect(text).toContain('V-123');
  });
});

/**
 * THE NO-SESSION PATH, and it is the one with a money consequence rather than a cosmetic one.
 *
 * `getTerminalToken()` returning null must take the SAME 'kept' branch as a failed store. A device
 * with no session cannot have stored anything, so releasing here would delete the only remaining
 * record of a card transaction on the strength of not being logged in — `consumeOrphanedPaymentResult`
 * is destructive, so there is no third copy anywhere.
 *
 * VERIFIED PRESENT IN THE COMPONENT before this was written, not assumed:
 * HeldOrphanPaymentNotice.tsx:144-157 is `token ? await storeAndReleaseHeldOrphan(...) : {outcome:
 * 'kept' as const}`, so the release path is unreachable without a token.
 *
 * THE SHARPEST ASSERTION HERE IS THAT THE STORE IS NEVER CALLED. That the record survives could be
 * explained by a store that happened to fail; that the call was never attempted can only be
 * explained by the guard.
 */
describe('#344 ruling 3 — a device with no session cannot discard a record', () => {
  let trees: renderer.ReactTestRenderer[] = [];

  beforeEach(() => {
    mockHeldRows = [row()];
    mockStoreHeldOrphanPayment.mockReset();
    mockToken = null;
  });

  afterEach(async () => {
    await renderer.act(async () => {
      trees.forEach(tree => tree.unmount());
    });
    trees = [];
  });

  it('keeps the record, says so, and never attempts the store', async () => {
    let tree!: renderer.ReactTestRenderer;
    await renderer.act(async () => {
      tree = renderer.create(<HeldOrphanPaymentNotice />);
    });
    trees.push(tree);
    await flush();

    const buttons = tree.root.findAll(
      node =>
        typeof node.props?.onPress === 'function' &&
        elementText(node.props.children).includes(HELD_ORPHAN_ACKNOWLEDGE),
    );
    expect(buttons).toHaveLength(1);
    await renderer.act(async () => {
      buttons[0].props.onPress();
    });
    await flush();

    const text = renderedText(tree.toJSON());
    // Told, not silently ignored: the same failure sentence a failed store produces.
    expect(text).toContain(HELD_ORPHAN_NOT_SAVED);
    // Still there.
    expect(text).toContain(HELD_ORPHAN_BODY);
    expect(mockHeldRows).toHaveLength(1);
    // Never attempted. This is the assertion that can only be satisfied by the token guard.
    expect(mockStoreHeldOrphanPayment).not.toHaveBeenCalled();
  });
});
