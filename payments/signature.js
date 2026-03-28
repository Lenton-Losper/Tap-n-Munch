/**
 * PayCloud RSA2 (SHA256-RSA) request signing — matches official PHP SDK canonicalization:
 * - Take all request fields
 * - Remove only the `sign` key
 * - Sort keys alphabetically (ASCII / ksort equivalent)
 * - Skip any field value that is a string starting with "@"
 * - Include ALL other fields including empty strings
 * - Canonical string: key=value&key=value (no URL encoding)
 * - Sign UTF-8 bytes with RSA-SHA256; encode `sign` for the wire per `PAYCLOUD_SIGNATURE_BASE64URL`:
 *   unset/false → standard base64 (matches Finatic JSON `sign` on responses, PHP base64_encode)
 *   true → base64URL (+→-, /→_, strip =)
 */
import crypto from 'crypto'
import forge from 'node-forge'
import {
  normalizePrivateKeyEnvToPkcs1Pem,
  normalizeGatewayPublicKeyEnvToPem,
  normalizePublicKeyMaterialToPem,
  toPemBlock,
} from './config.js'

function requestSignatureUsesBase64Url() {
  const v = process.env.PAYCLOUD_SIGNATURE_BASE64URL
  return v === 'true' || v === '1'
}

/** Standard base64 from crypto.sign → value placed in JSON `sign` for outbound API requests. */
export function formatPaycloudRequestSignature(standardBase64) {
  return requestSignatureUsesBase64Url() ? toBase64Url(standardBase64) : String(standardBase64 || '')
}

/** Standard base64 → PayCloud base64URL (RFC 4648 §5 style: no padding). */
export function toBase64Url(standardBase64) {
  return String(standardBase64 || '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

/** PayCloud / base64URL → standard base64 for `crypto.verify(..., 'base64')`. */
export function fromBase64Url(base64Url) {
  let s = String(base64Url || '').replace(/-/g, '+').replace(/_/g, '/')
  const pad = s.length % 4
  if (pad === 2) s += '=='
  else if (pad === 3) s += '='
  else if (pad === 1) throw new Error('Invalid base64url length')
  return s
}

function normalizeSignatureForVerify(signature) {
  const s = String(signature || '').trim()
  if (!s) return s
  if (s.includes('-') || s.includes('_')) return fromBase64Url(s)
  return s
}

/** In-place: RSA2, UTF-8, order_amount as "x.xx" for strict PayCloud signing. */
export function applyPaycloudSigningStrictFields(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return payload
  if (Object.prototype.hasOwnProperty.call(payload, 'order_amount')) {
    const v = payload.order_amount
    if (v !== null && v !== undefined && v !== '') {
      const n = Number(v)
      if (Number.isFinite(n)) payload.order_amount = n.toFixed(2)
    }
  }
  if (Object.prototype.hasOwnProperty.call(payload, 'sign_type')) payload.sign_type = 'RSA2'
  if (Object.prototype.hasOwnProperty.call(payload, 'charset')) payload.charset = 'UTF-8'
  return payload
}

/** Values for key=value signing: match PHP concatenation (explicit string for scalars, JSON for objects). */
function canonicalValueToString(value) {
  let str
  if (value === null || value === undefined) {
    str = ''
  } else if (typeof value === 'boolean' || typeof value === 'number') {
    str = String(value)
  } else if (typeof value === 'object') {
    str = JSON.stringify(value)
  } else {
    str = String(value)
  }
  return str
}

function buildCanonicalString(requestObj) {
  if (!requestObj || typeof requestObj !== 'object' || Array.isArray(requestObj)) {
    throw new Error('Signature payload must be an object')
  }

  // PHP SDK behavior: remove only `sign`, ksort remaining keys, include empty strings.
  const keys = Object.keys(requestObj)
    .filter((k) => k !== 'sign')
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))

  const pairs = []
  for (const key of keys) {
    const value = requestObj[key]
    // Skip values that start with '@' (SDK treats them as special placeholders).
    if (typeof value === 'string' && value.startsWith('@')) continue

    const str = canonicalValueToString(value)
    pairs.push(`${key}=${str}`)
  }

  return pairs.join('&')
}

export function exportCanonicalString(fields) {
  return buildCanonicalString(fields)
}

export function buildSignContent(payload) {
  return buildCanonicalString(payload)
}

/**
 * PayCloud (non-Java SDKs): PKCS#1 PEM from env via deep-normalized key material (`payments/config.js`).
 */
export function loadPrivateKey() {
  const pkcs1Pem = normalizePrivateKeyEnvToPkcs1Pem()
  if (!loadPrivateKey._logged) {
    loadPrivateKey._logged = true
    console.log('[PayCloud][KEYDIAG] pkcs1_private_key_pem_first60:', pkcs1Pem.slice(0, 60))
  }
  return pkcs1Pem
}

