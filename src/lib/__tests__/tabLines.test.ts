import {
  deriveTableBadge,
  deriveTableFlag,
  formatAge,
  itemCount,
  mergeTableBadges,
  oldestOutstandingSeconds,
  OUTSTANDING_ATTENTION_SECONDS,
  TabLine,
  TableBadge,
  TabLinesPayload,
  tabRunningTotal,
} from '../tabLines';

function line(over: Partial<TabLine> = {}): TabLine {
  return {
    id: `l${Math.random()}`,
    name_snapshot: 'Ribeye',
    quantity: 1,
    line_note: null,
    route_to: 'kitchen',
    kitchen_state: 'pending',
    bar_state: null,
    is_ready: false,
    is_voided: false,
    unrouted: false,
    ...over,
  };
}

function payload(over: Partial<TabLinesPayload> = {}): TabLinesPayload {
  return {
    tab: {
      id: 'tab-1',
      table_number: 7,
      status: 'open',
      total: 250,
      opened_at: null,
      opened_by_user_id: null,
    },
    orders: [],
    summary: {total_lines: 0, outstanding: 0, ready: 0, voided: 0},
    all_ready: false,
    has_lines: true,
    server_time: null,
    ...over,
  };
}

function order(lines: TabLine[], secondsSincePlaced: number | null = 60) {
  return {
    order_id: `o${Math.random()}`,
    order_number: 12,
    order_instructions: null,
    order_total: 100,
    placed_at: '2026-08-28T10:00:00Z',
    seconds_since_placed: secondsSincePlaced,
    lines,
  };
}

describe('deriveTableFlag', () => {
  it('flags nothing for a tab the server says has no lines', () => {
    // A QR or pre-migration tab. It has a bill; it has no fulfilment state. Inventing a badge
    // here would assert something the payload explicitly declines to say.
    expect(
      deriveTableFlag(
        payload({has_lines: false, orders: [order([line()])]}),
      ),
    ).toBeNull();
  });

  it('flags nothing for a null payload', () => {
    expect(deriveTableFlag(null)).toBeNull();
    expect(deriveTableFlag(undefined)).toBeNull();
  });

  it('ranks unrouted above everything, because nobody is cooking that item', () => {
    const p = payload({
      all_ready: true,
      orders: [
        order([
          line({is_ready: true}),
          line({unrouted: true, is_ready: true}),
        ]),
      ],
    });
    expect(deriveTableFlag(p)).toBe('unrouted');
  });

  it('flags ready when the server says every line is ready', () => {
    const p = payload({
      all_ready: true,
      orders: [order([line({is_ready: true}), line({is_ready: true})])],
    });
    expect(deriveTableFlag(p)).toBe('ready');
  });

  it('trusts all_ready rather than recomputing it from the lines', () => {
    // The server owns the definition of ready. If it says the table is up, the table is up, even
    // where a client-side scan of is_ready would have hesitated.
    const p = payload({
      all_ready: true,
      orders: [order([line({is_ready: false})])],
    });
    expect(deriveTableFlag(p)).toBe('ready');
  });

  it('flags waiting once an outstanding line passes the attention threshold', () => {
    const p = payload({
      orders: [order([line()], OUTSTANDING_ATTENTION_SECONDS)],
    });
    expect(deriveTableFlag(p)).toBe('waiting');
  });

  it('does not flag a young outstanding line', () => {
    const p = payload({
      orders: [order([line()], OUTSTANDING_ATTENTION_SECONDS - 1)],
    });
    expect(deriveTableFlag(p)).toBeNull();
  });

  it('ignores voided lines entirely when deciding', () => {
    const p = payload({
      orders: [
        order(
          [line({is_voided: true, unrouted: true})],
          OUTSTANDING_ATTENTION_SECONDS * 10,
        ),
      ],
    });
    expect(deriveTableFlag(p)).toBeNull();
  });

  it('does not flag waiting on an order with no server-side age', () => {
    // seconds_since_placed is null. Substituting the device clock here is exactly the mistake the
    // whole feature avoids, so the honest answer is no flag.
    const p = payload({orders: [order([line()], null)]});
    expect(deriveTableFlag(p)).toBeNull();
  });

  it('does not fall through to waiting on a line the server considers ready, however old', () => {
    // REWRITTEN. This used to assert `null` — an old-but-ready line was neither waiting nor ready,
    // because 'ready' was gated on all_ready. A ready line IS something to collect, whatever its
    // age, so the flag is now 'ready'. What survives from the original assertion is the part that
    // mattered: a ready line must never be counted as late.
    const p = payload({
      orders: [
        order([line({is_ready: true})], OUTSTANDING_ATTENTION_SECONDS * 5),
      ],
    });
    expect(deriveTableFlag(p)).toBe('ready');
  });
});

