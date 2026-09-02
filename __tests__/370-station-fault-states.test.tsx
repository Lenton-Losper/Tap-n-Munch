/**
 * @jest-environment jsdom
 *
 * #370 — EVERY DISTINCT FAULT MUST RENDER AS ITSELF, AND AN UNRECOGNISED ONE MUST NOT PICK A
 * DIAGNOSIS.
 *
 * The defect: the screen computed `notEnabled = (status === 403) && code !== 'STATION_NOT_PAIRED'`,
 * so any refusal it did not recognise rendered "station screens are not turned on yet — ask
 * whoever manages this venue to enable them". On 2026-09-02 that message ran for ~45 minutes on a
 * screen whose venue flag was already on.
 *
 * The load-bearing assertion in this file is the one about unknown codes: an unrecognised code, an
 * ABSENT code, and a non-403 failure must all land on 'unknown'. If someone later restores a
 * default of screens_disabled, that is the test that fails.
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { StationFaultNotice } from '@/components/stations/station-fault-notice'
import { STATION_COPY } from '@/lib/stations/copy'
import {
  stationFaultFromCode,
  featureDenialBody,
  STATION_FAULT_CODES,
  type StationFault,
} from '@/lib/stations/faults'
import { fetchInitialKitchenLines } from '@/lib/stations/data-port'

describe('stationFaultFromCode', () => {
  it('maps every code the server can send to its own fault', () => {
    expect(stationFaultFromCode(STATION_FAULT_CODES.SCREENS_DISABLED)).toBe('screens_disabled')
    expect(stationFaultFromCode(STATION_FAULT_CODES.SCREENS_NOT_CONFIGURED)).toBe('screens_not_configured')
    expect(stationFaultFromCode(STATION_FAULT_CODES.SCREENS_UNAVAILABLE)).toBe('screens_unavailable')
    expect(stationFaultFromCode(STATION_FAULT_CODES.NOT_PAIRED)).toBe('not_paired')
    expect(stationFaultFromCode(STATION_FAULT_CODES.MISSING_PERMISSION)).toBe('missing_permission')
  })

  it('does NOT resolve an unrecognised, absent or empty code to a diagnosis', () => {
    // The regression. Every one of these used to render as "the flag is off".
    expect(stationFaultFromCode('SOMETHING_WE_HAVE_NOT_SHIPPED_YET')).toBe('unknown')
    expect(stationFaultFromCode(undefined)).toBe('unknown')
    expect(stationFaultFromCode(null)).toBe('unknown')
    expect(stationFaultFromCode('')).toBe('unknown')
  })
})

describe('featureDenialBody', () => {
  it('gives each denial reason its own wire code', () => {
    expect(featureDenialBody('disabled').code).toBe(STATION_FAULT_CODES.SCREENS_DISABLED)
    expect(featureDenialBody('not_configured').code).toBe(STATION_FAULT_CODES.SCREENS_NOT_CONFIGURED)
    expect(featureDenialBody('unreadable').code).toBe(STATION_FAULT_CODES.SCREENS_UNAVAILABLE)
  })

  it('falls back to disabled only when no reason is supplied at all', () => {
    expect(featureDenialBody(undefined).code).toBe(STATION_FAULT_CODES.SCREENS_DISABLED)
  })
})

describe('data-port fault mapping', () => {
  const authFetch = (status: number, body: unknown) =>
    (async () =>
      ({
        status,
        ok: status >= 200 && status < 300,
        json: async () => body,
        text: async () => JSON.stringify(body),
        statusText: 'x',
      }) as unknown as Response) as never

  it('threads each 403 code through to its fault', async () => {
    const cases = [
      [STATION_FAULT_CODES.SCREENS_DISABLED, 'screens_disabled'],
      [STATION_FAULT_CODES.SCREENS_NOT_CONFIGURED, 'screens_not_configured'],
      [STATION_FAULT_CODES.SCREENS_UNAVAILABLE, 'screens_unavailable'],
      [STATION_FAULT_CODES.MISSING_PERMISSION, 'missing_permission'],
    ] as const

    for (const [code, expected] of cases) {
      const snapshot = await fetchInitialKitchenLines(authFetch(403, { code }))
      expect(snapshot.fault).toBe(expected)
      expect(snapshot.items).toEqual([])
    }
  })

  it('carries pairedTo only for the pairing fault', async () => {
    const paired = await fetchInitialKitchenLines(
      authFetch(403, { code: STATION_FAULT_CODES.NOT_PAIRED, pairedTo: 'bar' }),
    )
    expect(paired.fault).toBe('not_paired')
    expect(paired.pairedTo).toBe('bar')

    // A disabled venue has no paired-to answer, and must not borrow one.
    const disabled = await fetchInitialKitchenLines(
      authFetch(403, { code: STATION_FAULT_CODES.SCREENS_DISABLED, pairedTo: 'bar' }),
    )
    expect(disabled.pairedTo).toBeNull()
  })

  it('treats a 403 with NO code, and any non-403 failure, as unknown — never as disabled', async () => {
    expect((await fetchInitialKitchenLines(authFetch(403, {}))).fault).toBe('unknown')
    expect((await fetchInitialKitchenLines(authFetch(500, { error: 'boom' }))).fault).toBe('unknown')
    expect((await fetchInitialKitchenLines(authFetch(404, { error: 'nope' }))).fault).toBe('unknown')
  })

  it('reports no fault at all when the board loads', async () => {
    const snapshot = await fetchInitialKitchenLines(
      authFetch(200, { station: 'kitchen', orders: [], server_time: new Date().toISOString() }),
    )
    expect(snapshot.fault).toBeNull()
  })
})

describe('StationFaultNotice renders each fault distinctly', () => {
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

  const renderFault = (fault: StationFault, pairedTo: string | null = null) => {
    act(() => root.render(<StationFaultNotice fault={fault} pairedTo={pairedTo} station="kitchen" venueName="Riviera" />))
    return container.querySelector('[data-testid="station-fault-notice"]') as HTMLElement
  }

  const ALL: StationFault[] = [
    'screens_disabled',
    'screens_not_configured',
    'screens_unavailable',
    'not_paired',
    'missing_permission',
    'unknown',
  ]

  it('gives every fault its own heading — no two share one', () => {
    // Scoped to the FAULT heading — the page's h1 is now the venue header (#371).
    const headings = ALL.map(
      (f) => renderFault(f).querySelector('[data-testid="station-fault-heading"]')?.textContent ?? '',
    )
    expect(new Set(headings).size).toBe(ALL.length)
    expect(headings.every((h) => h.length > 0)).toBe(true)
  })

  it('stamps the fault on the DOM so a screenshot can be told apart from prose', () => {
    for (const fault of ALL) {
      expect(renderFault(fault).getAttribute('data-fault')).toBe(fault)
    }
  })

  it('does not send staff to a setting when nothing they can change is wrong', () => {
    /**
     * The read failed, or we do not know what happened. DIRECTING someone to Settings here is the
     * wild goose chase this issue is about — so the assertion is on the directive ("in Settings",
     * "ask a manager to…"), not on the word "settings", which reads perfectly well as an ordinary
     * noun in "cannot check its settings right now".
     */
    for (const fault of ['screens_unavailable', 'unknown'] as const) {
      const text = renderFault(fault).textContent ?? ''
      expect(text).not.toMatch(/in Settings/i)
      expect(text).not.toMatch(/ask a manager to/i)
      // Instead they get the two things that ARE useful: try the page again, and if that does not
      // work escalate to a person rather than to a settings page that cannot help.
      expect(text).toMatch(/reloading this page/i)
      expect(text).toMatch(/tell a manager/i)
    }
  })

  it('does direct staff to Settings for the faults a manager can actually fix there', () => {
    for (const fault of ['screens_disabled', 'screens_not_configured', 'not_paired', 'missing_permission'] as const) {
      expect(renderFault(fault).textContent ?? '').toMatch(/Settings/)
    }
  })

  it('never shows an error code or a field name to a cook', () => {
    for (const fault of ALL) {
      const text = renderFault(fault).textContent ?? ''
      expect(text).not.toMatch(/STATION_|_state|orders:read|403|null|undefined/)
    }
  })

  it('still names the venue on every fault (#371) — an empty board must say whose it is', () => {
    for (const fault of ALL) {
      expect(renderFault(fault).querySelector('[data-testid="station-venue-header"]')?.textContent).toContain(
        'Riviera',
      )
    }
  })

  it('names the other screen when the pairing mismatch knows it', () => {
    expect(renderFault('not_paired', 'bar').textContent).toContain('bar')
    // …and stays a complete sentence when it does not.
    const card = renderFault('not_paired', null).querySelector('[data-testid="station-fault-heading"]')
      ?.parentElement
    expect(card?.textContent).toBe(
      STATION_COPY.faults.notPaired.heading + STATION_COPY.faults.notPaired.description(null),
    )
  })
})
