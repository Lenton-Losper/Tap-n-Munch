import {
  deriveTableFlag,
  formatAge,
  itemCount,
  oldestOutstandingSeconds,
  OUTSTANDING_ATTENTION_SECONDS,
  TabLine,
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

  it('does not flag a line the server already considers ready, however old', () => {
    const p = payload({
      orders: [
        order([line({is_ready: true})], OUTSTANDING_ATTENTION_SECONDS * 5),
      ],
    });
    expect(deriveTableFlag(p)).toBeNull();
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
