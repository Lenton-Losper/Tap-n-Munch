/**
 * #348 -- best-effort crash reporting for App Router error boundaries.
 *
 * The staff boundary's copy ends "We have been sent the details automatically." That sentence is
 * only honest if a report actually leaves the browser, so this module is the thing that makes the
 * copy true, and __tests__/348-staff-error-boundary-reports.test.tsx is the thing that proves it.
 *
 * THE ONE RULE HERE: this must never be able to throw. It runs while the page is ALREADY in its
 * failure state; a rejection out of here would replace an explained error screen with the default
 * unexplained one, which is strictly worse than not reporting at all. Every step -- token lookup,
 * JSON encoding, fetch, response read -- is individually guarded, and the function resolves with
 * an outcome record instead of rejecting. Callers must still not await it on the render path.
 *
 * TWO INTAKES, and which one a boundary uses is the boundary's decision.
 *
 *   /api/bug-reports    staff-authenticated, writes bug_reports, lands in the ops inbox next to
 *                       the reports a human typed. The right destination when there IS a staff
 *                       session, because the row is attributed to a venue and a user.
 *   /api/crash-reports  unauthenticated, writes crash_reports. The only possible destination on
 *                       the customer QR surface, where there is no account to have a session for.
 *
 * The staff boundary uses the first with the second as a FALLBACK, which closes a hole this file
 * previously had: a dead session is one of the things that can put a staff member on the error
 * screen, and an unauthenticated POST to /api/bug-reports is a 500 -- so the crash that a session
 * expiry caused was the one crash that reported nowhere, while the screen said otherwise.
 */
import { getAccessToken } from '@/lib/onboarding/api-client'

/** The intake route. Exported so a test can assert the destination rather than restate it. */
export const BUG_REPORT_INTAKE_PATH = '/api/bug-reports'

/** The unauthenticated intake. #348, half 1. */
export const CRASH_REPORT_INTAKE_PATH = '/api/crash-reports'

/**
 * `area` is free text on bug_reports and renders as the badge in /admin/bug-reports triage.
 * A distinct value is what lets ops separate automatic crash reports from the ones a human
 * typed into the Report a Bug dialog, which all use 'Other'.
 */
export const BOUNDARY_REPORT_AREA = 'Automatic crash report'

export type BoundaryErrorContext = {
  /** Which boundary caught it, e.g. 'app/(staff)/error.tsx'. */
  boundary: string
  /** The reference shown to the venue -- Next's digest when there is one, else a fingerprint. */
  reference: string
  /** React/Next's error digest, when the throw came from a Server Component. Often absent. */
  digest?: string
  name?: string
  message?: string
  stack?: string
  pageUrl?: string
}

export type BoundaryReportOutcome = {
  /** A POST was actually issued at the intake. */
  attempted: boolean
  /** The intake accepted it (2xx). */
  delivered: boolean
  /** A bearer token was available and attached. */
  authenticated: boolean
  /** Set when no POST was issued, and why. */
  skipped?: 'duplicate' | 'no-fetch' | 'threw'
  /** Where the first POST was aimed. */
  intakePath?: string
  /** True when the primary intake failed and the unauthenticated one was tried instead. */
  fellBack?: boolean
}

export type BoundaryReportOptions = {
  /** Defaults to BUG_REPORT_INTAKE_PATH. */
  intakePath?: string
  /**
   * Whether to look a staff bearer token up and attach it. Defaults to true.
   *
   * The customer boundary passes false, and not as an optimisation: getAccessToken() reaches into
   * the Supabase BROWSER auth client, and a customer on the QR surface has no account there. On
   * that surface the lookup can only fail, and asking is how a staff credential would end up
   * attached to a report from a page that has nothing to do with staff.
   */
  authenticate?: boolean
  /**
   * Tried once, unauthenticated, when the primary intake does not answer 2xx. Nothing is retried
   * against the SAME path -- this is for "that intake cannot accept this caller", not for flaky
   * networks, and a boundary is the wrong place to run a retry loop.
   */
  fallbackPath?: string
}

/**
 * One report per distinct failure per page load. React can re-render a boundary, and a boundary
 * that re-reports on every render turns one outage into thousands of rows. A real reload clears
 * this, which is correct: that is a fresh occurrence.
 */
const alreadyReported = new Set<string>()

/** Test seam -- there is no other way to get a second report out of one module instance. */
export function __resetBoundaryReportDedupe() {
  alreadyReported.clear()
}

/**
 * A stable id for an error that has no digest.
 *
 * Next only mints a `digest` for Server Component throws. The 2026-08-26 outage was a CLIENT
 * render throw (ReferenceError from components/orders-dashboard.tsx), so it would have had no
 * digest at all and the signed "Reference:" line would have rendered empty. This fills the slot.
 *
 * Deliberately deterministic rather than random: a random id differs between the server and
 * client renders of the boundary and would trip a hydration mismatch -- inside an error screen,
 * of all places. Same failure therefore fingerprints the same across venues, which is a feature
 * for triage; created_at still separates the occurrences.
 */
