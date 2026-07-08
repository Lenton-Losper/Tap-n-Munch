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

function base64ToBytes(base64: string): Uint8Array | null {
  try {
    if (typeof Buffer !== 'undefined') {
      return new Uint8Array(Buffer.from(base64, 'base64'))
    }
    const binary = atob(base64)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i)
    }
    return bytes
  } catch {
    return null
  }
}

/**
 * Constant-time byte comparison. Web Crypto has no timingSafeEqual; Node's
 * crypto.timingSafeEqual is not available in the Cloudflare Workers runtime,
 * so we use a fixed XOR loop here (same approach as Node's primitive).
 */
export function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) {
    diff |= a[i] ^ b[i]
  }
  return diff === 0
}

async function derivePinHashBytes(pin: string, salt: Uint8Array): Promise<Uint8Array> {
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
      salt: new Uint8Array(salt),
      iterations: PBKDF2_ITERATIONS,
      hash: 'SHA-256',
    },
    keyMaterial,
    PBKDF2_HASH_BITS,
  )

  return new Uint8Array(derivedBits)
}

/** Re-derive PBKDF2 hash with stored salt and compare in constant time. */
export async function verifyTerminalPin(
  pin: string,
  storedHashBase64: string,
  storedSaltBase64: string,
): Promise<boolean> {
  if (!validateTerminalPin(pin)) return false

  const salt = base64ToBytes(storedSaltBase64)
  const expectedHash = base64ToBytes(storedHashBase64)
  if (!salt || !expectedHash) return false

  const actualHash = await derivePinHashBytes(pin, salt)
  return constantTimeEqual(actualHash, expectedHash)
}
