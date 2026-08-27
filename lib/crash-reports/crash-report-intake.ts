/**
 * #348 -- what POST /api/crash-reports is allowed to accept, and what it is allowed to keep.
 *
 * Everything here is pure so it can be asserted directly. The route is then thin enough that
 * reading it tells you the whole policy, and __tests__/348-crash-report-intake.test.ts can put
 * hostile input through the policy without standing a Worker up.
 *
 * THREE RULINGS ARE TAKEN IN THIS FILE. Each is written down because each had a defensible
 * opposite and the opposite is what a later reader will otherwise assume.
 *
 * 1. TRUNCATE, NEVER REJECT. A crash report refused for being too long is a crash report you do
 *    not get, and the population that produces oversized reports -- deep component trees, long
 *    stacks, a loop that threw ten thousand times -- is exactly the population worth reading. So
 *    the body is read under a hard byte ceiling and every field is cut to its own ceiling, and
 *    the row lands either way. `413` is never returned. The one thing truncation must not do is
 *    lose the fact that it happened, so every cut leaves a visible marker in the stored text.
 *
 *    A consequence, and the reason readCappedBody exists rather than `request.text()`: cutting a
 *    JSON document in half produces something JSON.parse cannot read. That is handled rather than
 *    avoided -- see parseCrashReportBody, which stores the truncated text as the description when
 *    it cannot parse it. A malformed report is still a report.
 *
 * 2. THE URL IS DEFAULT-DENY, and reduced to a PATH. Same ruling as lib/customer-copy/
 *    customer-safe-error.ts (#206) and for the same reason: a denylist of query keys is safe only
 *    for the keys somebody remembered. The customer surface puts real material in the query
 *    string today -- `?name=` on kiosk-success is a customer's name, `?tabId=` identifies a
 *    party's open tab, and the gateway return leg on /order-confirmation carries a payment
 *    reference and whatever else Finatic appends -- and the next such parameter will be added by
 *    someone who has never read this file. Origin and query are dropped; the pathname is kept
 *    because it is the route, which is the diagnostic fact, and because the restaurant id lives
 *    in it. Nothing that arrives in a query string is ever stored.
 *
 * 3. THE RESTAURANT IS DERIVED, NOT ACCEPTED. The caller is unauthenticated, so a `restaurantId`
 *    field in the body is a value an anonymous stranger chose. It is not read. The id is instead
 *    taken out of the sanitised path, where it has to agree with the page that crashed. It is
 *    stored WITHOUT a foreign key (see the migration) so that a report from a route we do not
 *    recognise, or a venue since deleted, still lands.
 *
 * WHAT IS DELIBERATELY NOT COLLECTED: cookies, the Authorization header, any session or tab
 * token, the customer's name, and the caller's IP. The IP is computed by the rate limiter and
 * used as a bucket key for the length of the request; it is never passed to this module and
 * never written. The one header kept is User-Agent, truncated -- for a RENDER crash the browser
 * build is the single most diagnostic non-code fact there is, and it identifies a browser rather
 * than a person. That is a judgement, and it is the one thing here worth overruling if the owner
 * would rather store nothing.
 */

/**
 * Hard ceiling on the request body, in bytes.
 *
 * Sized from the real thing: the largest field is a stack, and MAX_STACK below keeps 8 KB of it.
 * 32 KB leaves comfortable room for that plus the small fields and JSON overhead, while being
 * far below anything that could be used to make the Worker hold memory.
 */
export const MAX_BODY_BYTES = 32 * 1024

/** Per-field ceilings, applied after parsing. Every one of these truncates rather than rejects. */
export const MAX_BOUNDARY = 200
export const MAX_REFERENCE = 128
export const MAX_DIGEST = 128
export const MAX_ERROR_NAME = 200
export const MAX_ERROR_MESSAGE = 2000
export const MAX_STACK = 8 * 1024
export const MAX_PAGE_PATH = 500
export const MAX_USER_AGENT = 300
/** The description built when the body could not be parsed at all. */
export const MAX_DESCRIPTION = 8 * 1024

/** Appended wherever a value was cut, so a truncated field never reads as a complete one. */
export const TRUNCATION_MARKER = '…[truncated]'

export type CrashReportRow = {
  boundary: string | null
  reference: string | null
  digest: string | null
  error_name: string | null
  error_message: string | null
  error_stack: string | null
  page_path: string | null
  restaurant_id: string | null
  user_agent: string | null
  /** Set when the body was over MAX_BODY_BYTES or could not be parsed. Never used to reject. */
  truncated: boolean
}

export type CappedBody = {
  text: string
  /** True when the stream was still producing bytes when the ceiling was reached. */
  truncated: boolean
}

/**
 * Cut a string to `max`, leaving a marker when anything was removed.
 *
 * Returns null for an empty or absent value so the column stores NULL rather than '' -- "we were
 * not told" and "we were told nothing" are different facts during triage.
 */
export function cap(value: unknown, max: number): string | null {
  if (value == null) return null
  const text = String(value)
  if (!text.trim()) return null
  if (text.length <= max) return text
  return text.slice(0, max) + TRUNCATION_MARKER
}

