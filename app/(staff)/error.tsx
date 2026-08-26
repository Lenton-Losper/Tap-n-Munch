'use client'

/**
 * #348 -- the staff subtree's error boundary.
 *
 * Before this file existed there was no error.tsx or global-error.tsx anywhere under app/, so
 * Next's default boundary caught everything and replaced the tree with "Application error: a
 * client-side exception has occurred". On 2026-08-26 one missing import in
 * components/orders-dashboard.tsx (a ~2900-line component that IS the whole dashboard route)
 * therefore blanked the staff dashboard at every venue for ~26 hours across six deploys, and
 * nothing was written anywhere -- bug_reports had no row for it. It was found because the owner
 * happened to open the page.
 *
 * This file changes two things about that: the venue is told what is and is not affected, and a
 * report leaves the browser without anyone deciding to file one.
 *
 * SCOPE. Sitting at app/(staff)/ this catches every staff route -- dashboard, order-history,
 * stock, menu-management, staff, settings, analytics, qr-codes -- and renders INSIDE
 * app/(staff)/layout.tsx, so DashboardShell's navigation survives and staff can still reach the
 * routes that are working. It does NOT catch a throw in app/(staff)/layout.tsx itself
 * (ProtectedRoute / DashboardShell): in the App Router a boundary cannot catch its own segment's
 * layout, that needs a boundary in the parent segment. See the #348 report -- a root boundary is
 * warranted but cannot carry this copy, which is written for staff and would be wrong on the
 * customer QR surface that app/error.tsx also covers.
 *
 * COPY IS SIGNED. Every user-visible string below is verbatim from the #348 brief and must not
 * be reworded, including the ASCII hyphen in "not the till - the card machine". The only
 * substitution is {digest} in the reference line; see errorReference() for why that slot cannot
 * simply be error.digest.
 */

import { useEffect, useRef } from 'react'
import { errorReference, reportBoundaryError } from '@/lib/errors/report-boundary-error'

export const STAFF_ERROR_BOUNDARY_ID = 'app/(staff)/error.tsx'

export default function StaffError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  const reference = errorReference(error)
  const reportedRef = useRef(false)

  useEffect(() => {
    // Not awaited, and nothing below depends on it. The screen renders whether or not a report
    // is possible -- offline, dead session, or the intake itself returning 500.
    if (reportedRef.current) return
    reportedRef.current = true
    void reportBoundaryError({
      boundary: STAFF_ERROR_BOUNDARY_ID,
      reference,
      digest: error?.digest,
      name: error?.name,
      message: error?.message,
      stack: error?.stack,
      pageUrl: typeof window !== 'undefined' ? window.location.href : undefined,
    })
  }, [error, reference])

  const reload = () => {
    // The signed action says "Reload the dashboard", so it performs an actual reload rather than
    // reset(). reset() only re-renders the same segment from the same client bundle, which for
    // the failure class this exists for -- a module-level defect in the route's one component --
    // re-throws instantly and reads to staff as a dead button. A reload re-fetches the RSC
    // payload and picks up a fix deploy. reset() is kept as the fallback so the button is never
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
        <h1 className="text-xl font-semibold text-[#37352F]">This screen stopped working</h1>

        <p className="mt-4 text-sm leading-relaxed text-[#6B675F]">
          Your orders and payments are safe. This is the dashboard that failed, not the till - the
          card machine and the kitchen screen are unaffected, and nothing has been lost.
        </p>

        <button
          type="button"
          onClick={reload}
          className="mt-6 inline-flex h-10 items-center justify-center rounded-lg bg-[#37352F] px-5 text-sm font-medium text-white transition-colors hover:bg-[#4A4740]"
        >
          Reload the dashboard
        </button>

        <p className="mt-6 text-sm leading-relaxed text-[#6B675F]">
          If it keeps happening, carry on taking orders on the terminal and tell us. We have been
          sent the details automatically.
        </p>

        <p className="mt-4 font-mono text-xs text-[#9B968C]">Reference: {reference}</p>
      </div>
    </div>
  )
}
