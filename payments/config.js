/**
 * PayCloud key material from .env: strip literals, whitespace, and PEM wrappers,
 * then re-wrap as standard PEM (avoids corrupted buffers from one-line .env or \\n).
 */
import crypto from 'crypto'

/** Remove headers/footers, all whitespace, and literal backslash-n from env key blobs. */
export function extractPemBase64Body(raw) {
  let s = String(raw ?? '').trim()
  s = s.replace(/\\n/g, '')
  s = s.replace(/\\r/g, '')
  s = s.replace(/-----BEGIN [^-]+-----/g, '')
  s = s.replace(/-----END [^-]+-----/g, '')
  s = s.replace(/\s+/g, '')
  return s
}

export function toPemBlock(base64Body, label) {
  const compact = String(base64Body || '').replace(/\s+/g, '')
  if (!compact) throw new Error('Empty key material after PEM normalization')
  const lines = compact.match(/.{1,64}/g) || []
  return `-----BEGIN ${label}-----\n${lines.join('\n')}\n-----END ${label}-----`
}

/** Rebuild PKCS#1 private key PEM from env (PKCS#8 or PKCS#1 body in .env). */
export function normalizePrivateKeyEnvToPkcs1Pem() {
  const raw = process.env.PAYCLOUD_PRIVATE_KEY
  if (!raw) throw new Error('PAYCLOUD_PRIVATE_KEY is required')
  const body = extractPemBase64Body(raw)
  const pkcs8Pem = toPemBlock(body, 'PRIVATE KEY')
  let keyObj
  try {
    keyObj = crypto.createPrivateKey(pkcs8Pem)
  } catch {
    const rsaPem = toPemBlock(body, 'RSA PRIVATE KEY')
    keyObj = crypto.createPrivateKey(rsaPem)
  }
  return keyObj.export({ type: 'pkcs1', format: 'pem' })
}

/** SPKI public key PEM for PAYCLOUD_GATEWAY_PUBLIC_KEY (or any raw/base64 public). */
export function normalizePublicKeyMaterialToPem(raw) {
  if (!raw) throw new Error('Public key material is required')
  const body = extractPemBase64Body(raw)
  return toPemBlock(body, 'PUBLIC KEY')
}

/**
 * DEAD BY DESIGN. Ruled 2026-08-22: Finatic has NO merchant-facing public key. It does not exist,
 * so response signature verification can never succeed and this value can never be made correct.
 *
 * DO NOT chase it, do not open a vendor ticket for it, do not try another key. Every earlier note
 * framed this as "not supplied yet", which read as though an email would fix it.
 *
 * The consequence is structural, not a defect: `fallback_verified_paid` IS the settlement
 * architecture, permanently. The security model is the outbound order.query authenticated by our
 * own credentials over TLS; the webhook is an untrusted trigger, never evidence.
 *
 * The failing verification and its console.warn are EXPECTED. Do not treat them as a symptom, and
 * do not reopen the sign-string / field-order / charset family -- node-forge throws for a wrong KEY
 * and returns false for a wrong sign-string, and we get the throw. See
 * docs/paycloud-gateway-public-key.md.
 */
export function normalizeGatewayPublicKeyEnvToPem() {
  return normalizePublicKeyMaterialToPem(process.env.PAYCLOUD_GATEWAY_PUBLIC_KEY)
}
