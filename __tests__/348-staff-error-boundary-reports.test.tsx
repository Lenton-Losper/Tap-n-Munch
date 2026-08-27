/**
 * @jest-environment jsdom
 *
 * #348 -- app/(staff)/error.tsx, and the claim it makes.
 *
 * The boundary's last line tells the venue "We have been sent the details automatically."
 * That is a factual claim about the software's behaviour, not reassurance, and it is only
 * honest if a POST actually leaves the browser. The load-bearing test here is
 * "files the crash at /api/bug-reports": deleting the fetch in
 * lib/errors/report-boundary-error.ts, or the reportBoundaryError call in the boundary,
 * turns that sentence into a lie and must turn this suite red. Both mutations were run.
 *
 * The rest of the suite is the other half of the contract: the screen has to render in every
 * case where reporting is IMPOSSIBLE. A boundary that can itself throw is worse than no
 * boundary, because the venue then gets the same blank "Application error" page that made
 * 2026-08-26 an outage -- only now with an extra failure in the way.
 *
 * Copy assertions read the rendered DOM, not an exported constant, so that rewording the
 * signed copy in the JSX is what fails. The hyphen in "not the till - the card machine" is
 * an ASCII hyphen on purpose and is asserted as one.
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

jest.mock('@/lib/onboarding/api-client', () => ({
  getAccessToken: jest.fn(),
}))

import StaffError from '@/app/(staff)/error'
import { getAccessToken } from '@/lib/onboarding/api-client'
import {
  BUG_REPORT_INTAKE_PATH,
  __resetBoundaryReportDedupe,
  errorReference,
  reportBoundaryError,
} from '@/lib/errors/report-boundary-error'

type FetchCall = { url: string; init: RequestInit }

let container: HTMLDivElement
let root: Root
let calls: FetchCall[]
let fetchImpl: (url: string, init: RequestInit) => Promise<any>
let unhandled: unknown[]

const SIGNED = {
  title: 'This screen stopped working',
  body:
    'Your orders and payments are safe. This is the dashboard that failed, not the till - the ' +
    'card machine and the kitchen screen are unaffected, and nothing has been lost.',
  action: 'Reload the dashboard',
  sub:
    'If it keeps happening, carry on taking orders on the terminal and tell us. We have been ' +
    'sent the details automatically.',
}

/** Collapses the JSX's source line-wrapping so the assertion is about words, not whitespace. */
const text = () => (container.textContent || '').replace(/\s+/g, ' ').trim()

function makeError(overrides: Partial<Error & { digest?: string }> = {}) {
  const error = new ReferenceError('STRANDED_CLAIM_COPY is not defined') as Error & {
    digest?: string
  }
  error.stack = 'ReferenceError: STRANDED_CLAIM_COPY is not defined\n    at OrdersDashboard'
  return Object.assign(error, overrides)
}

async function renderBoundary(error = makeError(), reset = jest.fn()) {
  await act(async () => {
    root.render(<StaffError error={error} reset={reset} />)
  })
  // Let the reporting effect's promise chain settle (token lookup -> fetch -> response).
  for (let i = 0; i < 4; i += 1) {
    await act(async () => {
      await Promise.resolve()
    })
  }
  return { error, reset }
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
  fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ id: 'bug-1' }) })
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

function collectUnhandled(reason: unknown) {
  unhandled.push(reason)
}

const intakeCalls = () => calls.filter((c) => c.url === BUG_REPORT_INTAKE_PATH)

function intakeBody(call: FetchCall) {
  return JSON.parse(String(call.init.body)) as {
    description: string
    area?: string
    pageUrl?: string
  }
}

describe('#348 — the staff boundary reports the crash', () => {
  it('files the crash at /api/bug-reports', async () => {
    // THE MUTATION TARGET. Remove the fetch from reportBoundaryError, or the
    // reportBoundaryError call from app/(staff)/error.tsx, and this is what goes red.
    await renderBoundary()

    expect(intakeCalls()).toHaveLength(1)
    const call = intakeCalls()[0]
    expect(call.init.method).toBe('POST')
    expect((call.init.headers as Record<string, string>).Authorization).toBe(
      'Bearer staff-access-token',
    )
    expect((call.init.headers as Record<string, string>)['Content-Type']).toBe('application/json')
  })

  it('sends ops enough to identify the failure', async () => {
    const { error } = await renderBoundary()
    const body = intakeBody(intakeCalls()[0])

    // bug_reports has no digest or stack column, so everything has to survive in `description`,
    // which is the field /admin/bug-reports actually renders.
    expect(body.description).toContain('ReferenceError')
    expect(body.description).toContain('STRANDED_CLAIM_COPY is not defined')
    expect(body.description).toContain('app/(staff)/error.tsx')
    // The reference the venue can read off the screen must be the one ops receives, or the
    // "tell us" in the signed copy leads nowhere.
    expect(body.description).toContain(errorReference(error))
    expect(text()).toContain(`Reference: ${errorReference(error)}`)
    // A non-empty description is a hard 400 at the intake.
    expect(body.description.trim().length).toBeGreaterThan(0)
  })

  it('reports once per failure, not once per render', async () => {
    await renderBoundary()
    const error = makeError()
    await act(async () => {
      root.render(<StaffError error={error} reset={jest.fn()} />)
    })
    await act(async () => {
      await Promise.resolve()
    })
    expect(intakeCalls()).toHaveLength(1)
  })

  it('carries a digest through when Next minted one', async () => {
    await renderBoundary(makeError({ digest: '3819274655' }))
    const body = intakeBody(intakeCalls()[0])
    expect(body.description).toContain('3819274655')
    expect(text()).toContain('Reference: 3819274655')
  })

  it('still shows a reference when there is no digest', async () => {
    // The 2026-08-26 failure was a CLIENT render throw, and Next mints no digest for those.
    // Without a fallback the signed "Reference:" line would render empty.
    const error = makeError()
    expect(error.digest).toBeUndefined()
    await renderBoundary(error)
    const shown = /Reference: (\S+)/.exec(text())
    expect(shown).not.toBeNull()
    expect(shown![1].length).toBeGreaterThan(3)
  })
})

