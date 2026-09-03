/**
 * Cooked progress, and the half-voided display gap.
 *
 * Two changes that ship together, both display-only. Neither touches the Realtime mechanism, the
 * server's buckets, or `all_ready`.
 *
 * THE HALF-VOIDED CASE IS THE ONE WITH A VICTIM. An amend voids only the stations that have not
 * finished, so a both-routed line can come back kitchen='voided', bar='ready'. The server keeps it
 * in `outstanding` ("a half-voided line is still work"), and the old partialProgress read that as
 * "Bar ready · Kitchen waiting" — telling a waiter to expect food that had been cancelled.
 */
import {
  lineDisplayState,
  partialProgress,
  cookedProgress,
  type TabLine,
  type TabLinesPayload,
} from '../tabLines';

const line = (over: Partial<TabLine>): TabLine => ({
  id: 'l1',
  name_snapshot: 'Cheese toast',
  quantity: 1,
  line_note: null,
  route_to: 'both',
  kitchen_state: 'outstanding',
  bar_state: 'outstanding',
  is_ready: false,
  is_voided: false,
  unrouted: false,
  ...over,
});

describe('lineDisplayState — cooked sits between ready and making', () => {
  it('reports cooked when the server says so', () => {
    expect(lineDisplayState(line({is_cooked: true}))).toBe('cooked');
  });

  it('READY OUTRANKS COOKED — a plated dish must never read as collectable', () => {
    // The pass has not passed it. Promoting cooked would send a waiter to an empty counter.
    expect(lineDisplayState(line({is_ready: true, is_cooked: true}))).toBe('ready');
  });

  it('voided and collected still outrank cooked', () => {
    expect(lineDisplayState(line({is_voided: true, is_cooked: true}))).toBe('voided');
    expect(lineDisplayState(line({is_collected: true, is_cooked: true}))).toBe('collected');
  });

  it('an older server that sends no is_cooked behaves exactly as before', () => {
    // undefined must be the old behaviour, never a crash and never a new state.
    expect(lineDisplayState(line({}))).toBe('making');
    expect(lineDisplayState(line({is_ready: true}))).toBe('ready');
  });
});

describe('partialProgress — a cancelled station is not a waiting station', () => {
  it('kitchen cancelled, bar ready: says CANCELLED, not waiting', () => {
    // The exact shape an amend produces on a both-routed line the bar had already poured.
    expect(
      partialProgress(line({kitchen_state: 'voided', bar_state: 'ready'})),
    ).toBe('kitchen_cancelled_bar_ready');
  });

  it('bar cancelled, kitchen ready: the mirror case', () => {
    expect(
      partialProgress(line({kitchen_state: 'ready', bar_state: 'voided'})),
    ).toBe('bar_cancelled_kitchen_ready');
  });

  it('kitchen cancelled while the bar is still working', () => {
    expect(
      partialProgress(line({kitchen_state: 'voided', bar_state: 'outstanding'})),
    ).toBe('kitchen_cancelled');
  });

  it('bar cancelled while the kitchen is still working', () => {
    expect(
      partialProgress(line({kitchen_state: 'outstanding', bar_state: 'voided'})),
    ).toBe('bar_cancelled');
  });

  it('a cancelled station is never described as waiting', () => {
    // The regression guard. Before the fix this returned 'bar_ready', which renders
    // "Bar ready · Kitchen waiting" over a kitchen half that had been cancelled.
    const p = partialProgress(line({kitchen_state: 'voided', bar_state: 'ready'}));
    expect(p).not.toBe('bar_ready');
    expect(p).not.toBe('kitchen_ready');
  });

  it('still reports an ordinary half-finished line unchanged', () => {
    expect(
      partialProgress(line({kitchen_state: 'ready', bar_state: 'outstanding'})),
    ).toBe('kitchen_ready');
    expect(
      partialProgress(line({kitchen_state: 'outstanding', bar_state: 'ready'})),
    ).toBe('bar_ready');
  });

  it('a cooked half is NOT finished — the pass has not taken it', () => {
    expect(
      partialProgress(line({kitchen_state: 'cooked', bar_state: 'outstanding'})),
    ).toBeNull();
  });

  it('says nothing when the server has already ruled', () => {
    expect(partialProgress(line({is_ready: true}))).toBeNull();
    expect(partialProgress(line({is_voided: true}))).toBeNull();
    expect(partialProgress(line({is_collected: true}))).toBeNull();
  });

  it('a single-station line has no partial state', () => {
    expect(partialProgress(line({kitchen_state: 'outstanding', bar_state: null}))).toBeNull();
  });
});

const payload = (summary: Partial<TabLinesPayload['summary']>): TabLinesPayload =>
  ({
    tab: {} as TabLinesPayload['tab'],
    orders: [],
    summary: {total_lines: 0, outstanding: 0, ready: 0, voided: 0, ...summary},
    all_ready: false,
    has_lines: true,
    server_time: null,
  } as TabLinesPayload);

describe('cookedProgress — a count, split by station', () => {
  it('reports each station separately', () => {
    const p = cookedProgress(payload({kitchen: {cooked: 3, total: 4}, bar: {cooked: 0, total: 2}}));
    expect(p.kitchen).toEqual({cooked: 3, total: 4});
    expect(p.bar).toEqual({cooked: 0, total: 2});
  });

  it('keeps zero-of-N — "the kitchen has not started" is a real answer', () => {
    expect(cookedProgress(payload({kitchen: {cooked: 0, total: 4}})).kitchen).toEqual({
      cooked: 0,
      total: 4,
    });
  });

  it('suppresses a station with no work rather than rendering "0 of 0"', () => {
    expect(cookedProgress(payload({kitchen: {cooked: 0, total: 0}})).kitchen).toBeNull();
  });

  it('an older server sending no station fields renders nothing', () => {
    const p = cookedProgress(payload({}));
    expect(p.kitchen).toBeNull();
    expect(p.bar).toBeNull();
  });

  it('is safe on a null payload', () => {
    expect(cookedProgress(null)).toEqual({kitchen: null, bar: null});
  });
});
