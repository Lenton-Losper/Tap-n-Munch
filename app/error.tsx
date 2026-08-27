'use client'

/**
 * #348, half 2 -- the ROOT error boundary.
 *
 * WHAT IT COVERS. Sitting at app/error.tsx this is the boundary of last resort for every segment
 * that has no nearer one: the whole customer QR surface (/menu/**, /order-confirmation,
 * /flashtap-pay), the marketing and auth pages, /admin, /onboarding -- and app/(staff)/layout.tsx
 * itself, which app/(staff)/error.tsx provably cannot catch, because in the App Router a boundary
 * never catches a throw in its OWN segment's layout. That last one matters: ProtectedRoute and
 * DashboardShell both live in that layout, so before this file existed a throw in either replaced
 * the entire staff app with Next's default "Application error: a client-side exception has
 * occurred" and wrote nothing anywhere.
 *
 * It does NOT catch a throw in app/layout.tsx or app/providers.tsx. That needs app/global-error.tsx,
 * which is a different thing -- it replaces <html> and cannot use the app's own shell -- and is
 * deliberately not attempted here.
 *
 * THE AUDIENCE IS MIXED, AND THAT CONSTRAINS THE COPY. The same screen is shown to a customer
 * holding a phone at a table and to a staff member whose dashboard layout threw. So it cannot say
 * "your order" and it cannot say "the till"; app/(staff)/error.tsx keeps its own signed staff
 * wording for the case where the audience IS known, and this one has to work for either reader.
 *
 * ONE SENTENCE IS DELIBERATELY SHARED WITH THE STAFF BOUNDARY: "we have been sent the details
 * automatically." The owner signed it for this surface on 2026-08-27 as audience-neutral. Reusing
 * a string signed for one surface on another is a ruling, and it was made -- not an inference
 * drawn here.
 *
 * COPY IS SIGNED, 2026-08-27, verbatim. Pinned character-for-character by
 * __tests__/348-root-boundary-copy-signed-off.test.ts. Do not reword, re-wrap or re-punctuate.
 *
 * REPORTING. This posts to /api/crash-reports, the UNAUTHENTICATED intake (#348 half 1), and
 * explicitly does not look a staff token up: a customer on the QR surface has no Supabase auth
 * session, so asking for one can only fail, and would be how a staff credential ended up attached
 * to a report from a page that has nothing to do with staff.
 */

import { useEffect, useRef } from 'react'
import {
  CRASH_REPORT_INTAKE_PATH,
  errorReference,
  reportBoundaryError,
} from '@/lib/errors/report-boundary-error'

export const ROOT_ERROR_BOUNDARY_ID = 'app/error.tsx'

/**
 * SIGNED OFF by the owner 2026-08-27, verbatim.
 *
 * The constraint the signer worked under, kept so it does not have to be rediscovered by whoever
 * proposes the next reword: this screen is shown to BOTH a customer at a table and a staff member
 * whose dashboard layout threw, so it cannot name an order, a payment, a till or a dashboard.
 */
export const ROOT_BOUNDARY_COPY = {
  /** Neutral as to who is reading it. */
  title: 'this screen has stopped working',

  /**
   * The failure is this screen, not the order or the payment behind it. Names no till, dashboard
   * or card machine -- a customer has none of those -- and does not promise an order exists,
   * because a crash on the menu means there may be no order at all.
   */
  body:
    'it is this screen that failed, not anything behind it. nothing has been lost and nothing ' +
    'has been charged twice.',

  /** A button, so it reads as one. */
  action: 'load this page again',

  /**
   * Two halves. The first is the only recovery route a customer at a table actually has.
   *
   * The second — 'we have been sent the details automatically.' — is the staff boundary's signed
   * sentence, and the owner signed it for THIS surface on 2026-08-27 as audience-neutral. It is a
   * FACTUAL CLAIM and it is true only because of the `reportBoundaryError` call below, which
   * posts to the unauthenticated crash intake. **If that call is ever removed, this half of the
   * string must go with it** — a page telling a customer their crash was reported when nothing
   * was sent is worse than saying nothing.
   */
  sub: 'if it keeps happening, ask a member of staff. we have been sent the details automatically.',

  /** Rendered as `<label> <code>`; the code is what someone reads out to us. */
  referenceLabel: 'Reference:',
} as const

export default function RootError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  const reference = errorReference(error)
  const reportedRef = useRef(false)

  useEffect(() => {
    // Not awaited, and nothing below depends on it. The screen renders whether or not a report is
    // possible -- offline, no network at all, or the intake itself returning 500.
    if (reportedRef.current) return
    reportedRef.current = true
    void reportBoundaryError(
      {
        boundary: ROOT_ERROR_BOUNDARY_ID,
        reference,
        digest: error?.digest,
        name: error?.name,
        message: error?.message,
        stack: error?.stack,
        pageUrl: typeof window !== 'undefined' ? window.location.href : undefined,
      },
      {
        intakePath: CRASH_REPORT_INTAKE_PATH,
        // See the file header: a customer has no Supabase auth session, so the lookup can only
        // fail, and asking is how a staff bearer would end up on a customer's crash report.
        authenticate: false,
      },
    )
  }, [error, reference])

  const reload = () => {
    // A real reload, not reset(). reset() re-renders the same segment from the same client bundle,
    // which for the failure class this exists for -- a module-level defect in the route's own
    // component -- re-throws instantly and reads as a dead button. A reload re-fetches the RSC
    // payload and picks up a fix deploy. reset() is kept as the fallback so the control is never
    // inert if navigation is blocked.
    try {
      window.location.reload()
    } catch {
      try {
        reset()
      } catch {
        /* nothing further to try; the screen and its instructions remain on-screen */
      }
    }
  }

  return (
    <div className="flex min-h-[60vh] items-center justify-center px-4 py-12">
      <div className="w-full max-w-lg rounded-2xl border border-[#E5E3DE] bg-white p-8 text-center shadow-sm">
        <h1 className="text-xl font-semibold text-[#37352F]">
          {ROOT_BOUNDARY_COPY.title}
        </h1>

        <p className="mt-4 text-sm leading-relaxed text-[#6B675F]">
          {ROOT_BOUNDARY_COPY.body}
        </p>

        <button
          type="button"
          onClick={reload}
          className="mt-6 inline-flex h-10 items-center justify-center rounded-lg bg-[#37352F] px-5 text-sm font-medium text-white transition-colors hover:bg-[#4A4740]"
        >
          {ROOT_BOUNDARY_COPY.action}
        </button>

        <p className="mt-6 text-sm leading-relaxed text-[#6B675F]">
          {ROOT_BOUNDARY_COPY.sub}
        </p>

        <p className="mt-4 font-mono text-xs text-[#9B968C]">
          {ROOT_BOUNDARY_COPY.referenceLabel} {reference}
        </p>
      </div>
    </div>
  )
}
