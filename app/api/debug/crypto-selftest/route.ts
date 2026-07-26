import { NextResponse } from 'next/server'
import crypto from 'crypto'
import forge from 'node-forge'
import { requireStagingPlatformAdmin } from '@/lib/api/require-staging-platform-admin'
import { verifyPayloadSignature } from '@/payments/signature'

export const dynamic = 'force-dynamic'

/**
 * TEMPORARY, staging-only diagnostic for the 2026-07-26 PayCloud webhook fix -- confirms
 * on the real deployed Workers runtime (not local Node) that:
 *  1. crypto.createHmac + crypto.timingSafeEqual work (the PAYCLOUD_WEBHOOK_SECRET fallback
 *     path in payments/webhook.js), using literal test inputs, no env/secret required.
 *  2. The forge-based verifyPayloadSignature (payments/signature.js) correctly ACCEPTS a
 *     genuinely valid signature, not just rejects invalid ones -- using a throwaway keypair
 *     passed as the explicit publicKey override, since nobody outside PayCloud holds their
 *     real private key to produce a "genuinely valid" signature against the real configured key.
 * Remove this route once the fix is verified.
 */
export async function GET(request: Request) {
  const denied = await requireStagingPlatformAdmin(request)
  if (denied) return denied

  const result: Record<string, unknown> = {}

  try {
    const secret = 'selftest-literal-secret'
    const body = 'selftest-literal-body'
    const expected = crypto.createHmac('sha256', secret).update(body, 'utf8').digest('hex')
    const matches = crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(expected))
    result.hmacSelfTest = { ok: true, matches }
  } catch (error) {
    result.hmacSelfTest = { ok: false, error: error instanceof Error ? error.message : String(error) }
  }

  const keypair = forge.pki.rsa.generateKeyPair({ bits: 2048 })
  const publicKeyPem = forge.pki.publicKeyToPem(keypair.publicKey)
  const privateKeyPem = forge.pki.privateKeyToPem(keypair.privateKey)
  const payload = { merchant_order_no: 'SELFTEST-1', amount: 1, trans_status: '2' }

  try {
    const canonical = Object.keys(payload)
      .sort()
      .map((k) => `${k}=${(payload as Record<string, unknown>)[k]}`)
      .join('&')
    const md = forge.md.sha256.create()
    md.update(canonical, 'utf8')
    const signatureBytes = forge.pki.privateKeyFromPem(privateKeyPem).sign(md)
    const signatureBase64 = forge.util.encode64(signatureBytes)

    const acceptsValid = verifyPayloadSignature(payload, signatureBase64, publicKeyPem)
    result.rsaVerifyAcceptsValidSignature = { ok: true, acceptsValid }
  } catch (error) {
    result.rsaVerifyAcceptsValidSignature = {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    }
  }

  // Separate try/catch: forge may legitimately throw on malformed input (same reason
  // payments/webhook.js wraps verifyPayloadSignature in try/catch) -- must not mask the
  // acceptsValid result above.
  try {
    const rejectsGarbage = verifyPayloadSignature(payload, 'not-a-real-signature-base64==', publicKeyPem)
    result.rsaVerifyRejectsGarbageSignature = { ok: true, rejected: rejectsGarbage === false }
  } catch (error) {
    // Throwing on garbage input is an acceptable outcome here too, as long as it's not the
    // "[unenv] crypto.createVerify is not implemented" failure this fix targets.
    result.rsaVerifyRejectsGarbageSignature = {
      ok: true,
      rejected: true,
      threw: error instanceof Error ? error.message : String(error),
    }
  }

  return NextResponse.json(result)
}
