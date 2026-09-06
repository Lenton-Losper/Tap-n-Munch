/**
 * getTabLines MUST CARRY EVERY FIELD THE PAYLOAD TYPE DECLARES.
 *
 * ================================================================================================
 * THE BUG THIS EXISTS TO MAKE IMPOSSIBLE
 * ================================================================================================
 *
 * getTabLines rebuilds the payload field-by-field. It is a WHITELIST, so a field it does not name
 * is silently discarded — and every additive field on TabLine is optional, precisely so an older
 * server can omit it. Those two facts together mean a dropped field STILL TYPECHECKS. tsc is blind
 * to it by construction.
 *
 * It shipped in 2.26 / build 127 with five line fields and three summary fields missing, and cost
 * two defects at Digi Cofee on 2026-09-06:
 *
 *   `total_cents` -> every line unselectable, "No price — settle this order whole", Take Payment
 *                    unusable and the cash button dead.
 *   `is_cooked`   -> the kitchen board says Cooked, the terminal says "Being made", forever.
 *
 * Both were client-side. The server sent the fields; this function threw them away.
 *
 * ================================================================================================
 * WHY A TEST AND NOT A SCHEMA — THE CHEAPER OF THE TWO, AND THE ONE THAT FITS
 * ================================================================================================
 *
 * The alternative was to derive the mapper from the type, which in TypeScript means inverting the
 * dependency: a runtime schema (zod or similar) becomes the source of truth and the type is
 * inferred from it. That is the stronger guarantee and it is the wrong trade here:
 *
 *   - It adds a runtime dependency to an APK for a parsing problem in one function.
 *   - TabLine is not a plain data shape. Its fields carry DELIBERATE, DOCUMENTED coercions —
 *     `is_ready: line.is_ready === true` defaults false and never true, `total_cents` keeps null
 *     distinct from absent, an absent station must stay absent rather than become 0 of 0. A schema
 *     would have to re-express every one of those, and the rewrite would land on a money path.
 *   - It would replace ~40 lines of heavily-commented mapper with a schema whose comments have
 *     nowhere to live.
 *
 * This suite gets the same guarantee for the failure that actually happened, at the cost of one
 * file and no dependency: the type stays the contract, and the mapper is measured against it.
 *
 * ================================================================================================
 * HOW IT WORKS — TWO ASSERTIONS, AND BOTH ARE LOAD-BEARING
 * ================================================================================================
 *
 *   1. THE FIXTURE NAMES EVERY DECLARED FIELD. Field names are read out of tabLines.ts itself, so
 *      adding a field to the type and not to the fixture fails HERE.
 *   2. EVERY FIXTURE FIELD SURVIVES THE REAL MAPPER, with its value intact. Dropping a field from
 *      the mapper fails THERE.
 *
 * Assertion 1 without 2 proves nothing about the mapper. Assertion 2 without 1 rots the moment
 * somebody adds a field. Together they close the loop, and neither is a marker-string test: both
 * assert over data that came out of the function.
 */
import {withApi} from './helpers/apiHarness';

/**
 * `require`, not `import`, and not 'node:fs'. This project's tsconfig carries no @types/node — the
 * app is React Native — so the node: specifiers do not resolve under tsc even though jest runs
 * them happily. A suite that passes while tsc is red is how a red build gets ignored.
 */
// eslint-disable-next-line @typescript-eslint/no-var-requires
const {readFileSync} = require('fs') as {readFileSync: (p: string, e: string) => string};
// eslint-disable-next-line @typescript-eslint/no-var-requires

/**
 * Resolved through require.resolve rather than __dirname, which is also undeclared without
 * @types/node. This asks the module system where tabLines actually is, so the path cannot drift
 * if the file moves.
 */
const TYPES_PATH = (require as unknown as {resolve: (m: string) => string}).resolve('../tabLines');
const TYPES_SRC = stripComments(readFileSync(TYPES_PATH, 'utf8'));

