/**
 * Item-level bill splitting — the rules that decide who owes what.
 *
 * THE ASSERTION THAT CARRIES THE FILE is that the device never computes an amount. Every figure is
 * a server-supplied integer-cent value or a sum of them. A second, independent division here would
 * be a second answer to the same question, and the two would disagree on exactly the inputs that
 * matter: an odd number of cents shared by two people.
 */
import {
  assignableNames,
  canSplitLine,
  formatCents,
  personSplits,
  sharesFor,
  splitRefusal,
  tabRemainderCents,
  unallocatedCents,
  type SplittableLine,
} from '../splitBill';

const line = (over: Partial<SplittableLine>): SplittableLine => ({
  id: 'l1',
  name_snapshot: 'Ribeye',
  quantity: 1,
  is_voided: false,
  total_cents: 10000,
  allocations: [],
  allocated_cents: 0,
  ...over,
});

const alloc = (over: Partial<SplittableLine['allocations']> extends never ? never : Record<string, unknown>) => ({
  id: 'a1',
  allocated_to: 'Sam',
  quantity_allocated: 1,
  amount_cents: 10000,
  settled_at: null,
  ...over,
});

describe('unallocatedCents', () => {
  it('is the whole line when nothing is assigned', () => {
    expect(unallocatedCents(line({}))).toBe(10000);
  });

  it('drops by what has been assigned', () => {
    expect(unallocatedCents(line({allocated_cents: 4000}))).toBe(6000);
  });

  it('is zero, never negative, when over-assigned', () => {
    // Defensive: an over-assigned line should not be reachable, and if it ever is, a NEGATIVE
    // "not yet assigned" figure on a screen is worse than a zero.
    expect(unallocatedCents(line({allocated_cents: 12000}))).toBe(0);
  });

  it('is NULL for an unpriced line — not zero', () => {
    // Zero would read as a free item and split cleanly into nothing.
    expect(unallocatedCents(line({total_cents: null}))).toBeNull();
    expect(unallocatedCents(line({total_cents: undefined}))).toBeNull();
  });
});

describe('canSplitLine / splitRefusal — three different refusals', () => {
  it('allows an ordinary priced line', () => {
    expect(canSplitLine(line({}))).toBe(true);
    expect(splitRefusal(line({}))).toBeNull();
  });

  it('refuses a voided line — nobody owes it', () => {
    expect(canSplitLine(line({is_voided: true}))).toBe(false);
    expect(splitRefusal(line({is_voided: true}))).toBe('voided');
  });

  it('refuses an unpriced line rather than guessing a figure', () => {
    expect(canSplitLine(line({total_cents: null}))).toBe(false);
    expect(splitRefusal(line({total_cents: null}))).toBe('unpriced');
  });

  it('refuses a line with ANY settled allocation — money has already moved', () => {
    // The server's own rule (ALREADY_SETTLED, 409). Re-dividing would move an amount somebody
    // has already paid.
    const settled = line({
      allocations: [alloc({settled_at: '2026-09-03T10:00:00Z'}) as never],
    });
    expect(canSplitLine(settled)).toBe(false);
    expect(splitRefusal(settled)).toBe('already_settled');
  });

  it('still allows a line whose allocations are all UNSETTLED', () => {
    expect(canSplitLine(line({allocations: [alloc({}) as never]}))).toBe(true);
  });
});

describe('personSplits', () => {
  it('sums each person across lines, separating settled from unsettled', () => {
    const lines = [
      line({id: 'l1', allocations: [alloc({id: 'a1', allocated_to: 'Sam', amount_cents: 4000}) as never]}),
      line({
        id: 'l2',
        allocations: [
          alloc({id: 'a2', allocated_to: 'Sam', amount_cents: 2500}) as never,
          alloc({id: 'a3', allocated_to: 'Priya', amount_cents: 3000, settled_at: '2026-09-03T10:00:00Z'}) as never,
        ],
      }),
    ];
    const people = personSplits(lines);
    expect(people.map(p => p.name)).toEqual(['Priya', 'Sam']);

    const sam = people.find(p => p.name === 'Sam')!;
    expect(sam.unsettledCents).toBe(6500);
    expect(sam.unsettledAllocationIds).toEqual(['a1', 'a2']);
    expect(sam.settledCents).toBe(0);

    const priya = people.find(p => p.name === 'Priya')!;
    expect(priya.unsettledCents).toBe(0);
    expect(priya.settledCents).toBe(3000);
    expect(priya.unsettledAllocationIds).toEqual([]);
  });

  it('is sorted by name — a list that reshuffles is how the wrong person gets charged', () => {
    const lines = [
      line({allocations: [
        alloc({id: 'a1', allocated_to: 'Zoe'}) as never,
        alloc({id: 'a2', allocated_to: 'Ana'}) as never,
      ]}),
    ];
    expect(personSplits(lines).map(p => p.name)).toEqual(['Ana', 'Zoe']);
  });

  it('ignores a blank name rather than creating an unnamed payer', () => {
    const lines = [line({allocations: [alloc({allocated_to: '   '}) as never]})];
    expect(personSplits(lines)).toEqual([]);
  });

  it('is empty for a tab nobody has split', () => {
    expect(personSplits([line({})])).toEqual([]);
  });
});

