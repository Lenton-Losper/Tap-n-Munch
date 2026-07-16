/**
 * Meta Cloud API webhook signature verification: HMAC-SHA256 of the raw request body
 * using the app secret, sent as `X-Hub-Signature-256: sha256=<hex digest>`.
 * https://developers.facebook.com/docs/graph-api/webhooks/getting-started#verification-requests
 *
 * Uses Web Crypto (not Node's `crypto`) for Cloudflare Workers runtime compatibility --
 * same approach already used for PIN hashing in lib/terminal-auth/pin-credentials.ts.
 */

function hexToBytes(hex: string): Uint8Array | null {
  if (hex.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(hex)) return null
  const bytes = new Uint8Array(hex.length / 2)
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  }
  return bytes
}

/** Same fixed-time comparison approach as lib/terminal-auth/pin-credentials.ts. */
function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) {
    diff |= a[i] ^ b[i]
  }
  return diff === 0
}

/**
 * Verifies a Meta webhook request against its `X-Hub-Signature-256` header.
 * `rawBody` must be the exact, unparsed request body bytes/text -- signing is over the
 * raw bytes, so re-serializing parsed JSON before verifying would break it.
 */
export async function verifyMetaWebhookSignature(
  rawBody: string,
  signatureHeader: string | null,
  appSecret: string,
): Promise<boolean> {
  if (!signatureHeader || !appSecret) return false

  const prefix = 'sha256='
  if (!signatureHeader.startsWith(prefix)) return false
  const providedHex = signatureHeader.slice(prefix.length).trim()
  const providedBytes = hexToBytes(providedHex)
  if (!providedBytes) return false

  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(appSecret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )

  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(rawBody))
  const expectedBytes = new Uint8Array(signature)

  return constantTimeEqual(providedBytes, expectedBytes)
}
