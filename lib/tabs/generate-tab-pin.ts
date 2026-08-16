/**
 * The 4-digit PIN that lets a second phone join a table's tab.
 *
 * WHY THIS IS A CSPRNG NOW (#283, first half). It was:
 *
 *     Math.floor(1000 + Math.random() * 9000).toString()
 *
 * `Math.random()` is not a CSPRNG. V8's implementation is xorshift128+, seeded per isolate and
 * **recoverable from a small number of outputs** — and the outputs here are handed to whoever
 * created the tab. So an attacker who opens several tabs of their own on the same Worker isolate
 * sees several consecutive draws, recovers the generator state, and can then predict the PIN a
 * genuine customer is about to be given. The PIN is the only control on joining someone else's
 * table.
 *
 * Same finding and same fix as #277, which replaced `Math.random()` in `mintTabSessionId` for the
 * same reason. `crypto.getRandomValues` is available in the Workers runtime and in Node 18+.
 *
 * REJECTION SAMPLING, not `% 9000`. Taking a modulus of a uniform 16-bit draw makes the low PINs
 * measurably more likely than the high ones (65536 is not a multiple of 9000), and the whole
 * point of this change is that the distribution is not exploitable. The loop discards the
 * unusable tail instead; it retries about 1 in 8 draws and terminates with probability 1.
 *
 * IT DOES NOT FAIL OPEN. With no Web Crypto it throws, exactly as `mintTabSessionId` does. A
 * silent fallback to `Math.random()` would reintroduce the defect invisibly, on whichever runtime
 * lacked the API — which is the worst possible place for it to come back.
 *
 * WHAT THIS DOES NOT FIX, and #283 stays open for it: there is still **no rate limiting** on PIN
 * entry. A CSPRNG stops PREDICTION; it does nothing about a client trying all 9000 values. #283
 * compares this to the staff PIN beside it, which has a full lockout in
 * `lib/terminal-auth/pin-lockout.ts` — reusing that shape is the other half of the issue and is a
 * design decision, not a swap. QRA-06 records that the product has no rate limiting anywhere
 * except the PayCloud webhook.
 */

/** Inclusive lower bound. Keeps every PIN four digits — no leading zeros to lose in a text field. */
const MIN_PIN = 1000
/** Exclusive upper bound. */
const MAX_PIN = 10000
const PIN_RANGE = MAX_PIN - MIN_PIN // 9000

export function generateTabPin(): string {
  const c = globalThis.crypto
  if (typeof c?.getRandomValues !== 'function') {
    // NEVER Math.random. See the docblock: a silent downgrade here re-opens the issue this
    // function was rewritten to close, and does it where nobody would look.
    throw new Error('Cannot generate a tab PIN: no Web Crypto available')
  }

  // The largest multiple of PIN_RANGE that fits in 16 bits. Draws at or above it are discarded,
  // which is what keeps every PIN equally likely.
  const limit = Math.floor(65536 / PIN_RANGE) * PIN_RANGE
  const buf = new Uint16Array(1)
  for (;;) {
    c.getRandomValues(buf)
    if (buf[0] < limit) return String(MIN_PIN + (buf[0] % PIN_RANGE))
  }
}
