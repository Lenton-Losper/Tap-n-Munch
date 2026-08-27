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
 * "your order" and it cannot say "the till"; app/(staff)/error.tsx keeps the signed staff wording
 * for the case where the audience IS known, and this one has to work for either reader. That is
 * why none of the staff copy is reused verbatim below even though the sentence "We have been sent
 * the details automatically." would read correctly here -- reusing a string signed for one surface
 * on a different surface is the owner's call, not this file's.
 *
 * COPY IS NOT SIGNED. Every user-visible string below carries a `PENDING COPY` marker and is
 * therefore blocked from the production deploy by scripts/check-no-pending-copy.mjs. That is the
 * intended state, not an oversight: what is genuinely new here is wording, and wording is a
 * ruling. See PENDING_ROOT_BOUNDARY_COPY for what each string has to convey.
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
 * Placeholders, not wording. Each entry names what the final string has to convey; none of it is
 * a draft to be tidied up into the real thing.
 *
 * The constraint the signer is working under, recorded so it does not have to be rediscovered:
 * this screen is shown to BOTH a customer at a table and a staff member whose dashboard layout
 * threw, so it cannot name an order, a payment, a till or a dashboard.
 */
export const PENDING_ROOT_BOUNDARY_COPY = {
  /** Must convey: this screen has stopped working. Neutral as to who is reading it. */
  title: 'PENDING COPY: root_boundary_title — this screen has stopped working',

  /**
   * Must convey: nothing has been lost and nothing has been charged twice; the failure is this
   * screen, not the order or the payment behind it. Must NOT name a till, a dashboard or a card
   * machine -- a customer has none of those -- and must not promise an order exists, because a
   * crash on the menu means there may be no order at all.
   */
  body:
    'PENDING COPY: root_boundary_body — the failure is this screen and nothing behind it; ' +
    'nothing has been lost and nothing has been charged twice',

  /** Must convey: load the page again. It is a button, so it has to read as one. */
  action: 'PENDING COPY: root_boundary_action — load this page again',

  /**
   * Must convey: if it keeps happening, ask a member of staff -- the one recovery route a
   * customer at a table actually has -- AND the factual claim that the details have already been
   * sent to us without anyone filing anything. That second half must not be written unless it is
   * true; it is true because of the reportBoundaryError call below, and if that call is ever
   * removed this string has to go with it.
   */
  sub:
    'PENDING COPY: root_boundary_sub — if it keeps happening ask a member of staff; the details ' +
    'have already been sent to us automatically',

  /**
   * Must convey: the label for the short code beneath, which is what someone reads out to us.
   * Rendered as `<label> <code>`, so it needs whatever punctuation that requires.
   */
  referenceLabel: 'PENDING COPY: root_boundary_reference_label — label for the code below',
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
          {PENDING_ROOT_BOUNDARY_COPY.title}
        </h1>

        <p className="mt-4 text-sm leading-relaxed text-[#6B675F]">
          {PENDING_ROOT_BOUNDARY_COPY.body}
        </p>

        <button
          type="button"
          onClick={reload}
          className="mt-6 inline-flex h-10 items-center justify-center rounded-lg bg-[#37352F] px-5 text-sm font-medium text-white transition-colors hover:bg-[#4A4740]"
        >
          {PENDING_ROOT_BOUNDARY_COPY.action}
        </button>

        <p className="mt-6 text-sm leading-relaxed text-[#6B675F]">
          {PENDING_ROOT_BOUNDARY_COPY.sub}
        </p>

        <p className="mt-4 font-mono text-xs text-[#9B968C]">
          {PENDING_ROOT_BOUNDARY_COPY.referenceLabel} {reference}
        </p>
      </div>
    </div>
  )
}
