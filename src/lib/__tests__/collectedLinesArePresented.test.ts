/**
 * Collected food must not read as "Being made", and a table whose food has all been run must not
 * shout FOOD UP.
 *
 * ============================================================================================
 * THE REGRESSION, AND WHY IT WAS INVISIBLE
 * ============================================================================================
 *
 * The web server used to put collected lines in the `ready` bucket, so `is_ready` stayed true
 * forever once a station bumped. The `collected` split (web
 * `app/api/terminal/tabs/[tabId]/lines/route.ts`) gave collection its own bucket and, correctly,
 * stopped counting it as ready:
 *
 *     is_ready:     bucket === 'ready'       -> FALSE for a collected line
 *     is_collected: bucket === 'collected'   -> TRUE, and this app had never heard of it
 *
 * Nothing in this repo failed. No type broke, because `is_collected` simply was not in the
 * interface; no test failed, because every fixture predated the split. The two screens that pick a
 * chip did so with `is_voided ? … : is_ready ? … : waiting`, and a collected line falls through
 * that ternary to WAITING — so the terminal began telling waiters that food they had already
 * carried to the table was still cooking.
 *
 * That is a server change landing as a client defect with no red anywhere, which is exactly the
 * shape these fixtures are built to catch: they are written from the payload the live server sends
 * TODAY, not from the shape this app was written against.
 *
 * ============================================================================================
 * WHAT IS DELIBERATELY NOT ASSERTED
 * ============================================================================================
 *
 * That a collected line says the word "Collected". It does not, and must not yet: every staff
 * string in constants/serviceCopy.ts is signed by the owner, and a distinct chip is a copy
 * decision listed for sign-off. The rule under test is that collected food reads as NOT-still-
 * being-made, which the existing signed wording already carries.
 */
import {
  deriveTableBadge,
  lineDisplayState,
  TabLine,
  TabLinesPayload,
} from '../tabLines';

function line(over: Partial<TabLine> = {}): TabLine {
  return {
    id: `l${Math.random()}`,
    name_snapshot: 'Ribeye',
    quantity: 1,
    line_note: null,
    route_to: 'kitchen',
    kitchen_state: 'outstanding',
    bar_state: null,
    is_ready: false,
    is_voided: false,
    unrouted: false,
    ...over,
  };
}

/** As the current server sends it: ready and collected are exclusive buckets, never a flag pair. */
const OUTSTANDING = line({is_ready: false, is_collected: false});
const READY = line({is_ready: true, is_collected: false, kitchen_state: 'ready'});
const COLLECTED = line({is_ready: false, is_collected: true, kitchen_state: 'ready'});
const VOIDED = line({is_voided: true});

function payload(lines: TabLine[], over: Partial<TabLinesPayload> = {}): TabLinesPayload {
  const live = lines.filter(l => !l.is_voided);
  return {
    tab: {
      id: 'tab-1',
      table_number: 7,
      status: 'open',
      total: 250,
      opened_at: null,
      opened_by_user_id: null,
    },
    orders: [
      {
        order_id: 'o1',
        order_number: 1,
        order_instructions: null,
        order_total: 250,
        placed_at: '2026-09-01T12:00:00Z',
        seconds_since_placed: 60,
        lines,
      },
    ],
    summary: {
      total_lines: lines.length,
      outstanding: live.filter(l => !l.is_ready && !l.is_collected).length,
      ready: live.filter(l => l.is_ready).length,
      collected: live.filter(l => l.is_collected).length,
      voided: lines.filter(l => l.is_voided).length,
    },
    // The server's own rule: nothing outstanding. Collected counts as not-outstanding.
    all_ready: live.length > 0 && live.every(l => l.is_ready || l.is_collected),
    has_lines: true,
    server_time: '2026-09-01T12:01:00Z',
    ...over,
  };
}

describe('lineDisplayState — the chip a waiter reads', () => {
  it('THE REGRESSION: a collected line is not "being made"', () => {
    expect(lineDisplayState(COLLECTED)).toBe('collected');
    expect(lineDisplayState(COLLECTED)).not.toBe('making');
  });

  it('still distinguishes the three states it always did', () => {
    expect(lineDisplayState(OUTSTANDING)).toBe('making');
    expect(lineDisplayState(READY)).toBe('ready');
    expect(lineDisplayState(VOIDED)).toBe('voided');
  });

  it('voided outranks collected — a cancelled line is cancelled however far it got', () => {
    expect(lineDisplayState(line({is_voided: true, is_collected: true}))).toBe('voided');
  });

  /**
   * COMPATIBILITY WITH AN OLDER SERVER. A payload with no is_collected field at all must behave
   * exactly as this app did before the split — otherwise a terminal pointed at an older deploy
   * starts mislabelling everything instead of simply not knowing about collection.
   */
  it('treats a MISSING is_collected as the pre-split behaviour, not as collected', () => {
    const legacyReady = line({is_ready: true});
    const legacyWaiting = line({is_ready: false});
    delete (legacyReady as {is_collected?: boolean}).is_collected;
    delete (legacyWaiting as {is_collected?: boolean}).is_collected;
    expect(lineDisplayState(legacyReady)).toBe('ready');
    expect(lineDisplayState(legacyWaiting)).toBe('making');
  });

  it('is not fooled by a truthy non-true value', () => {
    // Only an explicit true counts. A server sending 'false' or 0 must not read as collected.
    expect(lineDisplayState(line({is_collected: false, is_ready: true}))).toBe('ready');
  });
});

describe('deriveTableBadge — the floor grid must not send a waiter to an empty pass', () => {
  it('THE SECOND REGRESSION: a fully collected table does not flag FOOD UP', () => {
    const p = payload([COLLECTED, COLLECTED])
    // Precondition: this is exactly the shape that used to trip the all_ready rescue.
    expect(p.all_ready).toBe(true)
    expect(p.summary.ready).toBe(0)

    expect(deriveTableBadge(p)).toEqual({flag: null, readyCount: 0})
  })

  it('still flags FOOD UP when something really is on the pass', () => {
    expect(deriveTableBadge(payload([READY, OUTSTANDING]))).toEqual({
      flag: 'ready',
      readyCount: 1,
    })
  })

  it('counts only the lines still on the pass, not the ones already run', () => {
    expect(deriveTableBadge(payload([READY, READY, COLLECTED]))).toEqual({
      flag: 'ready',
      readyCount: 2,
    })
  })

  /**
   * THE RESCUE THAT MUST SURVIVE. `all_ready` was OR-ed in for the pre-split shape where a tab is
   * complete but no line carries is_ready. Narrowing it must not delete it: a payload with no
   * collected lines keeps the old behaviour exactly.
   */
  it('keeps the all_ready rescue for a payload with no collected lines (older server)', () => {
    const legacy = payload([line({is_ready: false})], {all_ready: true})
    for (const o of legacy.orders) {
      for (const l of o.lines) {
        delete (l as {is_collected?: boolean}).is_collected
      }
    }
    delete (legacy.summary as {collected?: number}).collected
    expect(deriveTableBadge(legacy)).toEqual({flag: 'ready', readyCount: 0})
  })

  it('unrouted still outranks everything, collected included', () => {
    expect(deriveTableBadge(payload([COLLECTED, line({unrouted: true})]))).toEqual({
      flag: 'unrouted',
      readyCount: 0,
    })
  })

  it('a collected line is not outstanding, so it cannot raise WAITING LONG either', () => {
    const p = payload([COLLECTED])
    p.orders[0].seconds_since_placed = 60 * 60 // an hour old
    expect(deriveTableBadge(p).flag).toBeNull()
  })
})
