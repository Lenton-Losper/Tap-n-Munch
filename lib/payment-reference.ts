/** Crockford-ish: no I, O, 0 or 1, so a reference read off a printed receipt is unambiguous. */
const REFERENCE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

/**
 * `PAY-<YYYYMMDD>-<8 random chars>`.
 *
 * The suffix comes from crypto.getRandomValues, NOT Math.random. Math.random is V8's
 * xorshift128+, which is not a CSPRNG: its internal state is recoverable from a modest run of
 * observed outputs, and references are observable in bulk (printed on receipts, carried on
 * gateway return URLs). Combined with a date prefix that is simply public, that made the suffix
 * guessable, and the reference is a lookup key for order data.
 *
 * `crypto` here is the Web Crypto global, deliberately not `node:crypto`. This code runs on the
 * Cloudflare Workers runtime, where the global is the Web Crypto API and node's module only
 * exists behind the nodejs_compat flag. lib/terminal-auth/pin-credentials.ts and
 * lib/terminals/refresh-token.ts already call this same global in server code on that worker.
 *
 * Masking rather than modulo: the alphabet is exactly 32 symbols and 256 is a whole multiple of
 * 32, so `byte & 31` is uniform over the alphabet with no modulo bias and no rejection sampling.
 * That equality is what makes the mask correct -- an alphabet of any other length would need
 * rejection sampling instead.
 *
 * The emitted format is byte-for-byte unchanged. Only the source of randomness moved, and
 * lookups match the stored column by exact equality (lib/guest-orders/validation.ts ->
 * paymentRefOrFilter) without ever parsing the reference, so references issued under the old
 * generator keep resolving. This applies forward only; nothing already issued is rewritten.
 */
export function generatePaymentReference(): string {
  const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '')

  const bytes = new Uint8Array(8)
  crypto.getRandomValues(bytes)

  let random = ''
  for (const byte of bytes) {
    random += REFERENCE_ALPHABET[byte & 31]
  }

  return `PAY-${dateStr}-${random}`
}