export function errorReference(error: { digest?: string; name?: string; message?: string }): string {
  if (error?.digest) return String(error.digest)
  const seed = `${error?.name || 'Error'}|${error?.message || ''}`
  // FNV-1a, 32-bit. Not security-relevant; it only needs to be stable and short.
  let hash = 0x811c9dc5
  for (let i = 0; i < seed.length; i += 1) {
    hash ^= seed.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(36).padStart(7, '0')
}

/**
 * bug_reports has no column for a stack or a digest -- only `description` (text), `area`,
 * `page_url` and the reporter fields. So everything ops needs is folded into the description,
 * which is what /admin/bug-reports actually renders.
 */
function describeFailure(context: BoundaryErrorContext): string {
  const lines = [
    `Automatic crash report from ${context.boundary}`,
    `Reference: ${context.reference}`,
    `Error: ${context.name || 'Error'}: ${context.message || '(no message)'}`,
  ]
  if (context.digest) lines.push(`Next digest: ${context.digest}`)
  if (context.pageUrl) lines.push(`Page: ${context.pageUrl}`)
  if (context.stack) lines.push('', String(context.stack).split('\n').slice(0, 20).join('\n'))
  return lines.join('\n')
}

/**
 * The wire shape for one intake.
 *
 * The two intakes want different bodies because they write different tables. bug_reports has no
 * column for a stack or a digest, so describeFailure folds everything into prose; crash_reports
 * has a column per field, so nothing is folded and the fields stay queryable. Choosing on the
 * PATH rather than on a flag means a caller cannot aim at one intake while sending the other's
 * body.
 *
 * `pageUrl` is sent whole and reduced server-side rather than here. The customer surface puts
 * real material in the query string (`?name=`, `?tabId=`, the gateway's return payload), and the
 * enforcement point for that has to be the one an arbitrary caller cannot skip -- see
 * lib/crash-reports/crash-report-intake.ts, which keeps the path and discards the rest.
 */
function buildIntakeBody(intakePath: string, context: BoundaryErrorContext): string {
  if (intakePath === BUG_REPORT_INTAKE_PATH) {
    return JSON.stringify({
      description: describeFailure(context),
      area: BOUNDARY_REPORT_AREA,
      pageUrl: context.pageUrl,
    })
  }
  return JSON.stringify({
    boundary: context.boundary,
    reference: context.reference,
    digest: context.digest,
    name: context.name,
    message: context.message,
    stack: context.stack,
    pageUrl: context.pageUrl,
  })
}

/**
 * Files the crash. Resolves an outcome; never rejects, and never throws synchronously.
 *
 * Note the token is attached only when one is available, but the POST goes out either way. The
 * intake decides whether an unauthenticated report is acceptable -- that is a server-side policy
 * question, and dropping the request client-side would hide from ops that anything happened.
 */
export async function reportBoundaryError(
  context: BoundaryErrorContext,
  options: BoundaryReportOptions = {},
): Promise<BoundaryReportOutcome> {
  const intakePath = options.intakePath || BUG_REPORT_INTAKE_PATH
  const outcome: BoundaryReportOutcome = {
    attempted: false,
    delivered: false,
    authenticated: false,
    intakePath,
  }

  try {
    const key = `${context.boundary}|${context.reference}`
    if (alreadyReported.has(key)) {
      outcome.skipped = 'duplicate'
      return outcome
    }
    alreadyReported.add(key)

    if (typeof fetch !== 'function') {
      outcome.skipped = 'no-fetch'
      return outcome
    }

    // A dead or expiring session is one of the things that can put us on this screen, so the
    // token lookup is treated as allowed to fail rather than as a precondition. The customer
    // boundary skips it entirely -- see BoundaryReportOptions.authenticate.
    let token: string | null = null
    if (options.authenticate !== false) {
      try {
        token = await getAccessToken()
      } catch {
        token = null
      }
    }
    outcome.authenticated = Boolean(token)

    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (token) headers.Authorization = `Bearer ${token}`

    // keepalive: the signed action reloads the page, and an in-flight report would otherwise be
    // cancelled by the navigation the venue is being told to perform.
    const response = await fetchAndMark(
      outcome,
      intakePath,
      headers,
      buildIntakeBody(intakePath, context),
    )
    outcome.delivered = Boolean(response && response.ok)

    /**
     * ONE fallback, at a DIFFERENT path, and only on a non-2xx answer.
     *
     * The case this is for is specific: the staff intake refused this caller -- no session, or an
     * expired one -- which is a 500 rather than a throw, and is one of the ways a staff member
     * ends up on this screen in the first place. Retrying the same path would be pointless; the
     * unauthenticated intake can accept what the authenticated one cannot.
     *
     * A THROWN primary is deliberately NOT retried: that is the transport failing (offline, DNS,
     * the page being torn down), and the fallback shares the transport. Retrying it would cost a
     * second failing request on a screen that is already the failure path.
     */
    if (!outcome.delivered && options.fallbackPath && options.fallbackPath !== intakePath) {
      outcome.fellBack = true
      const fallback = await fetchAndMark(
        outcome,
        options.fallbackPath,
        { 'Content-Type': 'application/json' },
        buildIntakeBody(options.fallbackPath, context),
      )
      outcome.delivered = Boolean(fallback && fallback.ok)
    }
  } catch {
    // Swallowed on purpose. See the header comment: a throw here costs the venue the whole
    // explained error screen. `outcome` still records how far we got.
    if (!outcome.attempted) outcome.skipped = 'threw'
  }

  return outcome
}

/**
 * Split out only so `attempted` is set the instant the request is issued, before any await can
 * reject. Offline is attempted-but-not-delivered, which is a different fact from never trying.
 */
async function fetchAndMark(
  outcome: BoundaryReportOutcome,
  path: string,
  headers: Record<string, string>,
  body: string,
): Promise<Response | null> {
  const request = fetch(path, {
    method: 'POST',
    headers,
    body,
    keepalive: true,
  })
  outcome.attempted = true
  return (await request) ?? null
}
