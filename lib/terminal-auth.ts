import { jwtVerify } from 'jose'

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

  let payload: Awaited<ReturnType<typeof jwtVerify>>['payload']
  try {
    ;({ payload } = await jwtVerify(token, secret))
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
