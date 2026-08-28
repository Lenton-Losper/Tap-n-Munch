/**
 * THE REFUSAL SET, PINNED ONE RULE AT A TIME.
 *
 * Every rule in CLOSE_TABLE_REFUSAL_RULES gets its own assertion here, built by taking a snapshot
 * that is fully closeable and breaking EXACTLY ONE thing. That shape is deliberate: it proves each
 * rule fires on its own condition and not as a side effect of some other rule, so deleting one
 * rule turns exactly one test red and the owner's ruling on it is a one-line change with a
 * one-line consequence.
 *
 * TWO ASSERTIONS HERE ARE ABOUT WHAT MUST **NOT** REFUSE, and they matter more than the rest:
 *
 *   - A SETTLED TAB IS STILL CLOSEABLE. Settling does not end a session and being settled is the
 *     normal input to closing, not a reason to block it.
 *   - PAID IS NOT CLOSED. A fully-paid tab with food still on the pass is still refused. Nothing
 *     in the refusal set may read payment as completion.
 */
import {
  canCloseTable,
  CLOSE_TABLE_REFUSAL_RULES,
  CloseTableSnapshot,
  evaluateCloseTableRefusals,
  findTableRow,
} from '../closeTableRefusals';
import {TabLine, TabLinesPayload} from '../tabLines';
import {TableWithTab} from '../../types';

const PLACED_AT = '2026-08-27T18:00:00.000Z';

function line(over: Partial<TabLine> = {}): TabLine {
  return {
    id: 'line-1',
    name_snapshot: 'Steak',
    quantity: 1,
    line_note: null,
    route_to: 'kitchen',
    kitchen_state: 'ready',
    bar_state: null,
    is_ready: true,
    is_voided: false,
    unrouted: false,
    ...over,
  };
}

function linesPayload(over: Partial<TabLinesPayload> = {}): TabLinesPayload {
  return {
    tab: {
      id: 'tab-1',
      table_number: 5,
      status: 'settled',
      total: 200,
      opened_at: PLACED_AT,
      opened_by_user_id: 'user-1',
    },
    orders: [
      {
        order_id: 'order-1',
        order_number: 41,
        order_instructions: null,
        order_total: 200,
        placed_at: PLACED_AT,
        seconds_since_placed: 900,
        lines: [line()],
      },
    ],
    summary: {total_lines: 1, outstanding: 0, ready: 1, voided: 0},
    all_ready: true,
    has_lines: true,
    server_time: null,
    ...over,
  };
}

function tableRow(over: Partial<TableWithTab> = {}): TableWithTab {
  return {
    id: 'table-1',
    table_number: 5,
    status: 'occupied',
    can_close: true,
    tab: {
      id: 'tab-1',
      status: 'settled',
      total: 200,
      unpaid_total: 0,
      orders: [
        {
          id: 'order-1',
          order_number: 41,
          total: 200,
          status: 'completed',
          payment_status: 'paid',
          items: [],
          placed_at: PLACED_AT,
          can_settle_card: false,
          can_settle_cash: false,
          card_payment_in_flight: false,
          card_in_flight_seconds: null,
        },
      ],
    },
    ...over,
  };
}

/** Everything is finished, everything is paid, nothing is cooking. This must close. */
function closeable(over: Partial<CloseTableSnapshot> = {}): CloseTableSnapshot {
  return {
    table: tableRow(),
    lines: linesPayload(),
    cardInFlightTimeoutSeconds: 120,
    unsentRoundLineCount: 0,
    ...over,
  };
}

