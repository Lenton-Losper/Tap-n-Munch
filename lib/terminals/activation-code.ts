/**
 * Crockford-ish alphabet: no I, O, 0 or 1, because a human reads this off a screen and types it
 * into a payment terminal. THIRTY-TWO characters exactly, which matters below.
 */
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

/**
 * #241, first half — THIS IS A CSPRNG NOW. It was:
 *
 *     CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]
 *
 * `Math.random()` is not a CSPRNG. V8 implements it as xorshift128+, seeded per isolate and
 * **recoverable from a small number of consecutive outputs**. An activation code is the credential
 * that turns an unauthenticated HTTP request into a terminal JWT with hardcoded permissions, so a
 * predictable one is a predictable path to a working terminal token.
 *
 * The exposure is not theoretical here, because the outputs are handed out: anyone who can reach
 * `POST /api/admin/terminals/generate-code` observes consecutive draws from the same isolate, which
 * is exactly the input the state-recovery attack needs. They could then predict the NEXT code —
 * the one a real operator is about to be given for a real device.
 *
 * Same finding and same fix as #283's `generateTabPin` and #277's `mintTabSessionId`.
 * `crypto.getRandomValues` is available in the Workers runtime and in Node 18+.
 *
 * NO REJECTION SAMPLING NEEDED, and that is a property of this alphabet rather than an oversight.
 * `generateTabPin` has to discard part of its range because 65536 is not a multiple of 9000, so a
 * modulus would make low PINs likelier. `CODE_CHARS.length` is **32**, and 256 is exactly 8 x 32 —
 * so `byte % 32` over a uniform byte is already perfectly uniform. If a character is ever added to
 * or removed from that alphabet, this stops being true and the rejection loop has to come back.
 * There is a test asserting the length is 32 for precisely that reason.
 *
 * IT DOES NOT FAIL OPEN. With no Web Crypto it throws, exactly as `generateTabPin` does. A silent
 * fallback to `Math.random()` would reintroduce the defect invisibly, on whichever runtime lacked
 * the API — the worst possible place for it to come back.
 *
 * WHAT THIS DOES NOT FIX, and why #241 stays open: the activation ROUTE still takes a
 * self-asserted `deviceId` / `terminalSn` from the request body and never verifies either against
 * anything. A CSPRNG makes the code unguessable; it does nothing about what the route does once a
 * code is presented. That half is a design change to device binding, it invalidates existing
 * tokens, and it is not a swap.
 */
function randomSegment(length: number): string {
  const c = globalThis.crypto
  if (typeof c?.getRandomValues !== 'function') {
    // NEVER Math.random. See the docblock: a silent downgrade here re-opens the issue this
    // function was rewritten to close, and does it where nobody would look.
    throw new Error('Cannot generate a terminal activation code: no Web Crypto available')
  }
  const buf = new Uint8Array(length)
  c.getRandomValues(buf)
  return Array.from(buf, (byte) => CODE_CHARS[byte % CODE_CHARS.length]).join('')
}

export function generateTerminalActivationCode(): string {
  return `FT-${randomSegment(4)}-${randomSegment(4)}`
}

/** Placeholder until the P5 activates with a real device id (column is NOT NULL in production). */
export function pendingTerminalDeviceId(): string {
  return `pending-${crypto.randomUUID()}`
}

export function normalizeActivationCode(value: string): string {
  return String(value || '')
    .trim()
    .toUpperCase()
    .replace(/\s+/g, '')
}