function stripComments(s: string): string {
  return s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

/**
 * The property names declared directly inside a block — depth 1 only, so the inline object in
 * `allocations: Array<{...}>` does not leak its own keys into TabLine's list.
 */
function fieldsInBlock(body: string): string[] {
  const out: string[] = [];
  let depth = 0;
  for (const rawLine of body.split('\n')) {
    const line = rawLine.trim();
    const match = /^([A-Za-z_][A-Za-z0-9_]*)\??\s*:/.exec(line);
    if (depth === 0 && match) out.push(match[1]);
    depth += (rawLine.match(/[{[]/g) ?? []).length;
    depth -= (rawLine.match(/[}\]]/g) ?? []).length;
    if (depth < 0) depth = 0;
  }
  return out;
}

/** The body of `export interface <name> { ... }`, brace-matched. */
function interfaceBody(name: string): string {
  const start = TYPES_SRC.indexOf(`export interface ${name} {`);
  expect(start).toBeGreaterThan(-1);
  const open = TYPES_SRC.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < TYPES_SRC.length; i += 1) {
    if (TYPES_SRC[i] === '{') depth += 1;
    else if (TYPES_SRC[i] === '}') {
      depth -= 1;
      if (depth === 0) return TYPES_SRC.slice(open + 1, i);
    }
  }
  throw new Error(`unterminated interface ${name}`);
}

const declared = {
  line: fieldsInBlock(interfaceBody('TabLine')),
  summary: fieldsInBlock(interfaceBody('TabLineSummary')),
  order: fieldsInBlock(interfaceBody('TabLineOrder')),
  payload: fieldsInBlock(interfaceBody('TabLinesPayload')),
  station: fieldsInBlock(interfaceBody('StationCookedProgress')),
};

/**
 * EVERY declared field, populated with a distinctive value. Distinctive matters: a mapper that
 * hardcoded `quantity: 0` would pass an existence check and fail this.
 */
const SERVER_LINE = {
  id: 'line-1',
  name_snapshot: 'Beef Fillet',
  quantity: 3,
  line_note: 'no onions',
  route_to: 'kitchen',
  kitchen_state: 'cooked',
  bar_state: null,
  is_ready: false,
  is_collected: true,
  total_cents: 12345,
  allocated_cents: 500,
  allocations: [
    {
      id: 'alloc-1',
      allocated_to: 'guest-2',
      quantity_allocated: 1,
      amount_cents: 500,
      settled_at: null,
    },
  ],
  is_cooked: true,
  is_voided: false,
  unrouted: false,
};

const SERVER_SUMMARY = {
  total_lines: 9,
  outstanding: 4,
  ready: 2,
  collected: 1,
  voided: 2,
  kitchen: {cooked: 3, total: 5},
  bar: {cooked: 1, total: 4},
};

const SERVER_ORDER = {
  order_id: 'order-1',
  order_number: 44,
  order_instructions: 'allergy: shellfish',
  order_total: 34,
  placed_at: '2026-09-06T09:48:08.192Z',
  seconds_since_placed: 612,
  lines: [SERVER_LINE],
};

const SERVER_PAYLOAD = {
  tab: {
    id: 'tab-1',
    table_number: 7,
    status: 'open',
    total: 34,
    opened_at: '2026-09-06T09:40:00.000Z',
    opened_by_user_id: 'user-3',
  },
  orders: [SERVER_ORDER],
  summary: SERVER_SUMMARY,
  all_ready: false,
  has_lines: true,
  server_time: '2026-09-06T09:58:20.000Z',
};

describe('the fixture keeps up with the type', () => {
  it('names every field TabLine declares', () => {
    // Add a field to TabLine and not here, and this is where you find out.
    expect(Object.keys(SERVER_LINE).sort()).toEqual([...declared.line].sort());
  });

  it('names every field TabLineSummary declares', () => {
    expect(Object.keys(SERVER_SUMMARY).sort()).toEqual([...declared.summary].sort());
  });

  it('names every field TabLineOrder declares', () => {
    expect(Object.keys(SERVER_ORDER).sort()).toEqual([...declared.order].sort());
  });

  it('names every field TabLinesPayload declares', () => {
    expect(Object.keys(SERVER_PAYLOAD).sort()).toEqual([...declared.payload].sort());
  });

  it('reads real field names out of the type, not an empty list', () => {
    /**
     * The extractor is the instrument, and an instrument that silently returns [] would make every
     * assertion above pass against a fixture of anything at all. Checked against fields that are
     * definitely declared, including the two whose absence caused the defects.
     */
    expect(declared.line).toEqual(expect.arrayContaining(['total_cents', 'is_cooked', 'id']));
    expect(declared.line.length).toBeGreaterThan(10);
    expect(declared.summary).toEqual(expect.arrayContaining(['kitchen', 'collected']));
    expect(declared.station).toEqual(['cooked', 'total']);
    // Depth-1 only: the inline allocation object must NOT leak its keys into TabLine.
    expect(declared.line).not.toContain('allocated_to');
    expect(declared.line).not.toContain('amount_cents');
  });
});