describe('the baseline', () => {
  it('closes a finished, settled, all-ready table', () => {
    expect(evaluateCloseTableRefusals(closeable())).toEqual([]);
    expect(canCloseTable(closeable())).toBe(true);
  });

  it('has a rule id for every rule, with no duplicates', () => {
    const ids = CLOSE_TABLE_REFUSAL_RULES.map(rule => rule.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('SETTLING IS NOT CLOSING', () => {
  /**
   * The load-bearing one. A settled tab is what a table looks like at the end of service, and if
   * anything in the refusal set treated settlement as a blocker the control would be unusable on
   * exactly the tables it exists for.
   */
  it('a settled tab is still closeable', () => {
    const snapshot = closeable({
      table: tableRow({
        tab: {
          id: 'tab-1',
          status: 'settled',
          total: 200,
          unpaid_total: 0,
          orders: [
            {
              id: 'order-1',
              order_number: 41,
              total: 200,
              status: 'completed',
              payment_status: 'paid',
              items: [],
              placed_at: PLACED_AT,
              card_payment_in_flight: false,
              card_in_flight_seconds: null,
            },
          ],
        },
      }),
      lines: linesPayload({
        tab: {
          id: 'tab-1',
          table_number: 5,
          status: 'settled',
          total: 200,
          opened_at: PLACED_AT,
          opened_by_user_id: 'user-1',
        },
      }),
    });
    expect(evaluateCloseTableRefusals(snapshot)).toEqual([]);
  });

  /**
   * The converse, and the reason the phrase "paid is not closed" is worth a test. Money having
   * arrived says nothing about whether the food has. A tab that is fully paid with a line still
   * outstanding is refused, and the reason given is the food, not the money.
   */
  it('a fully paid tab is still refused while a line is outstanding', () => {
    const snapshot = closeable({
      lines: linesPayload({
        orders: [
          {
            order_id: 'order-1',
            order_number: 41,
            order_instructions: null,
            order_total: 200,
            placed_at: PLACED_AT,
            seconds_since_placed: 60,
            lines: [line({is_ready: false, kitchen_state: 'outstanding'})],
          },
        ],
        summary: {total_lines: 1, outstanding: 1, ready: 0, voided: 0},
        all_ready: false,
      }),
    });
    expect(evaluateCloseTableRefusals(snapshot)).toEqual(['OUTSTANDING_LINE']);
  });
});

describe('each rule refuses on its own condition', () => {
  it('TABLE_UNKNOWN — the money view did not load', () => {
    expect(evaluateCloseTableRefusals(closeable({table: null}))).toContain(
      'TABLE_UNKNOWN',
    );
  });

  it('LINES_UNKNOWN — the fulfilment view did not load', () => {
    expect(evaluateCloseTableRefusals(closeable({lines: null}))).toContain(
      'LINES_UNKNOWN',
    );
  });

  it('TAB_STATUS_UNKNOWN — the server named no tab status', () => {
    const snapshot = closeable({
      lines: linesPayload({
        tab: {
          id: 'tab-1',
          table_number: 5,
          status: '',
          total: 200,
          opened_at: PLACED_AT,
          opened_by_user_id: 'user-1',
        },
      }),
    });
    expect(evaluateCloseTableRefusals(snapshot)).toEqual(['TAB_STATUS_UNKNOWN']);
  });

  it('SERVER_REFUSES — can_close is false', () => {
    const snapshot = closeable({table: tableRow({can_close: false})});
    expect(evaluateCloseTableRefusals(snapshot)).toEqual(['SERVER_REFUSES']);
  });

  it('SERVER_REFUSES — an older server that omits can_close entirely still refuses', () => {
    const row = tableRow();
    // Modelling a response that predates the field: absent, not false.
    delete (row as Partial<TableWithTab>).can_close;
    expect(evaluateCloseTableRefusals(closeable({table: row}))).toEqual([
      'SERVER_REFUSES',
    ]);
  });

  it('UNPAID_BALANCE — the tab still owes money', () => {
    const snapshot = closeable({
      table: tableRow({
        tab: {...tableRow().tab!, unpaid_total: 45.5},
      }),
    });
    expect(evaluateCloseTableRefusals(snapshot)).toContain('UNPAID_BALANCE');
  });

  it.each(['unpaid', 'pending', 'cash_pending', 'failed'])(
    'ORDER_OWES_MONEY — an order sitting at %s',
    status => {
      const base = tableRow();
      const snapshot = closeable({
        table: tableRow({
          tab: {
            ...base.tab!,
            orders: [{...base.tab!.orders[0], payment_status: status}],
          },
        }),
      });
      expect(evaluateCloseTableRefusals(snapshot)).toContain('ORDER_OWES_MONEY');
    },
  );

  it('CARD_PAYMENT_IN_FLIGHT — the server flags a live card charge', () => {
    const base = tableRow();
    const snapshot = closeable({
      table: tableRow({
        tab: {
          ...base.tab!,
          orders: [
            {
              ...base.tab!.orders[0],
              card_payment_in_flight: true,
              card_in_flight_seconds: 15,
            },
          ],
        },
      }),
    });
    expect(evaluateCloseTableRefusals(snapshot)).toContain(
      'CARD_PAYMENT_IN_FLIGHT',
    );
    expect(evaluateCloseTableRefusals(snapshot)).not.toContain(
      'CARD_PAYMENT_STUCK',
    );
  });

  /**
   * The projection is OPTIONAL on the type. An older worker omits it, and an absent boolean read
   * as false is how a live card charge becomes invisible — so the underlying payment_status is
   * checked as well.
   */
  it('CARD_PAYMENT_IN_FLIGHT — terminal_pending alone is enough, with no projection field', () => {
    const base = tableRow();
    const snapshot = closeable({
      table: tableRow({
        tab: {
          ...base.tab!,
          orders: [
            {
              id: 'order-1',
              order_number: 41,
              total: 200,
              status: 'confirmed',
              payment_status: 'terminal_pending',
              items: [],
              placed_at: PLACED_AT,
            },
          ],
        },
      }),
    });
    expect(evaluateCloseTableRefusals(snapshot)).toContain(
      'CARD_PAYMENT_IN_FLIGHT',
    );
  });

  it('CARD_PAYMENT_IN_FLIGHT — an unknown timeout reads as still live, not as stuck', () => {
    const base = tableRow();
    const snapshot = closeable({
      cardInFlightTimeoutSeconds: null,
      table: tableRow({
        tab: {
          ...base.tab!,
          orders: [
            {
              ...base.tab!.orders[0],
              payment_status: 'terminal_pending',
              card_payment_in_flight: true,
              card_in_flight_seconds: 9999,
            },
          ],
        },
      }),
    });
    const found = evaluateCloseTableRefusals(snapshot);
    expect(found).toContain('CARD_PAYMENT_IN_FLIGHT');
    expect(found).not.toContain('CARD_PAYMENT_STUCK');
  });

  it('CARD_PAYMENT_STUCK — in flight longer than the server allows', () => {
    const base = tableRow();
    const snapshot = closeable({
      cardInFlightTimeoutSeconds: 120,
      table: tableRow({
        tab: {
          ...base.tab!,
          orders: [
            {
              ...base.tab!.orders[0],
              payment_status: 'terminal_pending',
              card_payment_in_flight: true,
              card_in_flight_seconds: 121,
            },
          ],
        },
      }),
    });
    const found = evaluateCloseTableRefusals(snapshot);
    expect(found).toContain('CARD_PAYMENT_STUCK');
    expect(found).not.toContain('CARD_PAYMENT_IN_FLIGHT');
  });

  it('OUTSTANDING_LINE — a line the server does not call ready', () => {
    const snapshot = closeable({
      lines: linesPayload({
        orders: [
          {
            order_id: 'order-1',
            order_number: 41,
            order_instructions: null,
            order_total: 200,
            placed_at: PLACED_AT,
            seconds_since_placed: 120,
            lines: [line({is_ready: false})],
          },
        ],
        all_ready: false,
      }),
    });
    expect(evaluateCloseTableRefusals(snapshot)).toContain('OUTSTANDING_LINE');
  });

  it('OUTSTANDING_LINE — a VOIDED unready line is not outstanding', () => {
    const snapshot = closeable({
      lines: linesPayload({
        orders: [
          {
            order_id: 'order-1',
            order_number: 41,
            order_instructions: null,
            order_total: 200,
            placed_at: PLACED_AT,
            seconds_since_placed: 120,
            lines: [line({is_ready: false, is_voided: true})],
          },
        ],
      }),
    });
    expect(evaluateCloseTableRefusals(snapshot)).toEqual([]);
  });

  it('UNROUTED_LINE — an item that reached no station', () => {
    const snapshot = closeable({
      lines: linesPayload({
        orders: [
          {
            order_id: 'order-1',
            order_number: 41,
            order_instructions: null,
            order_total: 200,
            placed_at: PLACED_AT,
            seconds_since_placed: 120,
            lines: [line({unrouted: true, route_to: null})],
          },
        ],
      }),
    });
    expect(evaluateCloseTableRefusals(snapshot)).toContain('UNROUTED_LINE');
  });

  it('LINE_TRACKING_UNAVAILABLE — a QR or pre-migration tab that tracks nothing', () => {
    const snapshot = closeable({
      lines: linesPayload({has_lines: false, orders: [], all_ready: false}),
    });
    expect(evaluateCloseTableRefusals(snapshot)).toEqual([
      'LINE_TRACKING_UNAVAILABLE',
    ]);
  });

  it('UNSENT_ROUND_ON_DEVICE — this terminal is holding an unsent basket', () => {
    expect(
      evaluateCloseTableRefusals(closeable({unsentRoundLineCount: 2})),
    ).toEqual(['UNSENT_ROUND_ON_DEVICE']);
  });
});

describe('every reason is reported, not just the first', () => {
  it('lists an unpaid balance AND outstanding food together', () => {
    const base = tableRow();
    const snapshot = closeable({
      table: tableRow({
        tab: {
          ...base.tab!,
          unpaid_total: 200,
          orders: [{...base.tab!.orders[0], payment_status: 'unpaid'}],
        },
      }),
      lines: linesPayload({
        orders: [
          {
            order_id: 'order-1',
            order_number: 41,
            order_instructions: null,
            order_total: 200,
            placed_at: PLACED_AT,
            seconds_since_placed: 120,
            lines: [line({is_ready: false})],
          },
        ],
        all_ready: false,
      }),
    });
    expect(evaluateCloseTableRefusals(snapshot)).toEqual([
      'UNPAID_BALANCE',
      'ORDER_OWES_MONEY',
      'OUTSTANDING_LINE',
    ]);
  });
});

describe('findTableRow', () => {
  it('returns null rather than undefined when the table is absent', () => {
    expect(findTableRow([tableRow()], 'nope')).toBeNull();
    expect(findTableRow(null, 'table-1')).toBeNull();
  });

  it('finds the row by id', () => {
    expect(findTableRow([tableRow()], 'table-1')?.id).toBe('table-1');
  });
});
