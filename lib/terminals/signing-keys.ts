/**
 * THE TERMINAL JWT SIGNING KEYS — ASYMMETRIC, PUBLISHED, AND ROTATABLE (Phase A).
 *
 * ============================================================================================
 * WHY THIS EXISTS
 * ============================================================================================
 *
 * Terminal JWTs were HS256, signed with TERMINAL_JWT_SECRET. That works for our own API, which
 * holds the secret and can verify it — but Supabase Realtime cannot be told to trust it. Supabase
 * Third-Party Auth is explicit: "Using symmetrically signed JWTs is not possible at this time."
 * A private Realtime channel therefore requires the terminal token to be asymmetrically signed and
 * its public half published at a JWKS URL.
 *
 * That is the whole reason for this change. It is NOT a security upgrade to the terminal token in
 * itself — HS256 with a strong secret was fine — it is the precondition for taking the broadcast
 * channel off `private: false`, which is what removes the 45s invalidation ceiling.
 *
 * ============================================================================================
 * THE PUBLIC KEY IS PUBLIC. THE PRIVATE KEY IS A WORKER SECRET.
 * ============================================================================================
 *
 * The JWK below is committed deliberately: it is served to the internet at
 * /.well-known/jwks.json and is worthless to an attacker. Only the private half signs, and it
 * lives in TERMINAL_JWT_PRIVATE_KEY, set with `wrangler secret put`.
 *
 * ONCE SUPABASE TRUSTS THIS JWKS, the private key mints `authenticated` identities in the Supabase
 * project. It becomes as sensitive as the service-role key and must be treated that way.
 *
 * ============================================================================================
 * ROTATION — THE 30 MINUTE WINDOW IS THE WHOLE DESIGN
 * ============================================================================================
 *
 * Supabase stores third-party signing keys in project config and POLLS for changes: the docs say
 * "allow up to 30 minutes for the change to be picked up". So a key added to this array is NOT
 * trusted immediately, and the sequence matters:
 *
 *   1. add key B to KEYS below, deploy. It is published but nothing signs with it.
 *   2. WAIT 30 MINUTES. Supabase must have polled the JWKS before anything signed by B appears.
 *   3. switch ACTIVE_KID to B, deploy. Tokens now carry kid=B, which Supabase already knows.
 *   4. after 1h (the token lifetime) plus margin, remove A.
 *
 * THE FAILURE TO AVOID is doing 1 and 3 in one deploy. For up to half an hour Supabase would still
 * be serving the old key set, every token signed by B would fail verification, and every terminal
 * would drop at once. The array exists so both keys are valid at the same time; the wait exists
 * because publishing is not the same as being trusted.
 */
export type TerminalSigningKey = {
  kid: string
  jwk: {
    kty: 'EC'
    crv: 'P-256'
    x: string
    y: string
    alg: 'ES256'
    use: 'sig'
    kid: string
  }
}

/**
 * Every key whose signatures must still verify. Publish first, sign later, remove last — see the
 * rotation sequence above.
 */
export const TERMINAL_SIGNING_KEYS: TerminalSigningKey[] = [
  {
    kid: '718d0b49-1fbd-4b9b-a70c-030456f685ca',
    jwk: {
      kty: 'EC',
      crv: 'P-256',
      x: 'mcuci3w9dDoV84v2mKISAEjJav_t1X8WBeXUBMFphZU',
      y: 'VdgxgAi34l_5jKKi-WymsU857hwkTVa8TSgbu-JLAHc',
      alg: 'ES256',
      use: 'sig',
      kid: '718d0b49-1fbd-4b9b-a70c-030456f685ca',
    },
  },
]

/** The key new tokens are signed with. One of TERMINAL_SIGNING_KEYS. */
export const ACTIVE_KID = '718d0b49-1fbd-4b9b-a70c-030456f685ca'

export function jwksDocument() {
  return { keys: TERMINAL_SIGNING_KEYS.map((k) => k.jwk) }
}

export function findSigningKey(kid: string | undefined): TerminalSigningKey | null {
  if (!kid) return null
  return TERMINAL_SIGNING_KEYS.find((k) => k.kid === kid) ?? null
}
