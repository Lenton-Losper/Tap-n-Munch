/**
 * @jest-environment jsdom
 *
 * #348, half 2 -- app/error.tsx, the root boundary, and the wiring that makes half 1 reachable.
 *
 * THE LOAD-BEARING TESTS, and the mutation that turns each red:
 *
 *   "files the crash at /api/crash-reports"     -- delete the reportBoundaryError call in
 *      app/error.tsx, or the fetch in reportBoundaryError. Without a POST, the boundary's "the
 *      details have already been sent to us" is a lie, exactly as it was before this issue.
 *   "sends no staff credential from a customer page" -- remove `authenticate: false` from
 *      app/error.tsx. getAccessToken() then runs on the QR surface, where there is no account.
 *   "the staff boundary falls back to the open intake" -- remove `fallbackPath` from
 *      app/(staff)/error.tsx. A staff session that expired is BOTH a way onto the error screen
 *      and a 500 from /api/bug-reports, so that crash reported nowhere while the screen said
 *      otherwise.
 *
 * There are no copy assertions beyond "it is still marked unsigned". The wording is not signed
 * off, and a test that pinned an unsigned placeholder would make replacing it a test failure --
 * which is how a placeholder becomes permanent.
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

jest.mock('@/lib/onboarding/api-client', () => ({
  getAccessToken: jest.fn(),
}))

import RootError, { ROOT_BOUNDARY_COPY, ROOT_ERROR_BOUNDARY_ID } from '@/app/error'
import StaffError from '@/app/(staff)/error'
import { getAccessToken } from '@/lib/onboarding/api-client'
import {
  BUG_REPORT_INTAKE_PATH,
  CRASH_REPORT_INTAKE_PATH,
  __resetBoundaryReportDedupe,
  errorReference,
} from '@/lib/errors/report-boundary-error'

type FetchCall = { url: string; init: RequestInit }

let container: HTMLDivElement
let root: Root
let calls: FetchCall[]
let fetchImpl: (url: string, init: RequestInit) => Promise<any>
let unhandled: unknown[]

const text = () => (container.textContent || '').replace(/\s+/g, ' ').trim()

function makeError(overrides: Partial<Error & { digest?: string }> = {}) {
  const error = new ReferenceError('MENU_COPY is not defined') as Error & { digest?: string }
  error.stack = 'ReferenceError: MENU_COPY is not defined\n    at MenuPage'
  return Object.assign(error, overrides)
}

async function settle() {
  for (let i = 0; i < 4; i += 1) {
    await act(async () => {
      await Promise.resolve()
    })
  }
}

async function renderRoot(error = makeError(), reset = jest.fn()) {
  await act(async () => {
    root.render(<RootError error={error} reset={reset} />)
  })
  await settle()
  return { error, reset }
}

function collectUnhandled(reason: unknown) {
  unhandled.push(reason)
}

beforeEach(() => {
  ;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  calls = []
  unhandled = []
  __resetBoundaryReportDedupe()
  ;(getAccessToken as jest.Mock).mockReset()
  ;(getAccessToken as jest.Mock).mockResolvedValue('staff-access-token')
  fetchImpl = async () => ({ ok: true, status: 202, json: async () => ({ accepted: true }) })
  ;(globalThis as any).fetch = jest.fn((url: string, init: RequestInit) => {
    calls.push({ url: String(url), init })
    return fetchImpl(String(url), init)
  })
  process.on('unhandledRejection', collectUnhandled)
})

afterEach(() => {
  process.off('unhandledRejection', collectUnhandled)
  act(() => root.unmount())
  container.remove()
  jest.restoreAllMocks()
})

const at = (path: string) => calls.filter((c) => c.url === path)
const bodyOf = (call: FetchCall) => JSON.parse(String(call.init.body))

describe('#348 — the root boundary reports the crash', () => {
  it('files the crash at /api/crash-reports', async () => {
    // THE MUTATION TARGET.
    await renderRoot()

    expect(at(CRASH_REPORT_INTAKE_PATH)).toHaveLength(1)
    expect(at(BUG_REPORT_INTAKE_PATH)).toHaveLength(0)
    const call = at(CRASH_REPORT_INTAKE_PATH)[0]
    expect(call.init.method).toBe('POST')
    expect((call.init.headers as Record<string, string>)['Content-Type']).toBe('application/json')
  })

  it('sends no staff credential from a customer page', async () => {
    // THE MUTATION TARGET. A customer on the QR surface has no Supabase auth session; asking for
    // one can only fail, and asking is how a staff bearer ends up on a customer's crash report.
    await renderRoot()
    expect(getAccessToken).not.toHaveBeenCalled()
    expect(
      (at(CRASH_REPORT_INTAKE_PATH)[0].init.headers as Record<string, string>).Authorization,
    ).toBeUndefined()
  })

  it('sends structured fields, not prose, because crash_reports has a column for each', async () => {
    const { error } = await renderRoot()
    const body = bodyOf(at(CRASH_REPORT_INTAKE_PATH)[0])

    expect(body.boundary).toBe(ROOT_ERROR_BOUNDARY_ID)
    expect(body.name).toBe('ReferenceError')
    expect(body.message).toBe('MENU_COPY is not defined')
    expect(body.stack).toContain('at MenuPage')
    // The reference on screen has to be the one that arrives, or "tell us" leads nowhere.
    expect(body.reference).toBe(errorReference(error))
    expect(text()).toContain(errorReference(error))
  })

  it('reports once per failure, not once per render', async () => {
    await renderRoot()
    await act(async () => {
      root.render(<RootError error={makeError()} reset={jest.fn()} />)
    })
    await settle()
    expect(at(CRASH_REPORT_INTAKE_PATH)).toHaveLength(1)
  })

  it('does not fall back anywhere when the open intake refuses it', async () => {
    // /api/crash-reports IS the fallback. There is nowhere further down to go, and a customer
    // page must never try the authenticated intake.
    fetchImpl = async () => ({ ok: false, status: 500, json: async () => ({ accepted: false }) })
    await renderRoot()
    expect(at(BUG_REPORT_INTAKE_PATH)).toHaveLength(0)
  })
})

describe('#348 — the root screen renders when reporting is impossible', () => {
  it('renders when the browser is offline', async () => {
    fetchImpl = async () => {
      throw new TypeError('Failed to fetch')
    }
    await renderRoot()
    expect(text().length).toBeGreaterThan(0)
    expect(unhandled).toHaveLength(0)
  })

  it('renders when fetch does not exist at all', async () => {
    delete (globalThis as any).fetch
    await renderRoot()
    expect(text().length).toBeGreaterThan(0)
    expect(unhandled).toHaveLength(0)
  })

  it('renders when the error object is degenerate', async () => {
    await renderRoot({} as Error & { digest?: string })
    expect(text().length).toBeGreaterThan(0)
    expect(unhandled).toHaveLength(0)
  })

  it('offers the action as a real control', async () => {
    await renderRoot()
    const button = Array.from(container.querySelectorAll('button')).find((el) =>
      (el.textContent || '').includes(ROOT_BOUNDARY_COPY.action),
    )
    expect(button).toBeDefined()
  })
})

describe('#348 — the root copy is not signed, and announces it', () => {
  it('every user-visible string still carries the marker', async () => {
    // Not a wording assertion. This is the tripwire that keeps the placeholders findable by
    // scripts/check-no-pending-copy.mjs until somebody signs them off, and it is expected to be
    // DELETED, not edited, when they are.
    for (const value of Object.values(ROOT_BOUNDARY_COPY)) {
      expect(value).toMatch(/PENDING COPY/)
    }
  })

  it('renders the placeholders rather than inventing wording around them', async () => {
    await renderRoot()
    const rendered = text().replace(/\s+/g, ' ')
    const accounted = Object.values(ROOT_BOUNDARY_COPY).reduce(
      (rest, line) => rest.replace(line.replace(/\s+/g, ' '), ''),
      rendered,
    )
    // Whatever is left is the reference code and whitespace. Any other words would be unsigned
    // wording that nobody has been asked to approve.
    expect(accounted.replace(/[\s\w-]/g, '')).toBe('')
  })
})

describe('#348 — the staff boundary keeps its intake, and gains a fallback', () => {
  async function renderStaff() {
    await act(async () => {
      root.render(<StaffError error={makeError()} reset={jest.fn()} />)
    })
    await settle()
  }

  it('still files at the authenticated intake first', async () => {
    await renderStaff()
    expect(at(BUG_REPORT_INTAKE_PATH)).toHaveLength(1)
    expect(
      (at(BUG_REPORT_INTAKE_PATH)[0].init.headers as Record<string, string>).Authorization,
    ).toBe('Bearer staff-access-token')
    // Nothing falls back when the primary worked.
    expect(at(CRASH_REPORT_INTAKE_PATH)).toHaveLength(0)
  })

  it('the staff boundary falls back to the open intake', async () => {
    // THE MUTATION TARGET. This is the case the landed half got wrong: an expired session is both
    // a way onto this screen and a 500 from /api/bug-reports, so that crash reported nowhere.
    ;(getAccessToken as jest.Mock).mockRejectedValue(new Error('Session expired.'))
    fetchImpl = async (url: string) =>
      url === BUG_REPORT_INTAKE_PATH
        ? { ok: false, status: 500, json: async () => ({ error: 'nope' }) }
        : { ok: true, status: 202, json: async () => ({ accepted: true }) }

    await renderStaff()

    expect(at(BUG_REPORT_INTAKE_PATH)).toHaveLength(1)
    expect(at(CRASH_REPORT_INTAKE_PATH)).toHaveLength(1)
    // The fallback carries the structured shape the open intake stores, not the prose one.
    const body = bodyOf(at(CRASH_REPORT_INTAKE_PATH)[0])
    expect(body.boundary).toBe('app/(staff)/error.tsx')
    expect(body.message).toBe('MENU_COPY is not defined')
    // And it carries no credential, because there was none to carry.
    expect(
      (at(CRASH_REPORT_INTAKE_PATH)[0].init.headers as Record<string, string>).Authorization,
    ).toBeUndefined()
  })
})