export function loadGatewayPublicKey() {
  return normalizeGatewayPublicKeyEnvToPem()
}

export function signPayload(payload, privateKey = loadPrivateKey()) {
  applyPaycloudSigningStrictFields(payload)
  const content = buildSignContent(payload)
  const byteLength = Buffer.byteLength(content, 'utf8')
  console.log('[PayCloud][SIGN] canonical_string=', content)
  console.log('[PayCloud][SIGN] canonical_string_utf8_bytes=', byteLength)
  console.log('SIGN_STRING_BYTES:', Buffer.from(content, 'utf8').toString('hex'))
  if (!signPayload._encodingLogged) {
    signPayload._encodingLogged = true
    console.log(
      '[PayCloud][SIGN] request_sign_wire_encoding=',
      requestSignatureUsesBase64Url() ? 'base64url (PAYCLOUD_SIGNATURE_BASE64URL)' : 'standard_base64 (default)'
    )
  }
  const prk = forge.pki.privateKeyFromPem(privateKey)
  const md = forge.md.sha256.create()
  md.update(content, 'utf8')
  const signByte = prk.sign(md)
  const standardBase64 = forge.util.encode64(signByte)
  return formatPaycloudRequestSignature(standardBase64)
}

export function verifyPayloadSignature(payload, signature, publicKey = loadGatewayPublicKey()) {
  if (!signature) return false
  if (!publicKey) {
    throw new Error('PayCloud gateway public key is not configured')
  }

  const content = buildSignContent(payload)
  const verifier = crypto.createVerify('RSA-SHA256')
  verifier.update(content, 'utf8')
  verifier.end()
  const sigB64 = normalizeSignatureForVerify(signature)
  return verifier.verify(publicKey, sigB64, 'base64')
}

// Test-only alternative canonicalization for checkout:
// Include ALL checkout schema fields (docs list) even if missing, using "" for omitted values.
// Then sign the full canonical string and send the request to checkout endpoint.
export async function testFullFieldCanonical() {
  const endpointRaw = String(process.env.PAYCLOUD_ENDPOINT || '').trim()
  const endpoint = normalizePaycloudEndpoint(endpointRaw)
  const checkoutUrl = endpoint

  const merchantNo = process.env.PAYCLOUD_MERCHANT_NO
  const storeNo = process.env.PAYCLOUD_STORE_NO
  const appId = process.env.PAYCLOUD_APP_ID
  if (!endpoint || !merchantNo || !storeNo || !appId) {
    throw new Error('Missing required PayCloud env vars for testFullFieldCanonical')
  }

  const fieldsList = [
    'app_id',
    'format',
    'charset',
    'sign_type',
    'version',
    'timestamp',
    'method',
    'merchant_no',
    'store_no',
    'pay_options',
    'merchant_order_no',
    'price_currency',
    'order_amount',
    'expires',
    'description',
    'term_ip',
    'longitude',
    'latitude',
    'return_url',
    'notify_url',
    'attach',
  ]

  const now = Date.now()
  const merchantOrderNo = `TESTFULL-${now}`
  const amount = 1
  const orderAmountStr = String(Number(amount).toFixed(2))

  const values = {
    app_id: appId,
    format: 'JSON',
    charset: 'UTF-8',
    sign_type: process.env.PAYCLOUD_SIGN_TYPE || 'RSA2',
    version: '1.0',
    timestamp: now,
    method: 'pay.paycloud.checkout',
    merchant_no: merchantNo,
    store_no: storeNo,
    pay_options: '', // docs field (optional)
    merchant_order_no: merchantOrderNo,
    price_currency: 'NAD',
    order_amount: orderAmountStr,
    expires: 600, // docs: integer
    description: `FlashTap full-field canonical ${merchantOrderNo}`,
    term_ip: '',
    longitude: '',
    latitude: '',
    return_url: 'https://example.com/order-confirmation',
    notify_url: 'https://example.com/api/webhooks/paycloud',
    attach: '',
  }

  applyPaycloudSigningStrictFields(values)
  const canonical = buildFullFieldCanonicalString(fieldsList, values)
  console.log('[TEST_FULL_CANON] SIGN_STRING_BYTES:', Buffer.from(canonical, 'utf8').toString('hex'))

  const privatePem = loadPrivateKey()
  const signer = crypto.createSign('RSA-SHA256')
  signer.update(canonical, 'utf8')
  signer.end()
  const signature = formatPaycloudRequestSignature(signer.sign(privatePem, 'base64'))

  console.log('[TEST_FULL_CANON] checkoutUrl:', checkoutUrl)
  console.log('[TEST_FULL_CANON] canonical_string_full_fields=', canonical)

  const body = { ...values, sign: signature }
  const response = await fetch(checkoutUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
  })
  const text = await response.text()
  let json = null
  try {
    json = JSON.parse(text)
  } catch {
    json = null
  }
  console.log('[TEST_FULL_CANON] gateway_response_status:', response.status)
  console.log('[TEST_FULL_CANON] gateway_response_body:', json ?? text)
  return { checkoutUrl, canonical, signature, responseStatus: response.status, responseJson: json, responseText: text }
}

