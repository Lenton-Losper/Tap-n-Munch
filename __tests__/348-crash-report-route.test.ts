/**
 * #348, half 1 -- the route itself: what it accepts, what it stores, and the order it does things.
 *
 * The intake policy is asserted directly in 348-crash-report-intake.test.ts. What can only be
 * asserted HERE is the composition -- that the route actually applies the policy, and that the
 * rate limit runs BEFORE the body is read, which is the difference between a flood costing a
 * header lookup and a flood costing 32 KB of buffering per request.
 *
 * MUTATIONS RUN AGAINST THIS FILE (results in the agent's report):
 *   - move `checkCrashReportRateLimit` below `readCappedBody` in the route
 *   - make the 429 branch return 202 instead
 *   - delete the `unenforced` warning
 *   - delete the User-Agent argument to buildCrashReportRow
 */
const limitCalls: Array<{ key: string }> = []
let limitSucceeds = true
let bindingPresent = true

jest.mock('@opennextjs/cloudflare', () => ({
  getCloudflareContext: () => ({
    env: bindingPresent
      ? {
          CRASH_REPORT_RATE_LIMITER: {
            limit: async (options: { key: string }) => {
              limitCalls.push(options)
              return { success: limitSucceeds }
            },
          },
        }
      : {},
  }),
}))

const inserted: Array<Record<string, unknown>> = []
let insertError: { message: string } | null = null

jest.mock('@/lib/supabase/server', () => ({
  createServerSupabaseClient: () => ({
    from(table: string) {
      if (table !== 'crash_reports') throw new Error(`unexpected table ${table}`)
      return {
        async insert(row: Record<string, unknown>) {
          inserted.push(row)
          return { error: insertError }
        },
      }
    },
  }),
}))

import { POST } from '@/app/api/crash-reports/route'

const RESTAURANT = '11111111-2222-4333-8444-555555555555'

/**
 * A body that records whether anything ever tried to READ it.
 *
 * This is how "the limit runs first" is measured rather than read off the source order: a
 * rate-limited request must leave `pulled` false.
 *
 * The probe is `getReader`, not the stream's own `pull`. `pull` is called eagerly when a
 * ReadableStream is constructed -- the default queuing strategy fills the queue whether or not
 * anyone is reading -- so a `pull`-based probe reports true for a request the route never
 * touched, and would have passed against a route with no rate limit at all. That version of this
 * test was written first and did exactly that.
 */
function trackedRequest(payload: unknown, headers: Record<string, string> = {}) {
  const state = { pulled: false }
  const bytes = new TextEncoder().encode(
    typeof payload === 'string' ? payload : JSON.stringify(payload),
  )
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes)
      controller.close()
    },
  })
  const request = {
    body: {
      getReader: () => {
        state.pulled = true
        return stream.getReader()
      },
    },
    headers: new Headers({ 'CF-Connecting-IP': '203.0.113.7', ...headers }),
    async text() {
      state.pulled = true
      return new TextDecoder().decode(bytes)
    },
  } as unknown as Request
  return { request, state }
}

beforeEach(() => {
  limitCalls.length = 0
  inserted.length = 0
  limitSucceeds = true
  bindingPresent = true
  insertError = null
  jest.spyOn(console, 'warn').mockImplementation(() => {})
  jest.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  jest.restoreAllMocks()
})