/**
 * THE DEFECT THIS FEATURE EXISTS TO FIX.
 *
 * Every case here rendered amber WAITING, or nothing at all, while food sat on the pass.
 */
describe('a partially ready tab is never WAITING', () => {
  it('ranks a single ready line above an outstanding line old enough to be stale', () => {
    // Three plates up, one main still cooking, ticket 25 minutes old. The old rule showed WAITING:
    // it told a waiter there was nothing to collect at the exact moment there was.
    const p = payload({
      orders: [
        order(
          [
            line({is_ready: true}),
            line({is_ready: true}),
            line({is_ready: true}),
            line({is_ready: false}),
          ],
          OUTSTANDING_ATTENTION_SECONDS + 300,
        ),
      ],
    });
    expect(deriveTableBadge(p)).toEqual({flag: 'ready', readyCount: 3});
  });

  it('flags a ready line on a young ticket, which used to show nothing at all', () => {
    const p = payload({
      orders: [
        order(
          [line({is_ready: true}), line({is_ready: false})],
          60,
        ),
      ],
    });
    expect(deriveTableBadge(p)).toEqual({flag: 'ready', readyCount: 1});
  });

  it('keeps the badge when a later round is sent onto a tab whose starters are up', () => {
    // all_ready goes false the moment the second round lands. Under the old rule the READY badge
    // vanished at that point, while the starters were still sitting there.
    const p = payload({
      all_ready: false,
      orders: [
        order([line({is_ready: true}), line({is_ready: true})], 600),
        order([line({is_ready: false})], 30),
      ],
    });
    expect(deriveTableBadge(p)).toEqual({flag: 'ready', readyCount: 2});
  });

  it('still ranks unrouted above ready, because nobody is cooking that item', () => {
    const p = payload({
      orders: [order([line({is_ready: true}), line({unrouted: true})])],
    });
    expect(deriveTableBadge(p)).toEqual({flag: 'unrouted', readyCount: 0});
  });

  it('does not count a voided line as something to collect', () => {
    const p = payload({
      orders: [
        order([line({is_ready: true, is_voided: true}), line({is_ready: true})]),
      ],
    });
    expect(deriveTableBadge(p)).toEqual({flag: 'ready', readyCount: 1});
  });

  it('counts ready lines across every order on the tab', () => {
    const p = payload({
      orders: [
        order([line({is_ready: true}), line({is_ready: false})]),
        order([line({is_ready: true}), line({is_ready: true})]),
      ],
    });
    expect(deriveTableBadge(p).readyCount).toBe(3);
  });

  it('reports a zero count when all_ready is the only evidence, so no numeral is rendered', () => {
    // Reachable if a payload ever sets all_ready without setting is_ready on any line. The flag is
    // still 'ready' — the server said so — but the count must not be rendered as "READY 0".
    const p = payload({
      all_ready: true,
      orders: [order([line({is_ready: false})])],
    });
    expect(deriveTableBadge(p)).toEqual({flag: 'ready', readyCount: 0});
  });

  it('reports no count for waiting and for a clean tab', () => {
    expect(
      deriveTableBadge(
        payload({orders: [order([line()], OUTSTANDING_ATTENTION_SECONDS)]}),
      ),
    ).toEqual({flag: 'waiting', readyCount: 0});
    expect(deriveTableBadge(payload({orders: [order([line()], 60)]}))).toEqual({
      flag: null,
      readyCount: 0,
    });
  });
});

/**
 * A transient network failure must not be able to un-say "there is food on the pass".
 */
