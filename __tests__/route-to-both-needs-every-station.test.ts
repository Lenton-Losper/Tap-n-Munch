/**
 * A `route_to: 'both'` line is NOT ready until EVERY owning station has finished.
 *
 * ============================================================================================
 * WHY THIS FILE EXISTS
 * ============================================================================================
 *
 * Reported 2026-09-01 as "the P5 is stale": the Bar board moved Table 3's 4x Coffee to
 * WAITING FOR COLLECTION, and the terminal kept showing "Being made" with Ready = 0.
 *
 * Nothing was stale. The line was
 *
 *     route_to: 'both', kitchen_state: 'outstanding', bar_state: 'ready'
 *
 * and the live endpoint returned is_ready:false / summary.ready:0 — exactly what the terminal
 * displayed. The bar had finished its half; the kitchen had not started its own. isLineReady
 * requires both, and that is correct.
 *
 * ============================================================================================
 * THE TEST GAP THIS CLOSES, WHICH IS THE REAL LESSON
 * ============================================================================================
 *
 * The live verification that shipped hours earlier passed every hop — and could not have caught
 * this. Its fixture used SINGLE-station lines:
 *
 *     kitchen line: route_to 'kitchen', bar_state NULL
 *     bar line    : route_to 'bar',     kitchen_state NULL
 *
 * isLineReady coalesces a NULL state to 'ready' (a station that does not own the line cannot
 * hold it back), so one bump made those lines ready. Meanwhile 13 of 13 production order_lines
 * were `both`. The fixture was the one shape that did not exist in production, chosen because it
 * made each assertion clean.
 *
 * So this file pins BOTH shapes deliberately: the 'both' line that one station cannot release,
 * and the single-station line that one station can. A fixture is not representative because it
 * is convenient; it is representative when its distribution matches the rows.
 */
import { isLineReady, stationsOwnedBy, initialStatesFor } from '@/lib/orders/order-lines'

describe("route_to 'both': one station alone does NOT make the line ready", () => {
  it('bar finished, kitchen still outstanding -> NOT ready (the reported Coffee)', () => {
    expect(isLineReady({ kitchen_state: 'outstanding', bar_state: 'ready' })).toBe(false)
  })

  it('kitchen finished, bar still outstanding -> NOT ready (the mirror case)', () => {
    expect(isLineReady({ kitchen_state: 'ready', bar_state: 'outstanding' })).toBe(false)
  })

  it('bar ready while the kitchen has only COOKED it -> still NOT ready', () => {
    // 'cooked' is the station's own done, not the pass's. It must not release the line.
    expect(isLineReady({ kitchen_state: 'cooked', bar_state: 'ready' })).toBe(false)
  })

  it('both stations ready -> ready', () => {
    expect(isLineReady({ kitchen_state: 'ready', bar_state: 'ready' })).toBe(true)
  })

  it("'collected' counts as past-ready, never as a step back", () => {
    expect(isLineReady({ kitchen_state: 'collected', bar_state: 'ready' })).toBe(true)
    expect(isLineReady({ kitchen_state: 'collected', bar_state: 'collected' })).toBe(true)
  })

  it("a 'both' line is owned by both stations and starts outstanding on each", () => {
    expect(stationsOwnedBy('both')).toEqual(['kitchen', 'bar'])
    expect(initialStatesFor('both')).toEqual({
      kitchen_state: 'outstanding',
      bar_state: 'outstanding',
    })
  })
})

describe('single-station lines: the production-shaped fixture correct routing produces', () => {
  it("a 'bar' line (Drinks -> bar) is ready on the bar bump alone", () => {
    // What Digi Cofee's Coffee becomes now that Drinks routes to 'bar'. The NULL kitchen_state
    // is the whole point: a station that does not own the line cannot hold it back.
    expect(initialStatesFor('bar')).toEqual({ kitchen_state: null, bar_state: 'outstanding' })
    expect(isLineReady({ kitchen_state: null, bar_state: 'outstanding' })).toBe(false)
    expect(isLineReady({ kitchen_state: null, bar_state: 'ready' })).toBe(true)
  })

  it("a 'kitchen' line (Lunch meals -> kitchen) is ready on the kitchen bump alone", () => {
    expect(initialStatesFor('kitchen')).toEqual({ kitchen_state: 'outstanding', bar_state: null })
    expect(isLineReady({ kitchen_state: 'outstanding', bar_state: null })).toBe(false)
    expect(isLineReady({ kitchen_state: 'ready', bar_state: null })).toBe(true)
  })

  it("'unrouted' behaves like 'both' — it is owned by everyone until someone routes it", () => {
    expect(stationsOwnedBy('unrouted')).toEqual(['kitchen', 'bar'])
    expect(isLineReady({ kitchen_state: 'outstanding', bar_state: 'ready' })).toBe(false)
  })
})
