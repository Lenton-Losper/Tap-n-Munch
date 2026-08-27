import { NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import {
  CRASH_REPORT_RATE_PERIOD_SECONDS,
  checkCrashReportRateLimit,
} from '@/lib/crash-reports/crash-report-rate-limit'
import { buildCrashReportRow, readCappedBody } from '@/lib/crash-reports/crash-report-intake'

export const dynamic = 'force-dynamic'

/**
 * #348 -- UNAUTHENTICATED intake for automatic crash reports from App Router error boundaries.
 *
 * WHY IT IS NOT /api/bug-reports. That route calls getUserFromRequest and 500s without a staff
 * session. The boundary's signed line -- "We have been sent the details automatically" -- is a
 * factual claim, and on the QR surface the reader of that line has no account to have a session
 * for. Requiring auth would leave the claim false for every customer, and false in precisely the
 * case the staff route already handles badly: a dead session is one of the things that can PUT a
 * staff member on the error screen, so today a session-expiry crash reports nowhere either.
 *
 * WHY IT IS NOT THE SAME TABLE. bug_reports is the ops inbox: staff read their own venue's rows
 * through RLS, and /admin/bug-reports triages them. Letting an anonymous caller write into a
 * table other people READ turns an open write into a content-injection surface aimed at staff,
 * and mixes an automatic flood into a queue meant for things a human chose to file. crash_reports
 * is a separate table with no anon or authenticated policy at all -- service role writes, nothing
 * else touches it.
 *
 * ITS ABUSE DEFENCES, in the order the request meets them:
 *   1. Rate limit, BEFORE the body is read, so a flood costs as little per request as possible.
 *      Cloudflare binding, per CF-Connecting-IP; fails open with a logged `unenforced` flag.
 *   2. A hard byte ceiling on the body, applied while STREAMING it, so an oversized body is never
 *      fully buffered.
 *   3. Per-field ceilings, and every one of them TRUNCATES. Nothing here answers 413: a crash
 *      report refused for being long is a crash report you do not get.
 *   4. A default-deny URL transform -- path only, query and origin discarded -- and a restaurant
 *      id DERIVED from that path rather than accepted from the body.
 * See lib/crash-reports/crash-report-intake.ts for the reasoning behind 2-4.
 *
 * WHAT IT DOES NOT READ: cookies, Authorization, any session or tab token. The caller's IP is
 * used as a rate-limit bucket key and is never stored.
 *
 * NO CORS HEADERS, deliberately. Same-origin is all any boundary needs, and adding
 * Access-Control-Allow-Origin would hand every other site on the internet a browser-driven way to
 * write here.
 */
export async function POST(request: Request) {
  try {
    const rateLimit = await checkCrashReportRateLimit(request)
    if (!rateLimit.allowed) {
      console.warn('[crash-reports] rate limited')
      return NextResponse.json(
        { accepted: false },
        {
          status: 429,
          headers: {
            'Retry-After': String(
              rateLimit.retryAfterSeconds || CRASH_REPORT_RATE_PERIOD_SECONDS,
            ),
          },
        },
      )
    }
    if (rateLimit.unenforced) {
      console.warn('[crash-reports] rate limiting is NOT in force -- no binding reachable')
    }

    const body = await readCappedBody(request)
    const row = buildCrashReportRow(body, request.headers.get('user-agent'))

    // An empty body is the one thing with nothing to store. It is still not an error the caller
    // can do anything about, so it is a quiet 202 rather than a 400 -- the boundary is not going
    // to retry, and a 4xx here would only make the worker log look like the customer's fault.
    if (!row.error_name && !row.error_message && !row.error_stack && !row.reference) {
      return NextResponse.json({ accepted: false }, { status: 202 })
    }

    const supabase = createServerSupabaseClient()
    const { error } = await supabase.from('crash_reports').insert(row)

    if (error) {
      // Logged, not raised to the caller: the browser is already on an error screen and can do
      // nothing with this. The log is where this failure has to be visible, because a crash
      // intake that silently stops working reproduces the defect it was built for.
      console.error('[crash-reports] insert failed', error)
      return NextResponse.json({ accepted: false }, { status: 500 })
    }

    return NextResponse.json({ accepted: true }, { status: 202 })
  } catch (err) {
    console.error('[crash-reports] POST', err)
    return NextResponse.json({ accepted: false }, { status: 500 })
  }
}