describe('mergeTableBadges', () => {
  const ready: TableBadge = {flag: 'ready', readyCount: 2};
  const clear: TableBadge = {flag: null, readyCount: 0};

  it('keeps a badge whose tab failed to load this pass', () => {
    // 't1' was attempted and threw, so it left no key in `fetched`. Rebuilding the map from the
    // successes alone is what made a READY badge blink out between refreshes.
    expect(mergeTableBadges({t1: ready}, {t2: clear}, ['t1', 't2'])).toEqual({
      t1: ready,
      t2: clear,
    });
  });

  it('lets a successful read clear a badge, because a null flag is a real answer', () => {
    expect(mergeTableBadges({t1: ready}, {t1: clear}, ['t1'])).toEqual({
      t1: clear,
    });
  });

  it('evicts a table that is no longer open with a tab, however it was badged', () => {
    // The eviction bound. Settled, closed or freed tables drop out via the grid's own poll, which
    // succeeds independently of the per-tab reads — so a stale badge cannot outlive the table.
    expect(mergeTableBadges({t1: ready, t2: ready}, {}, ['t2'])).toEqual({
      t2: ready,
    });
  });

  it('drops everything when the floor has no eligible table left', () => {
    expect(mergeTableBadges({t1: ready}, {}, [])).toEqual({});
  });

  it('leaves an unknown table absent rather than inventing a badge for it', () => {
    expect(mergeTableBadges({}, {}, ['t1'])).toEqual({});
  });

  it('does not mutate the map it was given', () => {
    const previous = {t1: ready};
    mergeTableBadges(previous, {t1: clear}, ['t1']);
    expect(previous).toEqual({t1: ready});
  });
});

describe('oldestOutstandingSeconds', () => {
  it('returns the oldest order that still has something outstanding', () => {
    const p = payload({
      orders: [
        order([line({is_ready: true})], 9999),
        order([line()], 400),
        order([line()], 120),
      ],
    });
    expect(oldestOutstandingSeconds(p)).toBe(400);
  });

  it('is null when everything is ready', () => {
    const p = payload({orders: [order([line({is_ready: true})], 900)]});
    expect(oldestOutstandingSeconds(p)).toBeNull();
  });

  it('is null for a tab with no lines', () => {
    expect(oldestOutstandingSeconds(payload({has_lines: false}))).toBeNull();
  });
});

describe('the two numbers that are not the same number', () => {
  it('counts ITEMS as summed quantities, which total_lines is not', () => {
    // A both-routed item is ONE fulfilment line. Presenting total_lines as an item count is the
    // documented trap; itemCount sums the quantities instead.
    const p = payload({
      summary: {total_lines: 1, outstanding: 1, ready: 0, voided: 0},
      orders: [order([line({quantity: 3})])],
    });
    expect(p.summary.total_lines).toBe(1);
    expect(itemCount(p)).toBe(3);
  });

  it('excludes voided lines from the item count', () => {
    const p = payload({
      orders: [order([line({quantity: 2}), line({quantity: 5, is_voided: true})])],
    });
    expect(itemCount(p)).toBe(2);
  });
});

describe('tabRunningTotal', () => {
  it("takes the server's tab total rather than summing the orders", () => {
    const p = payload({
      tab: {
        id: 'tab-1',
        table_number: 7,
        status: 'open',
        total: 250,
        opened_at: null,
        opened_by_user_id: null,
      },
      // Deliberately disagrees with tab.total, as a discount or void would make it.
      orders: [order([line()]), order([line()])],
    });
    expect(tabRunningTotal(p)).toBe(250);
  });

  it('is zero rather than NaN for a missing or unreadable total', () => {
    expect(tabRunningTotal(null)).toBe(0);
    expect(
      tabRunningTotal(payload({tab: {...payload().tab, total: NaN}})),
    ).toBe(0);
  });
});

describe('formatAge', () => {
  it('renders hours and minutes', () => {
    expect(formatAge(4512)).toBe('1h 15m');
    expect(formatAge(1200)).toBe('20m');
    expect(formatAge(5)).toBe('just now');
  });

  it('is blank for a missing or nonsensical value', () => {
    expect(formatAge(null)).toBe('');
    expect(formatAge(undefined)).toBe('');
    expect(formatAge(-1)).toBe('');
    expect(formatAge(Number.NaN)).toBe('');
  });
});
