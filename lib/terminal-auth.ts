import { jwtVerify, decodeProtectedHeader, importJWK } from 'jose'
import { findSigningKey } from '@/lib/terminals/signing-keys'

const secret = new TextEncoder().encode(
  process.env.TERMINAL_JWT_SECRET!
)

/**
 * EVERY AUTH FAILURE LEAVES THIS MODULE AS A `Response`. ONE SHAPE, NOT TWO.
 *
 * ============================================================================================
 * THE DEFECT THIS CLOSES, MEASURED ON PRODUCTION 2026-08-26
 * ============================================================================================
 *
 * This function used to throw two different things:
 *
 *   missing / non-Bearer header  ->  a `Response` carrying 401
 *   malformed or EXPIRED token   ->  whatever `jwtVerify` threw, a JOSEError
 *
 * Every caller handles the first with `if (err instanceof Response) return err` and then falls
 * through to its own default for the second. Those defaults are 500 (six routes), 502 (two of
 * them, including verify-payment) — anything but 401.
 *
 * `POST /api/terminal/held-payments` was measured on all four production hostnames minutes after
 * deploy: `no token -> 401`, `Bearer not-a-real-token -> 500`.
 *
 * WHY THAT IS A DEVICE THAT CANNOT RECOVER. `terminalFetch` in the terminal app refreshes the
 * access token and retries on **401**. It does not on 500 or 502. Terminal tokens last ONE HOUR.
 * So the ordinary, expected event of a token ageing out produced a response the device could not
 * interpret as "refresh and retry" — and the device would keep getting it until the app was
 * restarted. On `verify-payment` that is the "Check payment status" button, which is #327's primary
 * action and the instruction #346's over-ceiling copy tells staff to follow.
 *
 * FIXED HERE RATHER THAN IN THE SIX CALLERS. The callers were not each wrong in their own way; they
 * were all correct about the contract they were given and the contract was two-shaped. Normalising
 * at the source fixes every existing caller, including the two that answer 502, and means the next
 * route written against this function cannot inherit the bug. Six local edits would have left the
 * seventh route to rediscover it.
 *
 * A JOSEError is not logged or wrapped with detail: an expired token, a forged one and a truncated
 * one are all just "not authenticated" to the caller, and the difference is not the device's
 * business.
 */
export async function requireTerminalAuth(req: Request) {
  const auth = req.headers.get('authorization')
  if (!auth?.startsWith('Bearer ')) {
    throw new Response(
      JSON.stringify({ error: 'Missing terminal token' }),
      { status: 401 }
    )
  }
  const token = auth.replace('Bearer ', '')

  /**
   * TWO VERIFICATION PATHS, DELIBERATELY, FOR AS LONG AS ANY HS256 TOKEN CAN STILL BE IN THE FIELD.
   *
   * Phase A switched issuance to ES256 (lib/terminals/signing-keys.ts). Tokens live an hour, and a
   * till asleep in a drawer can present a valid HS256 token well after the deploy. Refusing those
   * would log the estate out mid-service to no purpose, so both are accepted:
   *
   *   header carries a known kid  ->  ES256, verified against that published public key
   *   no kid                      ->  HS256, verified against TERMINAL_JWT_SECRET, as before
   *
   * WHICH PATH RAN IS LOGGED, because retirement has to be evidenced rather than assumed. The
   * HS256 branch comes out only once no token has taken it for seven consecutive days, read from
   * these logs. A kid we do not recognise falls through to HS256 and fails there — it is not
   * trusted just for carrying a kid.
   */
  let payload: Awaited<ReturnType<typeof jwtVerify>>['payload']
  try {
    let kid: string | undefined
    try {
      kid = decodeProtectedHeader(token).kid
    } catch {
      kid = undefined
    }

    const signingKey = findSigningKey(kid)
    if (signingKey) {
      const publicKey = await importJWK(signingKey.jwk, 'ES256')
      ;({ payload } = await jwtVerify(token, publicKey))
      console.log('[terminal-auth] verified via ES256', { kid })
    } else {
      ;({ payload } = await jwtVerify(token, secret))
      console.log('[terminal-auth] verified via HS256 (legacy path still in use)')
    }
  } catch {
    // Expired, malformed, wrong signature — all of them are 401, and 401 is the status that makes
    // the device refresh its token and retry.
    throw new Response(
      JSON.stringify({ error: 'Invalid terminal token' }),
      { status: 401 }
    )
  }

  if (payload.type !== 'terminal') {
    throw new Response(
      JSON.stringify({ error: 'Invalid token type' }),
      { status: 403 }
    )
  }
  return {
    terminalId: String(payload.sub),
    restaurantId: String(payload.restaurant_id),
    deviceSerial: String(payload.device_serial),
    permissions: (payload.permissions as string[]) || [],
  }
}

export async function validateTerminalRecord(
  supabase: any,
  terminal: any
) {
  const { data, error } = await supabase
    .from('restaurant_terminals')
    .select('id, status, restaurant_id, device_serial')
    .eq('id', terminal.terminalId)
    .eq('restaurant_id', terminal.restaurantId)
    .single()

  if (error || !data) {
    throw new Response(
      JSON.stringify({ error: 'Terminal not recognized' }),
      { status: 401 }
    )
  }
  if (data.status !== 'active') {
    throw new Response(
      JSON.stringify({ error: 'Terminal is not active' }),
      { status: 403 }
    )
  }
  return data
}
