/**
 * The four defects the owner found by walking the board on 2026-08-28, each pinned so it cannot
 * come back. Reported verbatim:
 *
 *   1. "12877 min" on a cooked card. Nine days in raw minutes. Nobody can read that.
 *   2. "Table 0" — order #5 has no table number and renders as zero.
 *   3. "1x Ribeye, medium rare" with "medium rare" repeated underneath.
 *   4. Every cooked card is red including the 88-minute one. The escalation is not discriminating.
 *
 * Defect 3 is NOT tested here and that is deliberate — it was seeded data, not code. See the note
 * at the bottom of this file.
 */
import { formatAge, readyToRunEscalation, ageMinutes, STALE_MINUTES } from '@/lib/stations/age'
import { STATION_COPY } from '@/lib/stations/copy'
import { mapStationLinesToKitchenLines, type StationLinesResponseDTO } from '@/lib/stations/map-raw-lines'

describe('defect 1 — an age a cook can actually read', () => {
  it('keeps minutes below an hour, where minutes are what a cook counts in', () => {
    expect(formatAge(0)).toBe('just now')
    expect(formatAge(1)).toBe('1 min')
    expect(formatAge(59)).toBe('59 min')
  })

  it('switches to hours and then to days instead of running away', () => {
    expect(formatAge(60)).toBe('1h')
    expect(formatAge(88)).toBe('1h 28m')
    expect(formatAge(1439)).toBe('23h 59m')
    expect(formatAge(1440)).toBe('1d')
  })

  /**
   * THE EXACT NUMBER OFF THE WALL. 12877 minutes is what the owner photographed, and the whole
   * point of the defect is that a human cannot divide it by 1440 at three metres.
   */
  it('renders the reported 12877 min as 8d', () => {
    expect(formatAge(12877)).toBe('8d')
    expect(formatAge(12877)).not.toMatch(/min/)
  })
})

describe('defect 2 — zero is not a table', () => {
  it('names an absent table in words rather than printing a number that does not exist', () => {
    expect(STATION_COPY.kitchen.tableLabel('')).toBe('No table')
    expect(STATION_COPY.bar.tableLabel('')).toBe('No table')
  })

  it('still labels real tables normally', () => {
    expect(STATION_COPY.kitchen.tableLabel('4')).toBe('Table 4')
  })

  /**
   * The normalisation happens in GET /api/station/lines, so the mapper only ever sees null. This
   * pins the mapper's half: a null table must not become the string "null" or a dash.
   */
  it('maps an absent table to empty, never to "null" or a dash', () => {
    const [line] = mapStationLinesToKitchenLines(responseWith({ table_number: null }))
    expect(line.tableNumber).toBe('')
    expect(STATION_COPY.kitchen.tableLabel(line.tableNumber)).toBe('No table')
  })
})

describe('defect 4 — the escalation has to discriminate', () => {
  /**
   * THE LOAD-BEARING TEST. The owner's actual complaint was not that a specific card was the wrong
   * colour, it was that EVERY cooked card was the same colour, so the colour told a cook nothing.
   *
   * Asserting "88 minutes is red" would have passed BEFORE the fix as well as after — the old code
   * returned red for everything above 5, so it would have been green while proving nothing. The
   * assertion that actually distinguishes fixed from broken is that the set of colours across a
   * realistic spread has more than one member, and specifically that a card past the end of
   * service is NOT the same colour as one that needs hands right now.
   */
  it('does not paint every aged card the same colour', () => {
    const spread = [0, 2, 4, 8, 88, 12877].map(readyToRunEscalation)
    expect(new Set(spread).size).toBeGreaterThan(1)

    // The two the owner named must differ from each other.
    expect(readyToRunEscalation(88)).not.toBe(readyToRunEscalation(12877))
  })

  it('keeps the brief\'s bands exactly — they were never the bug', () => {
    expect(readyToRunEscalation(0)).toBe('white')
    expect(readyToRunEscalation(2)).toBe('white')
    expect(readyToRunEscalation(3)).toBe('amber')
    expect(readyToRunEscalation(5)).toBe('amber')
    expect(readyToRunEscalation(6)).toBe('red')
    expect(readyToRunEscalation(88)).toBe('red')
  })

  it('stops spending red on cards that are abandoned rather than urgent', () => {
    expect(readyToRunEscalation(STALE_MINUTES - 1)).toBe('red')
    expect(readyToRunEscalation(STALE_MINUTES)).toBe('stale')
    expect(readyToRunEscalation(12877)).toBe('stale')
  })
})

