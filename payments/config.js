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
 * READ docs/paycloud-gateway-public-key.md BEFORE CHANGING THIS VALUE.
 *
 * Measured 2026-08-22 against live production order.query: NO key we hold verifies a real
 * production response. The currently deployed value fails, so swapping in another key we
 * already have is not the fix and has been tried. The response does carry a genuine 344-char
 * RSA-2048 signature, so there IS something to verify -- this is a wrong-key problem, and the
 * only thing that closes it is Finatic supplying their production response-signing public key.
 *
 * Do not reopen the sign-string / field-order / charset family: node-forge throws
 * 'Encryption block is invalid.' for a wrong KEY and returns false for a wrong sign-string.
 * We get the throw.
 */
export function normalizeGatewayPublicKeyEnvToPem() {
  return normalizePublicKeyMaterialToPem(process.env.PAYCLOUD_GATEWAY_PUBLIC_KEY)
}
