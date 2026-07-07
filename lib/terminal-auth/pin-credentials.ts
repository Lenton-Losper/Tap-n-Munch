const PIN_PATTERN = /^[0-9]{4}$/
const PBKDF2_ITERATIONS = 100_000
const PBKDF2_HASH_BITS = 256
const SALT_BYTES = 16

export function validateTerminalPin(pin: string): boolean {
  return PIN_PATTERN.test(pin)
}

function bytesToBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(bytes).toString('base64')
  }
  let binary = ''
  for (const byte of bytes) {
    binary += String.fromCharCode(byte)
  }
  return btoa(binary)
}

/**
 * Hash a 4-digit terminal PIN with PBKDF2-SHA256 (Web Crypto).
 * PIN bytes are imported as raw key material; salt is random per credential.
 */
export async function hashTerminalPin(
  pin: string,
): Promise<{ pinHash: string; pinSalt: string }> {
  const salt = new Uint8Array(SALT_BYTES)
  crypto.getRandomValues(salt)

  const pinBytes = new TextEncoder().encode(pin)
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    pinBytes,
    'PBKDF2',
    false,
    ['deriveBits'],
  )

  const derivedBits = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt,
      iterations: PBKDF2_ITERATIONS,
      hash: 'SHA-256',
    },
    keyMaterial,
    PBKDF2_HASH_BITS,
  )

  return {
    pinHash: bytesToBase64(new Uint8Array(derivedBits)),
    pinSalt: bytesToBase64(salt),
  }
}