describe('defect 4, root cause — a cooked card ages on the pass clock, not the order clock', () => {
  /**
   * THE DEFECT THAT WOULD HAVE BITTEN AT RIVIERA TONIGHT, not just in old fixtures.
   *
   * A steak legitimately takes eleven minutes. Under the old clock the card opened RED the instant
   * the cook tapped Cooked, because the escalation read the ORDER's age. Every cooked card went
   * red within six minutes of a round landing, which is precisely why the board was a wall of red.
   *
   * The plate below has been on the pass for thirty seconds. It must be white.
   */
  it('a just-plated dish from an old order is white, not red', () => {
    const now = Date.parse('2026-08-28T19:11:30Z')
    const orderPlaced = '2026-08-28T19:00:00Z' // 11m30s ago — red on the old clock
    const cooked = '2026-08-28T19:11:00Z' //  30s ago — white on the right one

    expect(readyToRunEscalation(ageMinutes(orderPlaced, now))).toBe('red')
    expect(readyToRunEscalation(ageMinutes(cooked, now))).toBe('white')
  })

  it('carries cooked_at through the mapper so the card can use it', () => {
    const [line] = mapStationLinesToKitchenLines(
      responseWith({ cooked_at: '2026-08-28T19:11:00Z' }),
    )
    expect(line.cookedAt).toBe('2026-08-28T19:11:00Z')
  })

  /**
   * A line the station has not cooked has no pass clock, and a card whose cooked event could not
   * be read must still render. Both cases fall back to the order's age rather than to nothing.
   */
  it('leaves cookedAt null when the station has not tapped Cooked', () => {
    const [line] = mapStationLinesToKitchenLines(responseWith({}))
    expect(line.cookedAt).toBeNull()
  })
})

/**
 * DEFECT 3 IS NOT A CODE DEFECT AND IS INTENTIONALLY NOT PINNED HERE.
 *
 * "1x Ribeye, medium rare" with "medium rare" underneath is one seeded row: name_snapshot
 * "Ribeye, medium rare" against line_note "medium rare". Measured on staging — of six lines
 * carrying a note, exactly one has the note inside the name; the rest are clean ("Burger" /
 * "no onions"). The dev fixture had the same authored shape and has been corrected.
 *
 * A render-time "hide the note if the name contains it" guard was deliberately NOT added. It would
 * make the board lie about the data instead of showing that the data is wrong, and it would
 * silently swallow a real terminal that starts baking modifiers into names — which is a thing the
 * owner would need to know about, not a thing to paper over.
 */

function responseWith(line: Partial<StationLinesResponseDTO['orders'][0]['lines'][0]> & { table_number?: string | number | null }): StationLinesResponseDTO {
  const { table_number, ...lineOverrides } = line
  // `?? 4` would turn an EXPLICIT null back into 4 and quietly test nothing, so presence of the
  // key is what decides, not its value.
  const tableNumber = 'table_number' in line ? (table_number ?? null) : 4
  return {
    station: 'kitchen',
    server_time: '2026-08-28T19:11:30Z',
    orders: [
      {
        order_id: 'o-1',
        order_number: 5,
        table_number: tableNumber,
        placed_at: '2026-08-28T19:00:00Z',
        seconds_waiting: 690,
        lines: [
          {
            id: 'kl-1',
            name_snapshot: 'Ribeye',
            quantity: 1,
            line_note: 'medium rare',
            route_to: 'kitchen',
            kitchen_state: 'cooked',
            bar_state: null,
            is_ready: false,
            unrouted: false,
            shared_with_other_station: false,
            ...lineOverrides,
          },
        ],
      },
    ],
  }
}
