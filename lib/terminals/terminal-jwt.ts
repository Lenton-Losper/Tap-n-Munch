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
 * THE ISSUER, AND WHY IT IS NOT A NEXT_PUBLIC_ VAR.
 *
 * This first read NEXT_PUBLIC_APP_URL, and every ES256 token issued on production came out claiming
 * `iss: "http://localhost:3000"`. Caught by inspecting a freshly issued token, not by any test.
 *
 * NEXT_PUBLIC_* IS INLINED INTO THE BUNDLE AT BUILD TIME. The build sources .env.local, where that
 * value is localhost, so the constant was frozen in at compile. wrangler.production.toml also sets
 * NEXT_PUBLIC_APP_URL = "https://flashtap.app" as a Worker var — and it cannot win, because there
 * is no longer a lookup to override. Exactly the trap the station manifests hit from the other
 * direction.
 *
 * Nothing broke, because our own verifier ignores `iss`. Supabase does NOT: once the provider is
 * registered, a token claiming localhost is refused, and it would present as "the policy is wrong"
 * or "the 30-minute key poll has not landed" — a failure pointing at the two things we would
 * already be waiting on.
 *
 * So: a plain server-side variable, resolved at RUNTIME, defaulting to the production issuer. It
 * must match the URL registered with Supabase exactly.
 */
export function terminalJwtIssuer(): string {
  return process.env.TERMINAL_JWT_ISSUER || 'https://flashtap.app'
}