describe('the mapper carries every field, with its value', () => {
  it('carries every line field the server sent', async () => {
    await withApi({status: 200, body: SERVER_PAYLOAD}, async api => {
      const out = await api.getTabLines('tab-1', 'jwt');
      const line = out.orders[0].lines[0] as unknown as Record<string, unknown>;

      // The whole point, stated as one comparison: nothing the server sent went missing.
      expect(Object.keys(line).sort()).toEqual(Object.keys(SERVER_LINE).sort());
      expect(line).toEqual(SERVER_LINE);
    });
  });

  it('carries every summary field the server sent', async () => {
    await withApi({status: 200, body: SERVER_PAYLOAD}, async api => {
      const out = await api.getTabLines('tab-1', 'jwt');
      expect(Object.keys(out.summary).sort()).toEqual(Object.keys(SERVER_SUMMARY).sort());
      expect(out.summary).toEqual(SERVER_SUMMARY);
    });
  });

  it('carries the tab, the order and the top level', async () => {
    await withApi({status: 200, body: SERVER_PAYLOAD}, async api => {
      const out = await api.getTabLines('tab-1', 'jwt');
      expect(out.tab).toEqual(SERVER_PAYLOAD.tab);
      expect(out.all_ready).toBe(false);
      expect(out.has_lines).toBe(true);
      expect(out.server_time).toBe(SERVER_PAYLOAD.server_time);
      const {lines, ...orderRest} = out.orders[0];
      expect(orderRest).toEqual({
        order_id: 'order-1',
        order_number: 44,
        order_instructions: 'allergy: shellfish',
        order_total: 34,
        placed_at: SERVER_ORDER.placed_at,
        seconds_since_placed: 612,
      });
      expect(lines).toHaveLength(1);
    });
  });
});

describe('an older server is still handled exactly as before', () => {
  /**
   * The reason every additive field is optional. A server predating the split sends none of them,
   * and `undefined` must behave as this app behaved before — NOT become false or 0, which would
   * turn "this server does not report it" into a confident claim.
   */
  const OLD_LINE = {
    id: 'line-1',
    name_snapshot: 'Beef Fillet',
    quantity: 3,
    line_note: null,
    route_to: 'kitchen',
    kitchen_state: 'outstanding',
    bar_state: null,
    is_ready: false,
    is_voided: false,
    unrouted: false,
  };

  const OLD_PAYLOAD = {
    ...SERVER_PAYLOAD,
    orders: [{...SERVER_ORDER, lines: [OLD_LINE]}],
    summary: {total_lines: 1, outstanding: 1, ready: 0, voided: 0},
  };

  it('leaves the additive line fields ABSENT rather than defaulting them', async () => {
    await withApi({status: 200, body: OLD_PAYLOAD}, async api => {
      const out = await api.getTabLines('tab-1', 'jwt');
      const line = out.orders[0].lines[0];
      for (const field of ['is_collected', 'is_cooked', 'total_cents', 'allocated_cents', 'allocations'] as const) {
        expect({field, present: field in line}).toEqual({field, present: false});
      }
    });
  });

  it('leaves an absent station absent, never 0 of 0', async () => {
    // cookedProgress() suppresses an absent station. {cooked: 0, total: 0} would instead render
    // "Kitchen 0 of 0 plated" — a claim the payload explicitly declines to make.
    await withApi({status: 200, body: OLD_PAYLOAD}, async api => {
      const out = await api.getTabLines('tab-1', 'jwt');
      expect('kitchen' in out.summary).toBe(false);
      expect('bar' in out.summary).toBe(false);
      expect('collected' in out.summary).toBe(false);
    });
  });
});

describe('the two values the defects turned on', () => {
  it('a null price stays null and never becomes zero', async () => {
    /**
     * null is a REAL answer — the server could not price the line — and is not the same as the
     * field being absent. Zero would read as a free item and split cleanly into nothing.
     */
    const body = {
      ...SERVER_PAYLOAD,
      orders: [{...SERVER_ORDER, lines: [{...SERVER_LINE, total_cents: null}]}],
    };
    await withApi({status: 200, body}, async api => {
      const out = await api.getTabLines('tab-1', 'jwt');
      const line = out.orders[0].lines[0];
      expect('total_cents' in line).toBe(true);
      expect(line.total_cents).toBeNull();
      expect(line.total_cents).not.toBe(0);
    });
  });

  it('a priced line arrives priced, which is what Take Payment needs', async () => {
    await withApi({status: 200, body: SERVER_PAYLOAD}, async api => {
      const out = await api.getTabLines('tab-1', 'jwt');
      expect(out.orders[0].lines[0].total_cents).toBe(12345);
      expect(out.orders[0].lines[0].is_cooked).toBe(true);
    });
  });
});
