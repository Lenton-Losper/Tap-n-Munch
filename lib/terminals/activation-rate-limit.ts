/**
 * #241, second half — rate limiting for POST /api/terminals/activate.
 *
 * WHY THIS ROUTE AND WHY EDGE-LEVEL. `activate` is the one unauthenticated route that mints a
 * terminal JWT, and that token carries `orders:update` — which gates settle, table close, and
 * marking an order paid. The activation code is the whole credential. It is now CSPRNG-generated
 * (see activation-code.ts) so guessing is not the realistic attack, but the route had no limit of
 * any kind: unlimited attempts, no lockout, and no signal to anyone that it was happening.
 *
 * WHY NOT A DATABASE COUNTER, which is what the neighbouring PIN lockout uses. Two reasons, and
 * the first is decisive:
 *
 *   1. A FAILED ACTIVATION KNOWS NO RESTAURANT. The code matched nothing, so there is no
 *      restaurant_id -- and both audit tables (`audit_logs`, `authorization_events`) declare
 *      restaurant_id NOT NULL. The attempt that most needs recording is the one they cannot hold.
 *   2. A row per attempt turns a guessing attack into a write amplification attack against our own
 *      database. The mitigation would become the outage.
 *
 * `terminal/authorize`'s DB lockout is right for ITS case -- an authenticated staff member
 * mistyping a PIN, where the restaurant is known and the volume is human. This is not that case.
 *
 * WHY NOT KV. The only bound namespace is `NEXT_CACHE_WORKERS_KV`, which belongs to OpenNext's
 * incremental cache. Counters living there are at the mercy of a cache purge, and KV's write
 * ceiling of roughly one per second per key is below what an attack produces by definition.
 *
 * IT FAILS OPEN, DELIBERATELY, AND SAYS SO LOUDLY. With no binding -- local `next dev`, jest, or a
 * worker deployed before the config lands -- activation proceeds. Failing closed would mean a
 * misconfigured binding BRICKS TERMINAL ACTIVATION for every device, which is far worse than the
 * hole being closed: a venue with a dead terminal and no way to activate a replacement cannot
 * trade. The security boundary here is the CSPRNG code, not this; this buys lockout and a signal.
 * That is the opposite of #266's ruling on SUPABASE_SERVICE_ROLE_KEY, and deliberately so -- there,
 * a missing secret silently DOWNGRADED authority (service_role to anon) while the app kept working,
 * so failing the deploy was the only way anyone would notice. Here a missing binding removes a
 * mitigation without changing what anyone is authorised to do.
 */

/** Attempts allowed per key per window. A human activating a terminal needs one, maybe two. */
export const ACTIVATION_RATE_LIMIT = 5
/** Cloudflare's ratelimit binding accepts 10 or 60 seconds only. */
export const ACTIVATION_RATE_PERIOD_SECONDS = 60

export type RateLimitOutcome = {
  allowed: boolean
  /** True when no binding was reachable, so `allowed` is a default rather than a decision. */
  unenforced: boolean
  retryAfterSeconds: number
}

type RateLimiterBinding = {
  limit: (options: { key: string }) => Promise<{ success: boolean }>
}

/**
 * The caller's IP, from Cloudflare's own header first.
 *
 * `CF-Connecting-IP` is set by the edge and cannot be spoofed by the client; `x-forwarded-for` can
 * be, and is only a fallback for non-Cloudflare contexts (local dev, tests). Keying on a
 * client-supplied value would let an attacker rotate the key per request and defeat the limit
 * entirely, so the order of these matters more than it looks.
 *
 * A request with no usable IP gets a single shared key rather than a unique one: an unkeyable
 * caller must not get its own private bucket.
 */
export function activationRateLimitKey(request: Request): string {
  const cf = request.headers.get('CF-Connecting-IP')
  if (cf && cf.trim()) return cf.trim()

  const xff = request.headers.get('x-forwarded-for')
  if (xff && xff.trim()) {
    // Left-most entry is the original client; the rest are proxies.
    const first = xff.split(',')[0]?.trim()
    if (first) return first
  }

  const real = request.headers.get('x-real-ip')
  if (real && real.trim()) return real.trim()

  return 'unknown-origin'
}

/**
 * Ask the Cloudflare rate-limit binding whether this key may proceed.
 *
 * Never throws. Any failure -- no Workers context, no binding declared, the binding rejecting --
 * resolves to `{ allowed: true, unenforced: true }` so the caller can log the difference between
 * "allowed because it is under the limit" and "allowed because nothing was asked".
 */
export async function checkActivationRateLimit(request: Request): Promise<RateLimitOutcome> {
  const unenforced: RateLimitOutcome = {
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
    const candidate = context?.env?.ACTIVATION_RATE_LIMITER
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
      retryAfterSeconds: success ? 0 : ACTIVATION_RATE_PERIOD_SECONDS,
    }
  } catch (error) {
    console.error('[terminals/activate] rate limiter threw; allowing the request', error)
    return unenforced
  }
}
