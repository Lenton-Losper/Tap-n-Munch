/**
 * #348, half 1 -- POST /api/crash-reports and the policy it enforces.
 *
 * WHAT IS LOAD-BEARING HERE, and what each mutation was:
 *
 *   "truncates an oversized body rather than refusing it"  -- change readCappedBody's over-cap
 *      branch to return `{ text: '', truncated: true }`, or make the route answer 413, and this
 *      goes red. The whole design rests on it: a crash report refused for being long is a crash
 *      report you do not get, and the reports that get long are the interesting ones.
 *   "keeps the path and discards the query string"         -- delete the `.pathname` in
 *      sanitizePagePath, or store `raw.pageUrl` directly in buildCrashReportRow, and this goes
 *      red. That query string carries a customer's name, a party's tab id and the gateway's
 *      return payload.
 *   "does not take the venue from the body"                -- add `restaurant_id: cap(raw.restaurantId, 36)`
 *      to buildCrashReportRow and this goes red. The caller is an anonymous stranger.
 *   "rate limits before the body is read"                  -- move checkCrashReportRateLimit below
 *      readCappedBody in the route and this goes red.
 *   "stores no header but User-Agent"                      -- add any other header to the row and
 *      this goes red.
 *
 * ALL OF THESE WERE RUN, and one of them survived the first time. The truncation test originally
 * asserted only `truncated === true` and the resulting length, and passed against a readCappedBody
 * that returned 32 KB of NUL bytes -- because the output buffer is allocated at `total` and
 * zero-filled, so discarding every chunk still produces a string of exactly the expected length.
 * The assertion on CONTENT was added because of that, and re-running the mutation is what turned
 * it red. The lesson is in the file rather than only in the report: a length assertion cannot tell
 * the report from the absence of it.
 */
import {
  MAX_BODY_BYTES,
  MAX_ERROR_MESSAGE,
  MAX_STACK,
  TRUNCATION_MARKER,
  buildCrashReportRow,
  cap,
  readCappedBody,
  restaurantIdFromPath,
  sanitizePagePath,
} from '@/lib/crash-reports/crash-report-intake'

const RESTAURANT = '11111111-2222-4333-8444-555555555555'

/** A Request whose body is a real stream, which is the shape the Worker actually sees. */
function streamingRequest(text: string, headers: Record<string, string> = {}): Request {
  const bytes = new TextEncoder().encode(text)
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      // Deliberately chunked: readCappedBody has to stop mid-stream, not merely slice at the end.
      for (let i = 0; i < bytes.length; i += 997) {
        controller.enqueue(bytes.subarray(i, Math.min(i + 997, bytes.length)))
      }
      controller.close()
    },
  })
  return {
    body,
    headers: new Headers(headers),
    async text() {
      throw new Error('readCappedBody must not fall back to text() when a stream exists')
    },
  } as unknown as Request
}

describe('#348 — cap() truncates and marks, and distinguishes empty from absent', () => {
  it('leaves a short value alone', () => {
    expect(cap('hello', 10)).toBe('hello')
  })

  it('marks anything it cut', () => {
    const cut = cap('x'.repeat(50), 10)
    expect(cut).toBe('x'.repeat(10) + TRUNCATION_MARKER)
    // Without the marker a truncated stack reads as a complete one, and the missing frames are
    // the frames somebody is about to conclude are not involved.
    expect(cut).toContain(TRUNCATION_MARKER)
  })

  it('reports "we were not told" as null rather than as an empty string', () => {
    expect(cap(undefined, 10)).toBeNull()
    expect(cap(null, 10)).toBeNull()
    expect(cap('   ', 10)).toBeNull()
  })
})

describe('#348 — the body is capped while streaming, and truncated rather than refused', () => {
  it('truncates an oversized body rather than refusing it', async () => {
    /**
     * THE MUTATION TARGET. A 413, or an empty result on overflow, fails this.
     *
     * THE ASSERTION ON CONTENT IS THE LOAD-BEARING ONE, and it is here because the first version
     * of this test checked only `truncated === true` and the length. Replacing the over-cap
     * `chunks.push(value.subarray(...))` with `chunks.length = 0` SURVIVED that version: the
     * function still returned exactly MAX_BODY_BYTES characters and still said `truncated`, but
     * every one of those characters was a NUL from the zero-filled output buffer. A test that
     * cannot tell 32 KB of the report from 32 KB of nothing was decoration.
     */
    const prefix = 'START-OF-REPORT{"message":"'
    const huge = prefix + 'a'.repeat(MAX_BODY_BYTES * 3)
    const result = await readCappedBody(streamingRequest(huge))

    expect(result.truncated).toBe(true)
    expect(result.text.length).toBe(MAX_BODY_BYTES)
    expect(result.text.length).toBeLessThan(huge.length)
    // The bytes kept are the FIRST bytes of what was sent, not filler.
    expect(result.text.slice(0, prefix.length)).toBe(prefix)
    // Not the zero-filled output buffer described above.
    expect(result.text).not.toContain('\u0000')
  })

  it('does not mark a body that fitted', async () => {
    const result = await readCappedBody(streamingRequest('{"message":"ok"}'))
    expect(result.truncated).toBe(false)
    expect(result.text).toBe('{"message":"ok"}')
  })

  it('turns a body it cannot parse into a row anyway', () => {
    // The direct consequence of truncating JSON: what arrives is not valid JSON. Losing the
    // report at that point would be the "refused for being long" failure arriving by another door.
    const row = buildCrashReportRow({ text: '{"message":"half of a rep', truncated: true }, null)
    expect(row.error_name).toBe('UnparseableCrashReport')
    expect(row.error_message).toContain('half of a rep')
    expect(row.truncated).toBe(true)
  })

  it('caps each field independently of the body cap', () => {
    const row = buildCrashReportRow(
      {
        text: JSON.stringify({
          message: 'm'.repeat(MAX_ERROR_MESSAGE * 2),
          stack: 's'.repeat(MAX_STACK * 2),
        }),
        truncated: false,
      },
      null,
    )
    expect(row.error_message).toHaveLength(MAX_ERROR_MESSAGE + TRUNCATION_MARKER.length)
    expect(row.error_stack).toHaveLength(MAX_STACK + TRUNCATION_MARKER.length)
  })

  it('survives a stream that dies mid-report', async () => {
    // The chunk is DELIVERED and only then does the connection drop: erroring a stream that
    // still has queued chunks discards them by spec, so a test written that way would assert
    // nothing about our code. What is asserted here is that bytes already read are kept when the
    // read that follows rejects -- a report cut off halfway is still evidence of a crash.
    let delivered = false
    const request = {
      body: new ReadableStream<Uint8Array>({
        pull(controller) {
          if (!delivered) {
            delivered = true
            controller.enqueue(new TextEncoder().encode('{"message":"partial'))
            return
          }
          controller.error(new Error('connection reset'))
        },
      }),
      headers: new Headers(),
    } as unknown as Request
    const result = await readCappedBody(request)
    expect(result.text).toContain('partial')
  })
})