function buildFullFieldCanonicalString(fieldsList, valuesByKey) {
  const sortedKeys = [...fieldsList].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  const pairs = []
  for (const key of sortedKeys) {
    const v = valuesByKey[key]
    const str = canonicalValueToString(v)
    pairs.push(`${key}=${str}`)
  }
  return pairs.join('&')
}

function normalizePaycloudEndpoint(endpoint) {
  const raw = String(endpoint || '').trim().replace(/\/+$/, '')
  if (!raw) return raw
  try {
    const u = new URL(raw.includes('://') ? raw : `https://${raw}`)
    const host = u.hostname.toLowerCase()
    const path = (u.pathname || '/').replace(/\/$/, '') || ''
    if (host === 'open.finatic.africa' && !path.includes('api/entry')) {
      return `${u.origin}/api/entry`
    }
    return raw
  } catch {
    return raw
  }
}

function toSpkiDer(publicKeyPemOrBase64) {
  const raw = String(publicKeyPemOrBase64 || '')
  const pem = raw.includes('-----BEGIN')
    ? raw.replace(/\\n/g, '\n').trim()
    : normalizePublicKeyMaterialToPem(raw)
  return crypto.createPublicKey(pem).export({ type: 'spki', format: 'der' })
}

export function getPublicKeyFingerprint(publicKeyPemOrBase64) {
  const der = toSpkiDer(publicKeyPemOrBase64)
  return crypto.createHash('sha256').update(der).digest('hex')
}

/**
 * Doc sample: RSA-SHA256 over UTF-8 `123456789` with the **doc’s sample private key** only.
 * Stored as base64url of the signature (equivalent to standard base64 from `crypto.sign`).
 */
const PAYCLOUD_DOC_123456789_SIGNATURE_BASE64URL_EXPECTED =
  'F1kKldW4u0xdSzMqehHLtrX6ntK6gjlZ1Nu1IwcCYAvGe-K9_-9VZymbyNjw038ZcxGspnDqcz7-UnqqJ8gBPpMZ4yZb_NdS5TNqruuSooj2jgPk_PlM-uFH97NlMDuUdGVaflujhcaG9irkq48PHQ1-swaELq7mKov7NU155k7bRPWjNzIggxF5Sgh3qcOBpeWVxp_WghRsjfO4O0tRohiOK5pdcAPkj5VlunUgW0_Yv_uC9sV8dodLloUNWG6W'

export function runPaycloudSign123456789DocTest(privateKeyPem = loadPrivateKey()) {
  const signer = crypto.createSign('RSA-SHA256')
  signer.update('123456789', 'utf8')
  signer.end()
  const rawStandardB64 = signer.sign(privateKeyPem, 'base64')
  const onTheWire = formatPaycloudRequestSignature(rawStandardB64)
  const expectedRawStandardB64 = fromBase64Url(PAYCLOUD_DOC_123456789_SIGNATURE_BASE64URL_EXPECTED)
  const matchesDocPrivateKey = rawStandardB64 === expectedRawStandardB64
  console.log('[PayCloud][SIGN_VECTOR] message=utf8:"123456789"')
  console.log('[PayCloud][SIGN_VECTOR] signature_raw_standard_base64=' + rawStandardB64)
  console.log('[PayCloud][SIGN_VECTOR] signature_on_wire=' + onTheWire)
  console.log('[PayCloud][SIGN_VECTOR] doc_sample_as_base64url=' + PAYCLOUD_DOC_123456789_SIGNATURE_BASE64URL_EXPECTED)
  console.log('[PayCloud][SIGN_VECTOR] matches_doc_sample_private_key=' + matchesDocPrivateKey)
  return {
    signatureRawStandardBase64: rawStandardB64,
    signatureOnWire: onTheWire,
    expectedBase64Url: PAYCLOUD_DOC_123456789_SIGNATURE_BASE64URL_EXPECTED,
    matchesDocSamplePrivateKey: matchesDocPrivateKey,
  }
}

export function getDerivedPublicKeyFingerprintFromPrivateKey(privateKeyPemOrBase64 = loadPrivateKey()) {
  const pem = String(privateKeyPemOrBase64 || '').replace(/\\n/g, '\n').trim()
  const derivedPublicDer = crypto
    .createPublicKey(crypto.createPrivateKey(pem))
    .export({ type: 'spki', format: 'der' })
  return crypto.createHash('sha256').update(derivedPublicDer).digest('hex')
}
