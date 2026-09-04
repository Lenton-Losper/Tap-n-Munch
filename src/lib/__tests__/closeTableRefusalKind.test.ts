/**
 * Ship 2b — which refusals are which kind, and when the manager override may appear.
 *
 * THE ASSERTION THAT CARRIES THE FILE is that the override is offered for money and NOTHING else.
 * The owner's ruling: "still being made" is something a waiter fixes themselves and must not offer
 * the override. An override reachable from an ordinary blocker stops being a control within a
 * week, because staff learn it is the fast path.
 */
import {
  CLOSE_TABLE_REFUSAL_KIND,
  CLOSE_TABLE_REFUSAL_RULES,
  walkoutOverrideAvailable,
  type CloseTableRefusalId,
} from '../closeTableRefusals';

describe('every refusal is classified', () => {
  it('covers every rule in the refusal set — no rule renders unclassified', () => {
    // A new rule added without a kind would fall through to whatever the renderer defaults to,
    // which is how the red wall got built in the first place.
    for (const rule of CLOSE_TABLE_REFUSAL_RULES) {
      expect(CLOSE_TABLE_REFUSAL_KIND[rule.id]).toBeDefined();
    }
    expect(Object.keys(CLOSE_TABLE_REFUSAL_KIND)).toHaveLength(CLOSE_TABLE_REFUSAL_RULES.length);
  });

  it('classifies exactly three as money', () => {
    const money = Object.entries(CLOSE_TABLE_REFUSAL_KIND)
      .filter(([, k]) => k === 'money')
      .map(([id]) => id)
      .sort();
    expect(money).toEqual(['LINE_TRACKING_UNAVAILABLE', 'ORDER_OWES_MONEY', 'UNPAID_BALANCE']);
  });

  it('keeps the two genuinely alarming ones alarming', () => {
    // "The card may have been charged", and food on a bill nobody is making.
    expect(CLOSE_TABLE_REFUSAL_KIND.CARD_PAYMENT_STUCK).toBe('alarming');
    expect(CLOSE_TABLE_REFUSAL_KIND.UNROUTED_LINE).toBe('alarming');
  });

  it('treats the four load failures as broken, not alarming', () => {
    // Rendering "refresh and try again" in red is what taught staff that red means nothing.
    for (const id of ['TABLE_UNKNOWN', 'LINES_UNKNOWN', 'TAB_STATUS_UNKNOWN', 'SERVER_REFUSES'] as const) {
      expect(CLOSE_TABLE_REFUSAL_KIND[id]).toBe('broken');
    }
  });
});

describe('walkoutOverrideAvailable — money only', () => {
  it('offers the override when money is the only blocker', () => {
    expect(walkoutOverrideAvailable(['UNPAID_BALANCE'])).toBe(true);
    expect(walkoutOverrideAvailable(['UNPAID_BALANCE', 'ORDER_OWES_MONEY'])).toBe(true);
    expect(walkoutOverrideAvailable(['LINE_TRACKING_UNAVAILABLE'])).toBe(true);
  });

  it('does NOT offer it when food is still being made', () => {
    // The case the owner named. A table mid-service is not a walkout, and closing it would strand
    // a dish somebody is making.
    expect(walkoutOverrideAvailable(['UNPAID_BALANCE', 'OUTSTANDING_LINE'])).toBe(false);
    expect(walkoutOverrideAvailable(['OUTSTANDING_LINE'])).toBe(false);
  });

  it('does NOT offer it alongside an alarming refusal', () => {
    // A card that may have been charged must be checked, not overridden.
    expect(walkoutOverrideAvailable(['UNPAID_BALANCE', 'CARD_PAYMENT_STUCK'])).toBe(false);
    expect(walkoutOverrideAvailable(['UNPAID_BALANCE', 'UNROUTED_LINE'])).toBe(false);
  });

  it('does NOT offer it when something failed to load', () => {
    // "There is money owed" is not trustworthy when the money view did not load.
    expect(walkoutOverrideAvailable(['UNPAID_BALANCE', 'TABLE_UNKNOWN'])).toBe(false);
  });

  it('does NOT offer it for an unsent round or a live card', () => {
    expect(walkoutOverrideAvailable(['UNPAID_BALANCE', 'UNSENT_ROUND_ON_DEVICE'])).toBe(false);
    expect(walkoutOverrideAvailable(['UNPAID_BALANCE', 'CARD_PAYMENT_IN_FLIGHT'])).toBe(false);
  });

  it('offers nothing when there is nothing to override', () => {
    expect(walkoutOverrideAvailable([])).toBe(false);
  });

  it('never offers it for any single non-money refusal', () => {
    const nonMoney = (Object.keys(CLOSE_TABLE_REFUSAL_KIND) as CloseTableRefusalId[]).filter(
      id => CLOSE_TABLE_REFUSAL_KIND[id] !== 'money',
    );
    expect(nonMoney).toHaveLength(9);
    for (const id of nonMoney) {
      expect({id, offered: walkoutOverrideAvailable([id])}).toEqual({id, offered: false});
    }
  });
});
