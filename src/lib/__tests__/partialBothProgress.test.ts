/**
 * A `both` line that is half done says WHICH half — and can never say more than the server does.
 *
 * ============================================================================================
 * THE INCIDENT
 * ============================================================================================
 *
 * 2026-09-01, Digi Cofee. `4x Coffee` was routed to both stations. The bar poured it and bumped;
 * the kitchen had never started. The terminal showed "Being made" — true, and useless. It was
 * reported as a stale terminal. Nothing was stale: the device was holding
 * `bar_state: 'ready'` and `kitchen_state: 'outstanding'` and rendering neither.
 *
 * ============================================================================================
 * THE INVARIANT THAT MATTERS MOST
 * ============================================================================================
 *
 * `is_ready` is the SERVER's verdict and is never recomputed here. `partialProgress` answers a
 * narrower question the server does not answer — of the two stations that owe this line, which
 * one has finished — and it is consulted ONLY once the server has already said the line is
 * neither ready nor collected.
 *
 * So there is no arrangement of station states in which this can make a line look ready that the
 * kitchen does not consider ready. The tests below try to construct one anyway.
 */
import {partialProgress, TabLine} from '../tabLines';

function line(over: Partial<TabLine> = {}): TabLine {
  return {
    id: 'l1',
    name_snapshot: 'Coffee',
    quantity: 4,
    line_note: null,
    route_to: 'both',
    kitchen_state: 'outstanding',
    bar_state: 'outstanding',
    is_ready: false,
    is_voided: false,
    unrouted: false,
    ...over,
  };
}

describe('which half of a both line is still working', () => {
  it('THE INCIDENT: bar finished, kitchen has not', () => {
    expect(partialProgress(line({bar_state: 'ready', kitchen_state: 'outstanding'}))).toBe(
      'bar_ready',
    );
  });

  it('the mirror case: kitchen finished, bar has not', () => {
    expect(partialProgress(line({kitchen_state: 'ready', bar_state: 'outstanding'}))).toBe(
      'kitchen_ready',
    );
  });

  it('neither finished is not partial — it is just being made', () => {
    expect(partialProgress(line())).toBeNull();
  });

  /**
   * `cooked` is the STATION's done, not the pass's. A cooked dish is plated and still the
   * station's business until the pass takes it — that distinction is the whole reason the
   * five-state vocabulary exists. Calling it finished would tell a waiter the kitchen was done
   * while the plate was still under the lamp.
   */
  it('COOKED is not finished', () => {
    expect(partialProgress(line({kitchen_state: 'cooked', bar_state: 'outstanding'}))).toBeNull();
    expect(partialProgress(line({kitchen_state: 'ready', bar_state: 'cooked'}))).toBe('kitchen_ready');
  });

  it('a collected half counts as finished — the server downgrades it to ready for older clients', () => {
    expect(partialProgress(line({kitchen_state: 'collected', bar_state: 'outstanding'}))).toBe(
      'kitchen_ready',
    );
  });
});

describe('a single-station line is never partial', () => {
  it('a kitchen-only line has NULL for the bar, and a NULL is not a station that is waiting', () => {
    expect(partialProgress(line({route_to: 'kitchen', bar_state: null}))).toBeNull();
    expect(
      partialProgress(line({route_to: 'kitchen', bar_state: null, kitchen_state: 'ready'})),
    ).toBeNull();
  });

  it('a bar-only line likewise', () => {
    expect(partialProgress(line({route_to: 'bar', kitchen_state: null}))).toBeNull();
  });
});

describe('THE SERVER HAS THE LAST WORD', () => {
  it('says nothing when the server says the line is ready', () => {
    // Contradictory on purpose: the server says ready, the station states say half done. The
    // server wins, and nothing partial is rendered.
    expect(
      partialProgress(line({is_ready: true, kitchen_state: 'outstanding', bar_state: 'ready'})),
    ).toBeNull();
  });

  it('says nothing when the server says the line was collected', () => {
    expect(
      partialProgress(line({is_collected: true, kitchen_state: 'outstanding', bar_state: 'ready'})),
    ).toBeNull();
  });

  it('says nothing about a voided line', () => {
    expect(
      partialProgress(line({is_voided: true, kitchen_state: 'ready', bar_state: 'outstanding'})),
    ).toBeNull();
  });

  it('cannot be coaxed into implying readiness by any pair of station states', () => {
    const states = ['outstanding', 'cooked', 'ready', 'collected', 'voided', null];
    /**
     * WIDENED 2026-09-03, INTENT UNCHANGED. The half-voided fix added four cancelled values, two
     * of which name a station as ready ('kitchen_cancelled_bar_ready'). The guarantee this test
     * exists to hold is NOT "the word ready never appears" — 'bar_ready' always contained it — it
     * is that this function never implies THE LINE is ready when the server has not said so.
     *
     * So the allow-list is widened, and the real property is asserted directly underneath: any
     * value naming a station as ready must be backed by that station actually being ready or
     * collected. A value that named a station ready over an outstanding state would be exactly the
     * lie this test was written to prevent, and it now fails on that rather than on vocabulary.
     */
    const ALLOWED = [
      null,
      'kitchen_ready',
      'bar_ready',
      'kitchen_cancelled_bar_ready',
      'bar_cancelled_kitchen_ready',
      'kitchen_cancelled',
      'bar_cancelled',
    ];
    const FINISHED = ['ready', 'collected'];
    let checked = 0;
    for (const k of states) {
      for (const b of states) {
        const result = partialProgress(
          line({kitchen_state: k as string | null, bar_state: b as string | null}),
        );
        expect({k, b, ok: ALLOWED.includes(result)}).toEqual({k, b, ok: true});

        // Whatever it names as ready must really be ready.
        if (result === 'kitchen_ready' || result === 'bar_cancelled_kitchen_ready') {
          expect({k, b, kitchenFinished: FINISHED.includes(String(k))}).toEqual({
            k, b, kitchenFinished: true,
          });
        }
        if (result === 'bar_ready' || result === 'kitchen_cancelled_bar_ready') {
          expect({k, b, barFinished: FINISHED.includes(String(b))}).toEqual({
            k, b, barFinished: true,
          });
        }
        // And whatever it names as cancelled must really be voided.
        if (result === 'kitchen_cancelled' || result === 'kitchen_cancelled_bar_ready') {
          expect({k, b, kitchenVoided: k === 'voided'}).toEqual({k, b, kitchenVoided: true});
        }
        if (result === 'bar_cancelled' || result === 'bar_cancelled_kitchen_ready') {
          expect({k, b, barVoided: b === 'voided'}).toEqual({k, b, barVoided: true});
        }
        checked += 1;
      }
    }
    // A matrix that silently iterates nothing is a green that proves nothing.
    expect(checked).toBe(36);
  });

  it('both finished returns null — that is the server\'s call to make, not this function\'s', () => {
    // If both halves report ready the server will set is_ready; describing it as "partial" here
    // would be a second opinion on readiness, which is exactly what is forbidden.
    expect(partialProgress(line({kitchen_state: 'ready', bar_state: 'ready'}))).toBeNull();
  });
});
