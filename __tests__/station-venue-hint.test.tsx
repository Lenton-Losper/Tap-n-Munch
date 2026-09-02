/**
 * @jest-environment jsdom
 *
 * THE HINT IS A CHECK, NEVER AN AUTHORITY.
 *
 * Opening a station from a venue's dashboard did not close the wrong-venue failure — it moved its
 * entrance. A browser holding an FNB ChowNow token, clicking Open on Riviera's page, lands on
 * ChowNow's board: correct by the token, and indistinguishable from a quiet Riviera shift.
 *
 * Two properties carry all the weight here, and they pull in opposite directions:
 *
 *   1. WITH a hint that disagrees, the screen must say so loudly, naming both venues.
 *   2. WITHOUT a hint, behaviour must be byte-for-byte what it was — a wall screen launched from
 *      its own installed icon carries no parameter and must not acquire an opinion.
 *
 * And the one that keeps this from quietly becoming an authority: the hint must never be able to
 * change WHICH venue a board shows. It is compared, and nothing else.
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import {
  readVenueHint,
  isVenueMismatch,
  stationHrefWithVenueHint,
  VENUE_HINT_ID_PARAM,
} from '@/lib/stations/venue-hint'
import { StationVenueMismatch } from '@/components/stations/station-venue-mismatch'
import { STATION_COPY } from '@/lib/stations/copy'

const RIVIERA = '01bf27f1-a958-4322-bb3e-cc5240987808'
const CHOWNOW = 'b161c758-582d-4dfa-839a-9fa35c492a49'

describe('readVenueHint', () => {
  it('reads the id and the display name', () => {
    const h = readVenueHint(`?${VENUE_HINT_ID_PARAM}=${RIVIERA}&fromName=Riviera`)
    expect(h.id).toBe(RIVIERA)
    expect(h.name).toBe('Riviera')
  })

  it('is empty when there is no hint at all', () => {
    expect(readVenueHint('')).toEqual({ id: null, name: null })
    expect(readVenueHint('?station=kitchen')).toEqual({ id: null, name: null })
  })

  it('survives a malformed query rather than failing to open a kitchen board', () => {
    expect(readVenueHint('?%%%')).toEqual({ id: null, name: null })
    expect(readVenueHint('?from=')).toEqual({ id: null, name: null })
    expect(readVenueHint('?from=%20%20')).toEqual({ id: null, name: null })
  })
})

describe('isVenueMismatch', () => {
  it('is true only when the dashboard named a DIFFERENT venue from the token', () => {
    expect(isVenueMismatch({ id: RIVIERA, name: 'Riviera' }, CHOWNOW)).toBe(true)
  })

  it('is false when they agree', () => {
    expect(isVenueMismatch({ id: RIVIERA, name: 'Riviera' }, RIVIERA)).toBe(false)
  })

  it('NO HINT MEANS NO OPINION — the property that keeps installed screens unchanged', () => {
    // A wall screen opened from its own icon. It must reach exactly the board it reached before.
    expect(isVenueMismatch({ id: null, name: null }, CHOWNOW)).toBe(false)
    expect(isVenueMismatch({ id: null, name: 'Riviera' }, CHOWNOW)).toBe(false)
  })

  it('says nothing when the session has not resolved a restaurant yet', () => {
    // Mid-activation. Warning about a mismatch here would be noise about an unfinished state.
    expect(isVenueMismatch({ id: RIVIERA, name: 'Riviera' }, null)).toBe(false)
    expect(isVenueMismatch({ id: RIVIERA, name: 'Riviera' }, '')).toBe(false)
  })
})

describe('stationHrefWithVenueHint', () => {
  it('keeps the station path and adds the hint as a parameter', () => {
    const href = stationHrefWithVenueHint('/kitchen', RIVIERA, 'Riviera')
    expect(href.startsWith('/kitchen?')).toBe(true)
    expect(href).toContain(`${VENUE_HINT_ID_PARAM}=${RIVIERA}`)
  })

  it('omits the name when there is none, rather than sending an empty one', () => {
    expect(stationHrefWithVenueHint('/bar', RIVIERA, null)).not.toContain('fromName')
    expect(stationHrefWithVenueHint('/bar', RIVIERA, '   ')).not.toContain('fromName')
  })

  it('encodes a venue name that would otherwise break the query', () => {
    const href = stationHrefWithVenueHint('/kitchen', RIVIERA, 'Bob & Sons #2')
    expect(href).not.toContain('Bob & Sons #2')
    expect(new URLSearchParams(href.split('?')[1]).get('fromName')).toBe('Bob & Sons #2')
  })
})

describe('StationVenueMismatch', () => {
  let container: HTMLDivElement
  let root: Root
  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })
  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  const render = (showing: string | null, openedFrom: string | null, onContinue = () => {}) => {
    act(() =>
      root.render(
        <StationVenueMismatch
          station="kitchen"
          showingVenueName={showing}
          openedFromVenueName={openedFrom}
          onContinue={onContinue}
        />,
      ),
    )
    return container
  }

  it('names BOTH venues — naming only one is what made this take 45 minutes', () => {
    const el = render('FNB ChowNow', 'Riviera')
    expect(el.textContent).toContain('FNB ChowNow')
    expect(el.textContent).toContain('Riviera')
    expect(el.textContent).toContain(
      STATION_COPY.venueMismatch.body('FNB ChowNow', 'Riviera'),
    )
  })

  it('says how to re-pair', () => {
    expect(render('FNB ChowNow', 'Riviera').textContent).toContain(STATION_COPY.venueMismatch.fix)
  })

  it('still answers "whose board is this" in the usual place', () => {
    const header = render('FNB ChowNow', 'Riviera').querySelector('[data-testid="station-venue-header"]')
    expect(header?.textContent).toContain('Kitchen')
    expect(header?.textContent).toContain('FNB ChowNow')
  })

  it('lets a manager through, because the board is not broken', () => {
    let continued = false
    const el = render('FNB ChowNow', 'Riviera', () => {
      continued = true
    })
    const btn = el.querySelector('[data-testid="mismatch-continue"]') as HTMLButtonElement
    act(() => btn.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(continued).toBe(true)
  })

  it('falls back rather than inventing a venue name it was not given', () => {
    const el = render('FNB ChowNow', null)
    expect(el.textContent).toContain(STATION_COPY.venueMismatch.unknownOpenedFrom)
  })

  it('does not read as an error, because nothing has failed', () => {
    // The board below is correct and the food on it is real; only the expectation was wrong.
    const el = render('FNB ChowNow', 'Riviera')
    expect(el.textContent ?? '').not.toMatch(/error|failed|problem|wrong/i)
  })
})