describe('#348 — the route stores a crash report', () => {
  it('accepts an unauthenticated report and writes one row', async () => {
    const { request } = trackedRequest({
      boundary: 'app/error.tsx',
      reference: 'zk4m1p0',
      name: 'ReferenceError',
      message: 'STRANDED_CLAIM_COPY is not defined',
      stack: 'ReferenceError: ...\n  at MenuPage',
      pageUrl: `https://order.flashtap.app/menu/${RESTAURANT}/browse?table=7&t=sess-token`,
    })
    const response = await POST(request)

    expect(response.status).toBe(202)
    await expect(response.json()).resolves.toEqual({ accepted: true })
    expect(inserted).toHaveLength(1)

    const row = inserted[0]
    expect(row.boundary).toBe('app/error.tsx')
    expect(row.reference).toBe('zk4m1p0')
    expect(row.error_name).toBe('ReferenceError')
    // Path only. The session token in the query string must not reach the database.
    expect(row.page_path).toBe(`/menu/${RESTAURANT}/browse`)
    expect(row.restaurant_id).toBe(RESTAURANT)
    expect(JSON.stringify(row)).not.toContain('sess-token')
  })

  it('stores the User-Agent it was sent and nothing else from the headers', async () => {
    const { request } = trackedRequest(
      { message: 'boom' },
      {
        'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0)',
        cookie: 'sb-access-token=SECRET; tab_pin=1234',
        authorization: 'Bearer SECRET-BEARER',
      },
    )
    await POST(request)

    expect(inserted[0].user_agent).toBe('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0)')
    const stored = JSON.stringify(inserted[0])
    expect(stored).not.toContain('SECRET')
    expect(stored).not.toContain('1234')
    expect(stored).not.toContain('203.0.113.7')
  })

  it('stores a body it could not parse rather than dropping it', async () => {
    const { request } = trackedRequest('{"message":"cut in ha')
    const response = await POST(request)
    expect(response.status).toBe(202)
    expect(inserted[0].error_name).toBe('UnparseableCrashReport')
  })

  it('answers 500 but does not throw when the insert fails', async () => {
    insertError = { message: 'relation "crash_reports" does not exist' }
    const { request } = trackedRequest({ message: 'boom' })
    const response = await POST(request)
    expect(response.status).toBe(500)
    // The browser is already on an error screen; the log is where this has to be visible.
    expect(console.error).toHaveBeenCalled()
  })

  it('writes nothing for a body with nothing in it', async () => {
    const { request } = trackedRequest({})
    const response = await POST(request)
    expect(response.status).toBe(202)
    await expect(response.json()).resolves.toEqual({ accepted: false })
    expect(inserted).toHaveLength(0)
  })
})

describe('#348 — the abuse defences', () => {
  it('rate limits before the body is read', async () => {
    // THE MUTATION TARGET. Move the limit below readCappedBody and `pulled` becomes true: a
    // flood would then cost 32 KB of buffering per refused request instead of a header lookup.
    limitSucceeds = false
    const { request, state } = trackedRequest({ message: 'boom' })
    const response = await POST(request)

    expect(response.status).toBe(429)
    expect(response.headers.get('Retry-After')).toBe('60')
    expect(inserted).toHaveLength(0)
    expect(state.pulled).toBe(false)
  })

  it('keys the limit on the edge header, not on a spoofable one', async () => {
    const { request } = trackedRequest(
      { message: 'boom' },
      { 'x-forwarded-for': '198.51.100.9' },
    )
    await POST(request)
    // An attacker who could move the key would get a fresh bucket per request and the limit
    // would count to one forever.
    expect(limitCalls).toEqual([{ key: '203.0.113.7' }])
  })

  it('FAILS OPEN when no binding is reachable, and says so in the log', async () => {
    // A misconfigured binding that silently DISCARDED crash reports would reproduce the defect
    // this endpoint exists to fix -- a failure nobody was told about -- inside the fix for it.
    bindingPresent = false
    const { request } = trackedRequest({ message: 'boom' })
    const response = await POST(request)

    expect(response.status).toBe(202)
    expect(inserted).toHaveLength(1)
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining('rate limiting is NOT in force'),
    )
  })

  it('truncates an oversized report instead of refusing it', async () => {
    const { request } = trackedRequest({ message: 'boom', stack: 'S'.repeat(200_000) })
    const response = await POST(request)

    // Never a 413. A crash report refused for being long is a crash report you do not get.
    expect(response.status).toBe(202)
    expect(inserted).toHaveLength(1)
    expect(inserted[0].truncated).toBe(true)
    // And what survived is the FRONT of the report, not filler. Asserting only the `truncated`
    // flag passes against a cap that returns a zero-filled buffer -- measured, not assumed.
    expect(String(inserted[0].error_message)).toContain('"message":"boom"')
  })
})
