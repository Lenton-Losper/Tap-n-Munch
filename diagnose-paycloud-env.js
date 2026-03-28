import { getPaycloudConfig } from './payments/paycloud.js'
import {
  getDerivedPublicKeyFingerprintFromPrivateKey,
  getPublicKeyFingerprint,
  loadGatewayPublicKey,
} from './payments/signature.js'

function maskId(value) {
  const s = String(value || '')
  if (s.length <= 6) return '***'
  return `${s.slice(0, 3)}***${s.slice(-3)}`
}

function run() {
  const cfg = getPaycloudConfig()
  const configuredPublic = loadGatewayPublicKey()
  const configuredFingerprint = getPublicKeyFingerprint(configuredPublic)
  const derivedFingerprint = getDerivedPublicKeyFingerprintFromPrivateKey()

  console.log('[PayCloud][DIAG] PAYCLOUD_ENDPOINT=', cfg.endpoint)
  console.log('[PayCloud][DIAG] PAYCLOUD_APP_ID=', maskId(cfg.appId))
  console.log('[PayCloud][DIAG] PAYCLOUD_MERCHANT_NO=', maskId(cfg.merchantNo))
  console.log('[PayCloud][DIAG] PAYCLOUD_STORE_NO=', maskId(cfg.storeNo))
  console.log('[PayCloud][DIAG] configured_public_fingerprint_sha256=', configuredFingerprint)
  console.log('[PayCloud][DIAG] derived_public_fingerprint_sha256=', derivedFingerprint)
  console.log('[PayCloud][DIAG] fingerprints_match=', configuredFingerprint === derivedFingerprint)
}

run()
