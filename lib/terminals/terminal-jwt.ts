import { SignJWT, importPKCS8 } from 'jose'
import { ACTIVE_KID, findSigningKey } from './signing-keys'

export const TERMINAL_JWT_PERMISSIONS = [
  'orders:read',
  'orders:update',
  'tables:read',
] as const

/**
 * ES256 WHEN THE PRIVATE KEY IS PRESENT, HS256 OTHERWISE (Phase A).
 *
 * ============================================================================================
 * WHY THE FALLBACK EXISTS, AND WHY IT IS NOT A HEDGE
 * ============================================================================================
 *
 * This change touches the credential every till and every wall screen authenticates with. Getting
 * it wrong does not degrade a feature, it locks the estate out mid-service.
 *
 * So the code ships INERT: with no TERMINAL_JWT_PRIVATE_KEY set, signing is byte-for-byte what it
 * was, and the deploy is a no-op for authentication. Setting the secret afterwards is what flips
 * issuance to ES256 — a separate, instantly reversible act (`wrangler secret delete`) that needs no
 * build and no deploy. That splits "does the new code work" from "does the new algorithm work",
 * and lets the second be undone in seconds.
 *
 * ============================================================================================
 * role AND aud ARE ADDED UNCONDITIONALLY
 * ============================================================================================
 *
 * Supabase reads `role` to decide what a third-party identity may do; `aud: 'authenticated'` is
 * the audience its policies expect. Adding them is safe on our side: requireTerminalAuth reads
 * `type`, `sub`, `restaurant_id`, `device_serial` and `permissions`, and jose only enforces an
 * audience when the verifier passes one, which ours does not. Verified by reading the verifier, not
 * assumed.
 *
 * They are added even in the HS256 path so the claim set does not change when the secret is set —
 * one variable at a time.
 */
export async function signTerminalJwt(payload: {
  terminal_id: string
  restaurant_id: string
  device_serial: string
}) {
  const claims = {
    type: 'terminal',
    restaurant_id: payload.restaurant_id,
    device_serial: payload.device_serial,
    permissions: [...TERMINAL_JWT_PERMISSIONS],
    // For Supabase Third-Party Auth. Ignored by our own verifier.
    role: 'authenticated',
  }

  const privateKeyPem = process.env.TERMINAL_JWT_PRIVATE_KEY
  if (privateKeyPem && findSigningKey(ACTIVE_KID)) {
    const key = await importPKCS8(privateKeyPem, 'ES256')
    return new SignJWT(claims)
      .setSubject(payload.terminal_id)
      .setAudience('authenticated')
      .setIssuer(terminalJwtIssuer())
      .setProtectedHeader({ alg: 'ES256', kid: ACTIVE_KID })
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(key)
  }

  const secretValue = process.env.TERMINAL_JWT_SECRET
  if (!secretValue) {
    throw new Error('TERMINAL_JWT_SECRET is not configured')
  }
  const secret = new TextEncoder().encode(secretValue)

  return new SignJWT(claims)
    .setSubject(payload.terminal_id)
    .setAudience('authenticated')
    .setIssuer(terminalJwtIssuer())
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(secret)
}

/**
 * Must match whatever is registered with Supabase. Kept as a function so the value has one home;
 * a mismatch between this and the registered issuer is a silent verification failure.
 */
export function terminalJwtIssuer(): string {
  return process.env.NEXT_PUBLIC_APP_URL || 'https://flashtap.app'
}
