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
 * Intake is POST /api/bug-reports (staff-authenticated, writes bug_reports for the ops inbox).
 */
import { getAccessToken } from '@/lib/onboarding/api-client'

/** The intake route. Exported so a test can assert the destination rather than restate it. */
export const BUG_REPORT_INTAKE_PATH = '/api/bug-reports'

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
 * Files the crash. Resolves an outcome; never rejects, and never throws synchronously.
 *
 * Note the token is attached only when one is available, but the POST goes out either way. The
 * intake decides whether an unauthenticated report is acceptable -- that is a server-side policy
 * question, and dropping the request client-side would hide from ops that anything happened.
 */
export async function reportBoundaryError(
  context: BoundaryErrorContext,
): Promise<BoundaryReportOutcome> {
  const outcome: BoundaryReportOutcome = {
    attempted: false,
    delivered: false,
    authenticated: false,
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
    // token lookup is treated as allowed to fail rather than as a precondition.
    let token: string | null = null
    try {
      token = await getAccessToken()
    } catch {
      token = null
    }
    outcome.authenticated = Boolean(token)

    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (token) headers.Authorization = `Bearer ${token}`

    const body = JSON.stringify({
      description: describeFailure(context),
      area: BOUNDARY_REPORT_AREA,
      pageUrl: context.pageUrl,
    })

    // keepalive: the signed action reloads the page, and an in-flight report would otherwise be
    // cancelled by the navigation the venue is being told to perform.
    const response = await fetchAndMark(outcome, headers, body)
    outcome.delivered = Boolean(response && response.ok)
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
  headers: Record<string, string>,
  body: string,
): Promise<Response | null> {
  const request = fetch(BUG_REPORT_INTAKE_PATH, {
    method: 'POST',
    headers,
    body,
    keepalive: true,
  })
  outcome.attempted = true
  return (await request) ?? null
}
