/**
 * #348 -- rate limiting for POST /api/crash-reports.
 *
 * WHY THIS EXISTS. `/api/crash-reports` is an UNAUTHENTICATED write on a payment product. It has
 * to be: the customer whose screen has just crashed has no staff session, and on the QR surface
 * has no account at all, so any auth requirement turns the boundary's "We have been sent the
 * details automatically" back into a lie for exactly the population it was written for. The
 * price of that is an open write, and the mitigation for an open write is a limit.
 *
 * THE SHAPE IS DELIBERATELY THE SAME AS lib/terminals/activation-rate-limit.ts, which is the only
 * other unauthenticated route with a limit. Same Cloudflare `ratelimit` binding, same fail-open
 * behaviour, same `unenforced` flag so the log can tell "allowed" from "never asked", and the
 * SAME key derivation -- imported below rather than copied, so the precedence between
 * `CF-Connecting-IP` and the spoofable `x-forwarded-for` has one implementation and cannot drift
 * on one route and not the other. A second shape here would be a second thing to get wrong.
 *
 * IT FAILS OPEN, and here that is a weaker claim than it is for activation. Losing the limit on
 * activation leaves the CSPRNG code as the real security boundary; losing it here leaves nothing
 * but the caps in crash-report-intake.ts. It is still the right default: this endpoint's entire
 * purpose is to receive a report from a browser that is already broken, and a misconfigured
 * binding that silently DISCARDED crash reports would reproduce the 2026-08-26 outage's actual
 * defect -- a failure nobody was told about -- inside the fix for it. The `unenforced` warning is
 * what makes that state visible rather than invisible.
 *
 * WHY THE LIMIT IS HIGHER THAN ACTIVATION'S 5. A venue's customers share one NAT'd public IP, so
 * `CF-Connecting-IP` is per-VENUE here, not per-person. The failure this endpoint exists to
 * capture is a deploy that breaks a render path, which crashes every customer in the room within
 * the same minute -- the incident and the flood look identical from the key's point of view, and
 * of the two, silently dropping the incident is the worse outcome. 30/minute is high enough that
 * a full room's genuine reports arrive and low enough that a single host cannot use this as a
 * write amplifier against the database.
 */
import { activationRateLimitKey } from '@/lib/terminals/activation-rate-limit'

/** Attempts allowed per key per window. Per VENUE, not per customer -- see the docblock. */
export const CRASH_REPORT_RATE_LIMIT = 30
/** Cloudflare's ratelimit binding accepts 10 or 60 seconds only. */
export const CRASH_REPORT_RATE_PERIOD_SECONDS = 60

export type CrashReportRateLimitOutcome = {
  allowed: boolean
  /** True when no binding was reachable, so `allowed` is a default rather than a decision. */
  unenforced: boolean
  retryAfterSeconds: number
}

type RateLimiterBinding = {
  limit: (options: { key: string }) => Promise<{ success: boolean }>
}

/**
 * The caller's key.
 *
 * Re-exported from the terminals module on purpose: the header precedence there
 * (`CF-Connecting-IP` before `x-forwarded-for`, and one SHARED key for a caller with no usable
 * IP rather than a private bucket each) is the part that is easy to get subtly wrong, and one
 * copy of it is auditable where two are not. The name is aliased at the import sites that care.
 */
export { activationRateLimitKey as crashReportRateLimitKey } from '@/lib/terminals/activation-rate-limit'

/**
 * Ask the Cloudflare rate-limit binding whether this key may proceed.
 *
 * Never throws. Any failure -- no Workers context, no binding declared, the binding rejecting --
 * resolves to `{ allowed: true, unenforced: true }`.
 */
export async function checkCrashReportRateLimit(
  request: Request,
): Promise<CrashReportRateLimitOutcome> {
  const unenforced: CrashReportRateLimitOutcome = {
    allowed: true,
    unenforced: true,
    retryAfterSeconds: 0,
  }

  let binding: RateLimiterBinding | undefined
  try {
    const { getCloudflareContext } = await import('@opennextjs/cloudflare')
    // `unknown` first: CloudflareEnv is a generated interface with no index signature, so a
    // direct cast is rejected. The binding is declared in wrangler.*.toml, not in that type.
    const context = getCloudflareContext() as unknown as { env?: Record<string, unknown> } | undefined
    const candidate = context?.env?.CRASH_REPORT_RATE_LIMITER
    if (candidate && typeof (candidate as RateLimiterBinding).limit === 'function') {
      binding = candidate as RateLimiterBinding
    }
  } catch {
    return unenforced
  }

  if (!binding) return unenforced

  try {
    const { success } = await binding.limit({ key: activationRateLimitKey(request) })
    return {
      allowed: success,
      unenforced: false,
      retryAfterSeconds: success ? 0 : CRASH_REPORT_RATE_PERIOD_SECONDS,
    }
  } catch (error) {
    console.error('[crash-reports] rate limiter threw; allowing the request', error)
    return unenforced
  }
}