describe('#348 — the URL is reduced to a path, default-deny', () => {
  it('keeps the path and discards the query string', () => {
    // THE MUTATION TARGET. `?name=` is a customer's name and `?tabId=` is a party's open tab.
    const path = sanitizePagePath(
      `https://order.flashtap.app/menu/${RESTAURANT}/kiosk-success?name=Jane%20Ndlovu&tabId=abc&t=sess-token`,
    )
    expect(path).toBe(`/menu/${RESTAURANT}/kiosk-success`)
    expect(path).not.toContain('?')
    expect(path).not.toContain('Jane')
    expect(path).not.toContain('sess-token')
  })

  it('discards the origin as well as the query', () => {
    expect(sanitizePagePath('https://order.flashtap.app/menu/x/browse')).toBe('/menu/x/browse')
  })

  it('discards the fragment', () => {
    expect(sanitizePagePath('/menu/x/tab#pin=1234')).toBe('/menu/x/tab')
  })

  it('yields null rather than throwing on nonsense', () => {
    expect(sanitizePagePath('')).toBeNull()
    expect(sanitizePagePath(null)).toBeNull()
    expect(sanitizePagePath(undefined)).toBeNull()
  })
})

describe('#348 — the venue is derived from the path, never accepted from the body', () => {
  it('does not take the venue from the body', () => {
    // THE MUTATION TARGET. An unauthenticated stranger does not get to say which venue a report
    // belongs to; reading restaurantId off the body would let one file rows against any venue.
    const row = buildCrashReportRow(
      {
        text: JSON.stringify({
          message: 'boom',
          restaurantId: '99999999-9999-4999-8999-999999999999',
          pageUrl: `/menu/${RESTAURANT}/browse`,
        }),
        truncated: false,
      },
      null,
    )
    expect(row.restaurant_id).toBe(RESTAURANT)
    expect(row.restaurant_id).not.toBe('99999999-9999-4999-8999-999999999999')
  })

  it('takes it from the path when the path has one', () => {
    expect(restaurantIdFromPath(`/menu/${RESTAURANT}/cart`)).toBe(RESTAURANT)
  })

  it('is null rather than a bad uuid when the path has none', () => {
    // A non-uuid here would fail the INSERT and discard a crash report over an optional field.
    expect(restaurantIdFromPath('/menu/not-a-uuid/browse')).toBeNull()
    expect(restaurantIdFromPath('/signin')).toBeNull()
    expect(restaurantIdFromPath(null)).toBeNull()
  })
})

describe('#348 — the row carries nothing it was not deliberately given', () => {
  it('stores no header but User-Agent', () => {
    // THE MUTATION TARGET. Every field on the row is enumerated here, so adding a cookie, an
    // Authorization header, an IP or a session token to buildCrashReportRow fails this.
    const row = buildCrashReportRow(
      {
        text: JSON.stringify({
          boundary: 'app/error.tsx',
          reference: 'abc123',
          digest: 'd1',
          name: 'ReferenceError',
          message: 'boom',
          stack: 'ReferenceError: boom\n  at X',
          pageUrl: `/menu/${RESTAURANT}/browse?t=secret-session-token`,
        }),
        truncated: false,
      },
      'Mozilla/5.0 (iPhone)',
    )
    expect(Object.keys(row).sort()).toEqual(
      [
        'boundary',
        'digest',
        'error_message',
        'error_name',
        'error_stack',
        'page_path',
        'reference',
        'restaurant_id',
        'truncated',
        'user_agent',
      ].sort(),
    )
    expect(JSON.stringify(row)).not.toContain('secret-session-token')
    expect(row.user_agent).toBe('Mozilla/5.0 (iPhone)')
  })

  it('truncates a hostile User-Agent', () => {
    const row = buildCrashReportRow({ text: '{"message":"x"}', truncated: false }, 'U'.repeat(5000))
    expect(row.user_agent).toContain(TRUNCATION_MARKER)
    expect(row.user_agent!.length).toBeLessThan(400)
  })

  it('does not fall over on a JSON array or a bare string', () => {
    // Next hands a boundary whatever was thrown, and a hostile caller sends whatever it likes.
    expect(buildCrashReportRow({ text: '[1,2,3]', truncated: false }, null).error_name).toBe(
      'UnparseableCrashReport',
    )
    expect(buildCrashReportRow({ text: '"just a string"', truncated: false }, null).error_name).toBe(
      'UnparseableCrashReport',
    )
  })
})