describe('#348 — the screen renders even when reporting is impossible', () => {
  it('renders with no session, and still attempts the report', async () => {
    ;(getAccessToken as jest.Mock).mockRejectedValue(new Error('Session expired.'))
    await renderBoundary()

    expect(text()).toContain(SIGNED.title)
    expect(text()).toContain(SIGNED.body)
    // The POST goes out unauthenticated rather than being dropped client-side: whether an
    // unauthenticated crash report is acceptable is the intake's decision to make.
    expect(intakeCalls()).toHaveLength(1)
    expect((intakeCalls()[0].init.headers as Record<string, string>).Authorization).toBeUndefined()
    expect(unhandled).toHaveLength(0)
  })

  it('renders when the browser is offline', async () => {
    fetchImpl = async () => {
      throw new TypeError('Failed to fetch')
    }
    await renderBoundary()

    expect(text()).toContain(SIGNED.title)
    expect(text()).toContain(SIGNED.action)
    expect(unhandled).toHaveLength(0)
  })

  it('renders when the intake route itself 500s', async () => {
    fetchImpl = async () => ({ ok: false, status: 500, json: async () => ({ error: 'nope' }) })
    await renderBoundary()

    expect(text()).toContain(SIGNED.title)
    expect(text()).toContain(SIGNED.sub)
    expect(unhandled).toHaveLength(0)
  })

  it('renders when fetch does not exist at all', async () => {
    delete (globalThis as any).fetch
    await renderBoundary()

    expect(text()).toContain(SIGNED.title)
    expect(unhandled).toHaveLength(0)
  })

  it('reports a missing fetch as such, rather than as a generic throw', async () => {
    // The render assertion above survives deleting the `typeof fetch` guard, because the outer
    // catch absorbs the ReferenceError either way -- verified by mutation. Without this test the
    // guard is decoration. It exists so the outcome distinguishes "no transport" from "the
    // request failed", which is the difference between a browser problem and an intake problem.
    delete (globalThis as any).fetch
    const outcome = await reportBoundaryError({
      boundary: 'test',
      reference: 'ref-no-fetch',
      name: 'ReferenceError',
      message: 'boom',
    })
    expect(outcome.skipped).toBe('no-fetch')
    expect(outcome.attempted).toBe(false)
  })

  it('renders when the error object is degenerate', async () => {
    // Next hands the boundary whatever was thrown. A non-Error throw must not become a second
    // error screen.
    await renderBoundary({} as Error & { digest?: string })
    expect(text()).toContain(SIGNED.title)
    expect(unhandled).toHaveLength(0)
  })
})

describe('#348 — the signed copy, verbatim', () => {
  it('renders every signed line exactly', async () => {
    await renderBoundary()
    const rendered = text()
    expect(rendered).toContain(SIGNED.title)
    expect(rendered).toContain(SIGNED.body)
    expect(rendered).toContain(SIGNED.action)
    expect(rendered).toContain(SIGNED.sub)
    expect(rendered).toContain('Reference: ')
  })

  it('keeps the ASCII hyphen in "not the till - the card machine"', async () => {
    await renderBoundary()
    expect(text()).toContain('not the till - the card machine')
    expect(text()).not.toContain('not the till — the card machine')
    expect(text()).not.toContain('not the till – the card machine')
  })

  it('says nothing beyond the signed copy', async () => {
    await renderBoundary()
    const rendered = text().replace(/Reference: \S+/, '')
    const accounted = [SIGNED.title, SIGNED.body, SIGNED.action, SIGNED.sub].reduce(
      (rest, line) => rest.replace(line, ''),
      rendered,
    )
    // Anything left is wording that was not signed off.
    expect(accounted.replace(/\s+/g, '')).toBe('')
  })

  it('offers the action as a real control', async () => {
    await renderBoundary()
    const button = Array.from(container.querySelectorAll('button')).find((el) =>
      (el.textContent || '').includes(SIGNED.action),
    )
    expect(button).toBeDefined()
  })
})
