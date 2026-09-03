import { NextResponse } from 'next/server'
import { jwksDocument } from '@/lib/terminals/signing-keys'

export const dynamic = 'force-static'

/**
 * THE PUBLIC HALF OF THE TERMINAL SIGNING KEYS, FOR SUPABASE TO FETCH.
 *
 * Supabase Third-Party Auth accepts exactly one of `oidc_issuer_url`, `jwks_url` or `custom_jwks`
 * (confirmed against the provider's ThirdPartyAuth resource). We register the bare JWKS URL, so
 * the OIDC discovery document is NOT required and is deliberately not published — one endpoint to
 * keep correct instead of two.
 *
 * CACHING IS A ROTATION CONTROL, NOT A PERFORMANCE ONE. Supabase polls this and takes up to 30
 * minutes to pick up a change, so a long cache would stack on top of that delay and make a
 * rotation take hours. Ten minutes keeps the total predictable while still being kind to anyone
 * else fetching it.
 *
 * Serving this is safe by construction: a public key verifies signatures and creates none.
 */
export async function GET() {
  return NextResponse.json(jwksDocument(), {
    headers: {
      'Content-Type': 'application/jwk-set+json',
      'Cache-Control': 'public, max-age=600',
    },
  })
}
