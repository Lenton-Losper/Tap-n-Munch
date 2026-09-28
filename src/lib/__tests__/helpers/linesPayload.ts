/**
 * Builders for the tab lines payload -- the MONEY BASIS every settle amount is now computed from
 * (lib/settlementAmount.ts, sprint 2026-09-28).
 *
 * Lives under `helpers/` so jest does not collect it as a suite (see apiHarness.ts).
 */
import type {MoneyCents, TabFinancials, TabLine, TabLinesPayload} from '../../tabLines';

/**
 * A payload that was READ and carries no lines: every order on it owes its total. The basis the
 * pre-sprint tests implicitly assumed when they passed no lines at all.
 */
export function noLinesPayload(financials?: TabFinancials): TabLinesPayload {
  return {
    tab: {
      id: 'tab-1',
      table_number: 1,
      status: 'open',
      total: 0,
      opened_at: null,
      opened_by_user_id: null,
    },
    orders: [],
    summary: {total_lines: 0, outstanding: 0, ready: 0, voided: 0},
    all_ready: false,
    has_lines: false,
    server_time: null,
    ...(financials ? {financials} : {}),
  };
}

export type LineSpec = {
  id?: string;
  name?: string;
  quantity?: number;
  /** Integer cents. `null` = the server could not price it; omit for a pre-split server. */
  cents?: number | null;
  voided?: boolean;
  /** Settled allocation cents on this line. */
  settledCents?: number;
  /** Unsettled allocation cents on this line. */
  openCents?: number;
};

let seq = 0;

export function line(spec: LineSpec): TabLine {
  seq += 1;
  const id = spec.id ?? `line-${seq}`;
  const allocations: NonNullable<TabLine['allocations']> = [];
  if (spec.settledCents) {
    allocations.push({
      id: `${id}-s`,
      allocated_to: 'Table',
      quantity_allocated: 1,
      amount_cents: spec.settledCents,
      settled_at: '2026-09-28T10:00:00.000Z',
    });
  }
  if (spec.openCents) {
    allocations.push({
      id: `${id}-o`,
      allocated_to: 'Table',
      quantity_allocated: 1,
      amount_cents: spec.openCents,
      settled_at: null,
    });
  }
  return {
    id,
    name_snapshot: spec.name ?? id,
    quantity: spec.quantity ?? 1,
    line_note: null,
    route_to: 'kitchen',
    kitchen_state: spec.voided ? 'voided' : 'outstanding',
    bar_state: null,
    is_ready: false,
    is_voided: spec.voided === true,
    unrouted: false,
    ...(spec.cents === undefined ? {} : {total_cents: spec.cents}),
    allocations,
    allocated_cents: allocations.reduce((sum, a) => sum + a.amount_cents, 0),
  };
}

export function payloadWith(
  orders: Array<{id: string; number?: number; total: number; lines: TabLine[]}>,
  financials?: TabFinancials,
): TabLinesPayload {
  return {
    ...noLinesPayload(financials),
    has_lines: orders.some(o => o.lines.length > 0),
    orders: orders.map((o, i) => ({
      order_id: o.id,
      order_number: o.number ?? i + 1,
      order_instructions: null,
      order_total: o.total,
      placed_at: '2026-09-28T09:00:00.000Z',
      seconds_since_placed: 60,
      lines: o.lines,
    })),
  };
}

/** One C2 money block. Unspecified figures default from `live` so a test states only what it means. */
export function money(m: Partial<MoneyCents> & {original_cents: number}): MoneyCents {
  const voided = m.voided_cents ?? 0;
  const live = m.live_cents ?? Math.max(0, m.original_cents - voided);
  const paid = m.paid_cents ?? 0;
  return {
    original_cents: m.original_cents,
    voided_cents: voided,
    live_cents: live,
    paid_cents: paid,
    outstanding_cents: m.outstanding_cents ?? Math.max(0, live - paid),
    overpaid_cents: m.overpaid_cents ?? Math.max(0, paid - live),
  };
}