describe('assignableNames — members first, per the owner ruling', () => {
  it('offers tab members in their own order', () => {
    expect(assignableNames(['Sam', 'Priya'], [])).toEqual(['Sam', 'Priya']);
  });

  it('appends someone who has an allocation but is not a member', () => {
    // A name typed by hand on an earlier line stays one tap away for the next one.
    const lines = [line({allocations: [alloc({allocated_to: 'Walk-in'}) as never]})];
    expect(assignableNames(['Sam'], lines)).toEqual(['Sam', 'Walk-in']);
  });

  it('does not offer the same person twice, whatever the casing', () => {
    const lines = [line({allocations: [alloc({allocated_to: 'sam'}) as never]})];
    expect(assignableNames(['Sam'], lines)).toEqual(['Sam']);
  });

  it('survives a tab with no members at all', () => {
    expect(assignableNames(null, [])).toEqual([]);
    expect(assignableNames(undefined, [])).toEqual([]);
  });
});

describe('sharesFor — HALF only, and the device never names an amount', () => {
  it('assigns a whole line to one person with weight 1', () => {
    expect(sharesFor('whole', 'Sam', null)).toEqual([
      {allocated_to: 'Sam', quantity_allocated: 1},
    ]);
  });

  it('splits in half as two equal WEIGHTS, not two amounts', () => {
    // The server divides the line total across these weights in integer cents, so an odd-cent
    // line comes back as 1667/1666 summing exactly. If this returned amounts, the device would be
    // deciding who carries the extra cent.
    expect(sharesFor('half', 'Sam', 'Priya')).toEqual([
      {allocated_to: 'Sam', quantity_allocated: 0.5},
      {allocated_to: 'Priya', quantity_allocated: 0.5},
    ]);
  });

  it('never emits a share carrying a cash amount', () => {
    for (const shares of [sharesFor('whole', 'Sam', null), sharesFor('half', 'Sam', 'Priya')]) {
      for (const s of shares) {
        expect(Object.keys(s).sort()).toEqual(['allocated_to', 'quantity_allocated']);
      }
    }
  });

  it('falls back to a whole share when half is asked for without a second person', () => {
    expect(sharesFor('half', 'Sam', null)).toEqual([
      {allocated_to: 'Sam', quantity_allocated: 1},
    ]);
    expect(sharesFor('half', 'Sam', '   ')).toEqual([
      {allocated_to: 'Sam', quantity_allocated: 1},
    ]);
  });

  it('trims names, so "Sam " and "Sam" are one person', () => {
    expect(sharesFor('whole', '  Sam  ', null)[0].allocated_to).toBe('Sam');
  });
});

describe('tabRemainderCents — what stays open after a partial settlement', () => {
  it('is the whole tab when nothing is settled', () => {
    expect(tabRemainderCents([line({total_cents: 4000}), line({total_cents: 2500})])).toBe(6500);
  });

  it('drops by settled allocations only, not by merely assigned ones', () => {
    // Assigning is not paying. A tab whose lines are all assigned still owes everything.
    const assigned = line({total_cents: 4000, allocations: [alloc({amount_cents: 4000}) as never]});
    expect(tabRemainderCents([assigned])).toBe(4000);

    const paid = line({
      total_cents: 4000,
      allocations: [alloc({amount_cents: 4000, settled_at: '2026-09-03T10:00:00Z'}) as never],
    });
    expect(tabRemainderCents([paid])).toBe(0);
  });

  it('leaves the unpaid half of a half-settled line owing', () => {
    const half = line({
      total_cents: 4000,
      allocations: [
        alloc({id: 'a1', amount_cents: 2000, settled_at: '2026-09-03T10:00:00Z'}) as never,
        alloc({id: 'a2', amount_cents: 2000}) as never,
      ],
    });
    expect(tabRemainderCents([half])).toBe(2000);
  });

  it('ignores voided lines and unpriced ones', () => {
    expect(tabRemainderCents([line({is_voided: true, total_cents: 9999})])).toBe(0);
    expect(tabRemainderCents([line({total_cents: null})])).toBe(0);
  });
});

describe('formatCents', () => {
  it('renders integer cents as money', () => {
    expect(formatCents(1234)).toBe('NAD 12.34');
    expect(formatCents(0)).toBe('NAD 0.00');
    expect(formatCents(1667)).toBe('NAD 16.67');
  });
});