/**
 * Read at most `maxBytes` of the request body.
 *
 * Streams and stops, rather than `request.text()` then slice: the point of a cap on an open
 * unauthenticated endpoint is that an oversized body is never fully buffered, and slicing after
 * the fact buffers it first.
 *
 * `Content-Length` is deliberately not consulted at all. It is client-supplied, absent under
 * chunked encoding, and free to disagree with what actually arrives -- so a cap that believed it
 * would be a cap an attacker sets. The only number that governs anything here is the one counted
 * off the stream.
 *
 * Falls back to `request.text()` when there is no readable stream, which is the case under jest
 * and in some Node fetch implementations. That path applies the same ceiling by slicing; it is a
 * test-shaped path, not the Worker one.
 */
export async function readCappedBody(
  request: Request,
  maxBytes: number = MAX_BODY_BYTES,
): Promise<CappedBody> {
  const body = (request as Request & { body?: ReadableStream<Uint8Array> | null }).body
  if (!body || typeof body.getReader !== 'function') {
    let text = ''
    try {
      text = await request.text()
    } catch {
      return { text: '', truncated: false }
    }
    if (text.length > maxBytes) return { text: text.slice(0, maxBytes), truncated: true }
    return { text, truncated: false }
  }

  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  let truncated = false
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value) continue
      if (total + value.byteLength > maxBytes) {
        chunks.push(value.subarray(0, maxBytes - total))
        total = maxBytes
        truncated = true
        break
      }
      chunks.push(value)
      total += value.byteLength
    }
  } catch {
    // A stream that dies mid-report still yields whatever arrived. Partial is better than none.
  } finally {
    try {
      await reader.cancel()
    } catch {
      /* the request is over either way */
    }
  }

  const joined = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    joined.set(chunk, offset)
    offset += chunk.byteLength
  }
  // `stream: false` on a cut buffer can leave a partial multi-byte character; the decoder emits a
  // replacement char rather than throwing, which is the behaviour we want here.
  return { text: new TextDecoder('utf-8', { fatal: false }).decode(joined), truncated }
}

/**
 * The only URL transform. Origin and query and hash are discarded; the pathname survives.
 *
 * Ruling 2 in the docblock. Note the parse is anchored by a dummy base so a caller sending a bare
 * path (or nonsense) does not throw -- an unparseable value yields null and the report still
 * lands without one.
 */
export function sanitizePagePath(raw: unknown): string | null {
  if (raw == null) return null
  const text = String(raw).trim()
  if (!text) return null
  let pathname: string
  try {
    // Base is only used when `text` is relative; an absolute URL ignores it entirely.
    pathname = new URL(text, 'https://crash.invalid').pathname
  } catch {
    return null
  }
  if (!pathname || pathname === '/') return pathname || null
  return cap(pathname, MAX_PAGE_PATH)
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Pull the restaurant id out of a sanitised path, e.g. `/menu/<uuid>/browse`.
 *
 * Ruling 3. Returns null unless the segment after `/menu/` is uuid-shaped, because the column is
 * `uuid` and a non-uuid value would make the INSERT fail -- which would discard the crash report
 * over a detail that is optional to it.
 */
export function restaurantIdFromPath(path: string | null): string | null {
  if (!path) return null
  const parts = path.split('/').filter(Boolean)
  if (parts[0] !== 'menu') return null
  const candidate = parts[1]
  if (!candidate || !UUID.test(candidate)) return null
  return candidate.toLowerCase()
}

type RawReport = {
  boundary?: unknown
  reference?: unknown
  digest?: unknown
  name?: unknown
  message?: unknown
  stack?: unknown
  pageUrl?: unknown
}

/**
 * Turn a capped body plus the one header we keep into the row to insert.
 *
 * Never throws and never signals rejection: every path returns a row. An unparseable body becomes
 * a row whose `error_message` is the raw truncated text, marked, because a report we cannot read
 * is still evidence that something crashed and roughly what it said -- and losing it would be the
 * "refused for being long" failure arriving by a different door.
 *
 * `restaurantId` is NOT read from `raw`, deliberately. See ruling 3.
 */
export function buildCrashReportRow(body: CappedBody, userAgent: string | null): CrashReportRow {
  const row: CrashReportRow = {
    boundary: null,
    reference: null,
    digest: null,
    error_name: null,
    error_message: null,
    error_stack: null,
    page_path: null,
    restaurant_id: null,
    user_agent: cap(userAgent, MAX_USER_AGENT),
    truncated: body.truncated,
  }

  let raw: RawReport | null = null
  try {
    const parsed: unknown = JSON.parse(body.text)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      raw = parsed as RawReport
    }
  } catch {
    raw = null
  }

  if (!raw) {
    row.error_name = 'UnparseableCrashReport'
    row.error_message = cap(body.text, MAX_DESCRIPTION)
    row.truncated = true
    return row
  }

  row.boundary = cap(raw.boundary, MAX_BOUNDARY)
  row.reference = cap(raw.reference, MAX_REFERENCE)
  row.digest = cap(raw.digest, MAX_DIGEST)
  row.error_name = cap(raw.name, MAX_ERROR_NAME)
  row.error_message = cap(raw.message, MAX_ERROR_MESSAGE)
  row.error_stack = cap(raw.stack, MAX_STACK)
  row.page_path = sanitizePagePath(raw.pageUrl)
  row.restaurant_id = restaurantIdFromPath(row.page_path)

  return row
}
