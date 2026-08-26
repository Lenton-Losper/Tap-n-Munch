/**
 * REAL `jose`, IN PROCESS, NO MOCK. What does `requireTerminalAuth` actually throw?
 *
 * ============================================================================================
 * WHY THIS IS A SCRIPT AND NOT A JEST TEST
 * ============================================================================================
 *
 * `lib/terminal-auth.ts` imports `jose`, which is ESM-only, and ts-jest cannot load it. Every jest
 * suite that touches a terminal route therefore MOCKS `@/lib/terminal-auth` — and that is exactly
 * how the defect this file exists to prevent got to production.
 *
 * Rule 16: a mock encodes an assumption about the mocked module's FAILURE SHAPES. The
 * held-payments suite's mock threw a `Response`, because that is what a missing header produces.
 * A malformed token produced a JOSEError instead, the route's catch defaulted it to 500, and 24
 * green tests could not have noticed — the mock only ever threw the shape the code handled.
 *
 * So the shapes are asserted HERE, against the real module, with no mock anywhere. tsx loads ESM
 * fine; the thing jest cannot do is the whole reason this is worth having.
 *
 * ============================================================================================
 * WHAT IS ASSERTED
 * ============================================================================================
 *
 * ONE SHAPE OUT, for every failure: a `Response`. Callers all do
 * `if (err instanceof Response) return err`, so a Response is the only shape that reaches the
 * device with the status the module intended.
 *
 *   no Authorization header        -> Response 401
 *   non-Bearer scheme              -> Response 401
 *   Bearer with empty token        -> Response 401
 *   malformed token                -> Response 401   <- was a JOSEError, then a 500
 *   token signed with a WRONG key  -> Response 401   <- forged
 *   EXPIRED but otherwise valid    -> Response 401   <- the ordinary hourly event
 *   wrong `type` claim             -> Response 403
 *
 * AND A POSITIVE CONTROL, because every assertion above is "it refused" and a function that
 * refused everything would satisfy all of them: a correctly-signed, unexpired terminal token must
 * be ACCEPTED and return the claims. Without that line this file cannot tell a working guard from
 * a brick.
 *
 * Marker: TERMINAL_AUTH_SHAPES_OK
 */
import { SignJWT } from 'jose'

process.env.TERMINAL_JWT_SECRET =
  process.env.TERMINAL_JWT_SECRET || 'verify-terminal-auth-throw-shapes-secret'

const SECRET = new TextEncoder().encode(process.env.TERMINAL_JWT_SECRET)
const WRONG_SECRET = new TextEncoder().encode('a-different-secret-entirely')

let failures = 0
const check = (label: string, ok: boolean, detail = '') => {
  if (!ok) failures++
  console.log(`  ${ok ? 'PASS  ' : '*** FAIL ***  '}${label}${detail ? '   ' + detail : ''}`)
}

async function mint(opts: {
  type?: string
  expiresIn?: string
  secret?: Uint8Array
}): Promise<string> {
  return new SignJWT({
    type: opts.type ?? 'terminal',
    restaurant_id: 'aaaaaaaa-0000-0000-0000-000000000001',
    device_serial: 'SN-VERIFY',
    permissions: ['orders:read', 'orders:update', 'tables:read'],
  })
    .setSubject('terminal-verify')
    .setProtectedHeader({ alg: 'HS256' })
    .setExpirationTime(opts.expiresIn ?? '1h')
    .sign(opts.secret ?? SECRET)
}

const req = (authorization?: string) =>
  new Request('http://localhost/api/terminal/anything', {
    method: 'POST',
    headers: authorization ? { Authorization: authorization } : {},
  })

async function main() {
  // Imported AFTER the secret is set: the module reads TERMINAL_JWT_SECRET at import time.
  const { requireTerminalAuth } = await import('../lib/terminal-auth')

  console.log('REAL jose, no mock. Asserting what requireTerminalAuth throws.\n')

  const shape = async (label: string, header: string | undefined, expectStatus: number) => {
    try {
      await requireTerminalAuth(req(header))
      check(label, false, 'DID NOT THROW — it accepted this')
    } catch (err) {
      const isResponse = err instanceof Response
      if (!isResponse) {
        check(
          label,
          false,
          `threw ${err?.constructor?.name ?? typeof err} — NOT a Response, so every caller's ` +
            `\`instanceof Response\` misses it and it lands on their default status`,
        )
        return
      }
      check(label, (err as Response).status === expectStatus, `Response ${(err as Response).status}`)
    }
  }

  await shape('no Authorization header            -> 401', undefined, 401)
  await shape('non-Bearer scheme                  -> 401', 'Basic abc123', 401)
  await shape('Bearer with an empty token         -> 401', 'Bearer ', 401)
  await shape('malformed token                    -> 401', 'Bearer not-a-real-token', 401)
  await shape('three-segment junk                 -> 401', 'Bearer aaa.bbb.ccc', 401)
  await shape(
    'signed with the WRONG key          -> 401',
    `Bearer ${await mint({ secret: WRONG_SECRET })}`,
    401,
  )
  await shape(
    'EXPIRED but otherwise valid        -> 401',
    `Bearer ${await mint({ expiresIn: '-5m' })}`,
    401,
  )
  await shape(
    'wrong type claim                   -> 403',
    `Bearer ${await mint({ type: 'staff' })}`,
    403,
  )

  /*
   * THE POSITIVE CONTROL. Everything above is "it refused". A requireTerminalAuth that threw 401 at
   * everything would pass all eight and would also lock every terminal out of the estate. This is
   * the line that tells a working guard from a brick.
   */
  console.log('')
  try {
    const claims = await requireTerminalAuth(req(`Bearer ${await mint({})}`))
    check(
      'CONTROL: a VALID token is accepted',
      claims.terminalId === 'terminal-verify' &&
        claims.restaurantId === 'aaaaaaaa-0000-0000-0000-000000000001',
      `terminalId=${claims.terminalId}`,
    )
    check(
      'CONTROL: and its permissions survive',
      claims.permissions.includes('orders:update'),
      claims.permissions.join(','),
    )
  } catch (err) {
    check(
      'CONTROL: a VALID token is accepted',
      false,
      `threw ${err instanceof Response ? `Response ${err.status}` : String(err)}`,
    )
  }

  console.log('')
  if (failures) {
    console.log(`*** ${failures} ASSERTION(S) FAILED ***`)
    process.exitCode = 1
  } else {
    console.log('TERMINAL_AUTH_SHAPES_OK')
  }
}

main().catch((e) => {
  console.error('ABORTED:', e)
  process.exit(1)
})
