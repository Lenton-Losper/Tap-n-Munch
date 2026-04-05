import {
  exportCanonicalString,
  getDerivedPublicKeyFingerprintFromPrivateKey,
  getPublicKeyFingerprint,
  signPayload,
  verifyPayloadSignature,
} from './signature.js'
import { normalizeGatewayPublicKeyEnvToPem } from './config.js'
import crypto from 'crypto'

/** Local/dev only for clock skew vs Finatic; omit `PAYCLOUD_CLOCK_OFFSET_MS` in .env to match Vercel (defaults to 0). */
const PAYCLOUD_CLOCK_OFFSET_MS = Number(process.env.PAYCLOUD_CLOCK_OFFSET_MS || 0)

/** Exact header Finatic expects; no space before charset (some stacks reject variants). */
export const PAYCLOUD_CONTENT_TYPE = 'application/json;charset=UTF-8'

export const PAYCLOUD_JSON_HEADERS = Object.freeze({
  'Content-Type': PAYCLOUD_CONTENT_TYPE,
  Accept: 'application/json',
})

/**
 * Finatic-hosted PayCloud expects extra protocol fields in the JSON body (SYS011 if omitted).
 * They are included in the RSA2 sign string like all other body fields.
 */
const FINATIC_PROTOCOL_FIELDS = {
  format: 'JSON',
  charset: 'UTF-8',
  version: '1.0',
  methodHostedCheckout: 'pay.paycloud.checkout',
  methodMerchantCheckout: 'pay.merchant.checkout',
  methodQuery: 'order.query',
}

/**
 * Finatic PayCloud: `PAYCLOUD_ENDPOINT` is the entry base (…/api/entry). Hosted checkout
 * POSTs to …/api/entry/checkout; order query POSTs to …/api/entry/orderquery. The JSON
 * `method` field (e.g. pay.paycloud.checkout) selects the operation. Normalize host-only
 * URLs to …/api/entry via normalizePaycloudEndpoint().
 */
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
    if (host.endsWith('wisepaycloud.com') && !path.includes('api/entry')) {
      return `${u.origin}/api/entry`
    }
    return raw
  } catch {
    return raw
  }
}

function buildPaycloudOperationUrl(endpoint, operationPath) {
  const base = String(endpoint || '').trim().replace(/\/+$/, '')
  const op = String(operationPath || '').trim().replace(/^\/+/, '')
  if (!base) return base
  if (!op) return base
  return `${base}/${op}`
}

function requiredEnv(name) {
  const value = process.env[name]
  if (!value) throw new Error(`Missing environment variable: ${name}`)
  return value
}

/** Hosted / merchant checkout only — absolute URLs for Finatic (not request origin). */
function getPaycloudCheckoutUrls() {
  const notifyUrl = String(requiredEnv('PAYCLOUD_NOTIFY_URL')).trim()
  const returnRaw = String(requiredEnv('PAYCLOUD_RETURN_URL')).trim()
  return {
    notifyUrl,
    returnUrl: paycloudCheckoutReturnUrl(returnRaw),
  }
}

export function maskSecrets(data) {
  const raw = JSON.stringify(data || {})
  return raw
    .replace(
      /(token|secret|password|key|private_key|public_key|card_no|cardNo|cvv|card_holder|sign)"\s*:\s*"[^"]+"/gi,
      '$1":"***"'
    )
    .replace(/("Authorization"\s*:\s*"Bearer\s+)[^"]+"/gi, '$1***"')
}

let startupEnvLogged = false

function maskId(value) {
  const s = String(value || '')
  if (s.length <= 6) return '***'
  return `${s.slice(0, 3)}***${s.slice(-3)}`
}

export function getPaycloudConfig() {
  const endpoint = normalizePaycloudEndpoint(requiredEnv('PAYCLOUD_ENDPOINT'))
  const appId = requiredEnv('PAYCLOUD_APP_ID')
  const cfg = {
    /** POST base URL only, e.g. https://open.finatic.africa/api/entry */
    endpoint,
    appId,
    merchantNo: requiredEnv('PAYCLOUD_MERCHANT_NO'),
    storeNo: requiredEnv('PAYCLOUD_STORE_NO'),
    signType: process.env.PAYCLOUD_SIGN_TYPE || 'RSA2',
    queryOrderMethod: FINATIC_PROTOCOL_FIELDS.methodQuery,
    requestTimeoutMs: Number(process.env.PAYCLOUD_TIMEOUT_MS || 15000),
  }
  const epLower = cfg.endpoint.toLowerCase()
  const allowsPaycloud =
    epLower.includes('open.finatic.africa') || epLower.includes('wisepaycloud.com')
  if (!allowsPaycloud) {
    throw new Error(
      'Invalid PayCloud endpoint: must use Finatic or Wiseasy PayCloud gateway (e.g. open.finatic.africa or *.wisepaycloud.com)'
    )
  }
  if (!cfg.appId.startsWith('wz663')) {
    console.warn('[PayCloud] Unexpected App ID — verify Finatic credentials')
  }
  const shouldLogStartup = process.env.DEBUG_PAYCLOUD_ENV_START === 'true' || shouldDebugPaycloud()
  if (shouldLogStartup && !startupEnvLogged) {
    startupEnvLogged = true
    try {
      const configuredPublic = requiredEnv('PAYCLOUD_GATEWAY_PUBLIC_KEY')
      const configuredFingerprint = getPublicKeyFingerprint(configuredPublic)
      const derivedFingerprint = getDerivedPublicKeyFingerprintFromPrivateKey()
      console.log('[PayCloud][ENV] PAYCLOUD_ENDPOINT=', cfg.endpoint)
      console.log('[PayCloud][ENV] PAYCLOUD_APP_ID=', maskId(cfg.appId))
      console.log('[PayCloud][ENV] PAYCLOUD_MERCHANT_NO=', maskId(cfg.merchantNo))
      console.log('[PayCloud][ENV] PAYCLOUD_STORE_NO=', maskId(cfg.storeNo))
      console.log('[PayCloud][ENV] derived_public_fingerprint_sha256=', derivedFingerprint)
      console.log('[PayCloud][ENV] configured_public_fingerprint_sha256=', configuredFingerprint)
    } catch (error) {
      console.warn('[PayCloud][ENV] Unable to compute startup diagnostics:', error?.message || String(error))
    }
  }
  if (process.env.DEBUG_PAYCLOUD_KEYS === 'true') {
    try {
      const configuredPublic = requiredEnv('PAYCLOUD_GATEWAY_PUBLIC_KEY')
      const configuredFingerprint = getPublicKeyFingerprint(configuredPublic)
      const derivedFingerprint = getDerivedPublicKeyFingerprintFromPrivateKey()
      console.log('[PayCloud][KEYS] configured_public_fingerprint_sha256=', configuredFingerprint)
      console.log('[PayCloud][KEYS] derived_from_private_fingerprint_sha256=', derivedFingerprint)
      console.log('[PayCloud][KEYS] fingerprints_match=', configuredFingerprint === derivedFingerprint)
    } catch (error) {
      console.warn('[PayCloud][KEYS] Unable to compute key fingerprints:', error?.message || String(error))
    }
  }
  return cfg
}

function shouldDebugPaycloud() {
  return process.env.NODE_ENV !== 'production' || process.env.DEBUG_PAYCLOUD === 'true'
}

function debugLog(message, data) {
  if (!shouldDebugPaycloud()) return
  const stamp = new Date().toISOString()
  if (data === undefined) {
    console.log(`[PayCloud][${stamp}] ${message}`)
    return
  }
  console.log(`[PayCloud][${stamp}] ${message}`, maskSecrets(data))
}

function fullQueryDebugEnabled() {
  return process.env.DEBUG_PAYCLOUD_FULL_QUERY === 'true'
}

function fullCheckoutDebugEnabled() {
  return process.env.DEBUG_PAYCLOUD_FULL_CHECKOUT === 'true'
}

/**
 * Wire-format diagnostics: Content-Type, sign_type, JSON slash escaping vs PHP json_encode,
 * Base64 vs Base64URL, canonical string stability after JSON.stringify → parse.
 * @param {string} phase
 * @param {Record<string, unknown>} signedPayload payload including `sign`
 * @param {{ force?: boolean }} [opts] set force:true from test scripts to always print
 */
export function logPaycloudSignedWireDiagnostics(phase, signedPayload, opts = {}) {
  const force = opts.force === true
  if (!force && !shouldDebugPaycloud() && process.env.DEBUG_PAYCLOUD_WIRE !== 'true') return

  const ct = PAYCLOUD_JSON_HEADERS['Content-Type']
  console.log(`[PayCloud][WIRE][${phase}] content_type_exact=`, JSON.stringify(ct))
  console.log(
    `[PayCloud][WIRE][${phase}] content_type_bytes_utf8_len=`,
    Buffer.byteLength(ct, 'utf8')
  )

  const st = signedPayload?.sign_type
  const signTypeOk = st === 'RSA2'
  console.log(`[PayCloud][WIRE][${phase}] sign_type=`, st, `RSA2_ok=`, signTypeOk)
  if (!signTypeOk) {
    console.warn(`[PayCloud][WIRE][${phase}] WARNING: sign_type must be "RSA2" in JSON body for Finatic.`)
  }

  const nu = signedPayload?.notify_url
  const ru = signedPayload?.return_url
  if (nu != null || ru != null) {
    const nuS = nu == null ? '' : String(nu)
    const ruS = ru == null ? '' : String(ru)
    console.log(
      `[PayCloud][WIRE][${phase}] url_in_object_has_raw_slashes=`,
      (nuS.includes('https://') || nuS === '') && (ruS.includes('https://') || ruS === '')
    )
  }

  const body = JSON.stringify(signedPayload)
  const slashesEscaped = /\\\//.test(body)
  console.log(`[PayCloud][WIRE][${phase}] json_forward_slashes_escaped_like_php=`, slashesEscaped)
  if (slashesEscaped) {
    const sample = body.match(/https?:[^"]{0,80}/)
    console.log(`[PayCloud][WIRE][${phase}] json_url_snippet=`, sample ? sample[0] : 'n/a')
  }

  try {
    const round = JSON.parse(body)
    const canonObj = exportCanonicalString(signedPayload)
    const canonRound = exportCanonicalString(round)
    const canonMatch = canonObj === canonRound
    console.log(
      `[PayCloud][WIRE][${phase}] canonical_matches_json_roundtrip_wo_sign=`,
      canonMatch
    )
    if (!canonMatch) {
      console.log(`[PayCloud][WIRE][${phase}] canonical_before_roundtrip_len=`, canonObj.length)
      console.log(`[PayCloud][WIRE][${phase}] canonical_after_roundtrip_len=`, canonRound.length)
    }
  } catch (e) {
    console.log(`[PayCloud][WIRE][${phase}] canonical_roundtrip_check_error=`, e?.message || String(e))
  }

  const sign = signedPayload?.sign
  if (sign && typeof sign === 'string') {
    const hasStd = /[+/]/.test(sign)
    const hasUrl = /[-_]/.test(sign) && !/[+/]/.test(sign)
    console.log(
      `[PayCloud][WIRE][${phase}] sign_len=`,
      sign.length,
      `likely_standard_base64_plus_slash=`,
      hasStd,
      `likely_base64url_no_plus_slash=`,
      hasUrl
    )
    const trunc =
      sign.length <= 96 ? sign : `${sign.slice(0, 48)}…[${sign.length}]…${sign.slice(-48)}`
    console.log(`[PayCloud][WIRE][${phase}] sign_truncated=`, trunc)
  } else {
    console.log(`[PayCloud][WIRE][${phase}] sign=`, sign == null ? 'MISSING' : typeof sign)
  }

  const { sign: signField, ...restFields } = signedPayload
  const signTruncForLog =
    signField && typeof signField === 'string' && signField.length > 96
      ? `${signField.slice(0, 48)}…[${signField.length}]…${signField.slice(-48)}`
      : signField
  console.log(
    '[PayCloud] Signed request body:',
    JSON.stringify({ ...restFields, sign: signTruncForLog }, null, 2)
  )
}

/** Rich error for server logging (HTTP status + parsed body + raw text). Never log card fields from payload. */
export class PaycloudRequestError extends Error {
  /**
   * @param {string} message
   * @param {{ httpStatus?: number, responseBody?: unknown, rawText?: string, phase?: string }} [meta]
   */
  constructor(message, meta = {}) {
    super(message)
    this.name = 'PaycloudRequestError'
    this.httpStatus = meta.httpStatus
    this.responseBody = meta.responseBody
    this.rawText = meta.rawText
    this.phase = meta.phase
  }
}

function mapPaycloudError(status, payload, rawText) {
  const message = payload?.msg || payload?.message || 'PayCloud request failed'
  if (status === 401 || status === 403) {
    return new PaycloudRequestError(`Invalid PayCloud credentials: ${message}`, {
      httpStatus: status,
      responseBody: payload,
      rawText,
      phase: 'http',
    })
  }
  if (status >= 500) {
    return new PaycloudRequestError(`PayCloud service unavailable: ${message}`, {
      httpStatus: status,
      responseBody: payload,
      rawText,
      phase: 'http',
    })
  }
  return new PaycloudRequestError(`PayCloud rejected request (${status}): ${message}`, {
    httpStatus: status,
    responseBody: payload,
    rawText,
    phase: 'http',
  })
}

/**
 * Wire `merchant_order_no`: Firebase order id only — strip `restaurantId:` prefix or
 * `restaurantId:receipt:` before comma-separated ids (no colons in single-id form).
 */
export function paycloudWireMerchantOrderNo(orderId) {
  const s = String(orderId || '').trim()
  if (!s) return s

  // Strip app-specific prefixes so gateway sees the "wire format".
  // Examples:
  // - `restaurantId:docId` -> `docId`
  // - `restaurantId:receipt:id1,id2` -> `id1,id2` (caller must ensure it fits PayCloud constraints)
  const receiptMarker = ':receipt:'
  const ri = s.indexOf(receiptMarker)
  let candidate = ''
  if (ri !== -1) {
    candidate = s.slice(ri + receiptMarker.length)
  } else {
    const c = s.indexOf(':')
    candidate = c !== -1 ? s.slice(c + 1) : s
  }

  candidate = String(candidate || '').trim()
  if (!candidate) return candidate

  const PAYCLOUD_MERCHANT_ORDER_NO_MAX_LEN = 32
  // PayCloud allowed charset: numbers, lowercase/uppercase letters, and _-|*@.
  // Intentionally excludes `:` and `,`.
  const PAYCLOUD_MERCHANT_ORDER_NO_ALLOWED_RE = /^[0-9A-Za-z_\-\*@]+$/
  if (candidate.length <= PAYCLOUD_MERCHANT_ORDER_NO_MAX_LEN && PAYCLOUD_MERCHANT_ORDER_NO_ALLOWED_RE.test(candidate)) {
    return candidate
  }

  // If the candidate violates PayCloud constraints, produce a deterministic short code.
  // Note: This means webhook resolution by Firestore `documentId()` won't work for long/invalid ids.
  const digits = (candidate.match(/\d+/g) || []).join('')
  const last10 = digits.slice(-10)
  const last8 = digits.slice(-8).padStart(8, '0')
  const first8 = candidate.replace(/[^0-9A-Za-z_\-\*@]/g, '').slice(0, 8)

  let short
  if (last10.length === 10) {
    short = `FT-${last10}` // FT- + 10 digits => 14 chars
  } else if (first8) {
    short = `FT${first8}${last8}` // FT + 0..8 + 8 => <= 18 chars
  } else {
    // Deterministic fallback using hex (only 0-9a-f).
    const hashHex = crypto.createHash('sha256').update(candidate, 'utf8').digest('hex')
    short = `FT${hashHex.slice(-30)}` // FT + 30 hex => 32 chars
  }

  short = short.replace(/[^0-9A-Za-z_\-\*@]/g, '')
  if (short.length > PAYCLOUD_MERCHANT_ORDER_NO_MAX_LEN) short = short.slice(0, PAYCLOUD_MERCHANT_ORDER_NO_MAX_LEN)
  return short
}

/** Hosted checkout `return_url`: `{origin}/order-confirmation` with no query string. */
export function paycloudCheckoutReturnUrl(returnUrlInput) {
  if (returnUrlInput == null || returnUrlInput === '') return returnUrlInput
  const s = String(returnUrlInput).trim()
  try {
    const u = new URL(s)
    return `${u.origin}/order-confirmation`
  } catch {
    return s
  }
}

function encryptMerchantCardPayload(cardPayload) {
  if (!cardPayload || typeof cardPayload !== 'object' || Array.isArray(cardPayload)) {
    throw new PaycloudRequestError('card payload must be an object', { phase: 'validation' })
  }
  const publicKeyPem = normalizeGatewayPublicKeyEnvToPem()
  const plaintext = Buffer.from(JSON.stringify(cardPayload), 'utf8')
  const encrypted = crypto.publicEncrypt(
    { key: publicKeyPem, padding: crypto.constants.RSA_PKCS1_PADDING },
    plaintext
  )
  return encrypted.toString('base64')
}

export async function createPaymentRequest(input, options = {}) {
  const cfg = getPaycloudConfig()
  const amount = Number(input.amount)

  if (!Number.isFinite(amount) || amount <= 0) {
    throw new PaycloudRequestError('amount must be a positive number', { phase: 'validation' })
  }
  if (!input.orderId) {
    throw new PaycloudRequestError('orderId is required', { phase: 'validation' })
  }

  // Hosted checkout: business params are top-level JSON fields (same shape as official
  // PHP sample on developers.finatic.africa — no biz_content wrapper for these APIs).
  const merchantOrderNo = paycloudWireMerchantOrderNo(input.orderId)
  console.log('[PayCloud][MERCHANT_ORDER_NO][checkout] value=', merchantOrderNo, 'len=', merchantOrderNo?.length)
  const { notifyUrl, returnUrl } = getPaycloudCheckoutUrls()
  const payload = {
    app_id: cfg.appId,
    merchant_no: input.merchantNo || cfg.merchantNo,
    store_no: input.storeNo || cfg.storeNo,
    charset: 'UTF-8',
    expires: Number(input.expiresSeconds || 300),
    method: FINATIC_PROTOCOL_FIELDS.methodHostedCheckout,
    format: FINATIC_PROTOCOL_FIELDS.format,
    version: FINATIC_PROTOCOL_FIELDS.version,
    merchant_order_no: merchantOrderNo,
    order_amount: amount.toFixed(2),
    return_url: returnUrl,
    sign_type: 'RSA2',
    price_currency: input.priceCurrency || 'NAD',
    timestamp: Date.now() - PAYCLOUD_CLOCK_OFFSET_MS,
    description: input.description || `FlashTap order ${input.orderId}`,
    notify_url: notifyUrl,
  }
  const optionalWireFields = {
    pay_options: input.payOptions,
    term_ip: input.termIp,
    latitude: input.latitude,
    longitude: input.longitude,
    attach: input.attach,
  }
  for (const [key, rawValue] of Object.entries(optionalWireFields)) {
    if (rawValue == null) continue
    if (typeof rawValue === 'string' && rawValue === '') continue
    if (key === 'attach' && typeof rawValue === 'object') {
      payload[key] = JSON.stringify(rawValue)
      continue
    }
    payload[key] = rawValue
  }

  const unsignedPayload = { ...payload }
  payload.sign = signPayload(payload)
  logPaycloudSignedWireDiagnostics('checkout', payload)

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), cfg.requestTimeoutMs)
  const transport = options.transport || fetch
  const requestUrl = buildPaycloudOperationUrl(cfg.endpoint, 'checkout')

  debugLog('Request URL', { requestUrl })
  debugLog('Request body before signing', unsignedPayload)
  debugLog('Signed request body', payload)
  if (fullCheckoutDebugEnabled()) {
    console.log('[PayCloud][CHECKOUT][FULL] URL:', requestUrl)
    console.log('[PayCloud][CHECKOUT][FULL] Headers:', PAYCLOUD_JSON_HEADERS)
    console.log('[PayCloud][CHECKOUT][FULL] Payload before sign:', JSON.stringify(unsignedPayload, null, 2))
    console.log('[PayCloud][CHECKOUT][FULL] Payload after sign:', JSON.stringify(payload, null, 2))
  }

  console.log('[PayCloud][WIRE] exact_timestamp_sent:', payload.timestamp)
  console.log('[PayCloud][WIRE] timestamp_type:', typeof payload.timestamp)
  console.log(
    '[PayCloud][WIRE] timestamp_as_date:',
    new Date(
      typeof payload.timestamp === 'number' && payload.timestamp < 9999999999
        ? payload.timestamp * 1000
        : payload.timestamp
    ).toISOString()
  )

  let response
  try {
    response = await transport(requestUrl, {
      method: 'POST',
      headers: PAYCLOUD_JSON_HEADERS,
      body: JSON.stringify(payload),
      signal: controller.signal,
    })
  } catch (error) {
    clearTimeout(timeout)
    if (error?.name === 'AbortError') {
      throw new PaycloudRequestError('PayCloud request timed out', { phase: 'network' })
    }
    throw new PaycloudRequestError(`Network failure calling PayCloud: ${error.message}`, {
      phase: 'network',
      responseBody: { cause: error?.name },
    })
  }
  clearTimeout(timeout)

  const raw = await response.text()
  debugLog('Response status', { status: response.status, ok: response.ok })
  debugLog('Response headers', Object.fromEntries(response.headers.entries()))
  debugLog('Response body', raw)
  if (fullCheckoutDebugEnabled()) {
    console.log('[PayCloud][CHECKOUT][FULL] Raw response headers:', Object.fromEntries(response.headers.entries()))
    console.log('[PayCloud][CHECKOUT][FULL] Raw response body:', raw)
  }
  let body
  try {
    body = JSON.parse(raw)
  } catch {
    throw new PaycloudRequestError(`Invalid PayCloud response format: ${raw.slice(0, 200)}`, {
      httpStatus: response.status,
      rawText: raw,
      phase: 'parse',
    })
  }

  if (!response.ok) {
    throw mapPaycloudError(response.status, body, raw)
  }

  const successCode = String(body.code || '').toUpperCase()
  const treatAsSuccess = !successCode || ['0', 'SUCCESS', '200'].includes(successCode)

  let responseData = body?.data
  if (typeof responseData === 'string') {
    try {
      responseData = JSON.parse(responseData)
    } catch {
      responseData = null
    }
  }

  const checkoutUrl =
    body.pay_url ||
    responseData?.pay_url ||
    body.checkout_url ||
    responseData?.checkout_url ||
    body.payment_url ||
    responseData?.payment_url ||
    body.redirect_url ||
    responseData?.redirect_url ||
    null

  // Success + pay URL: return immediately. Response RSA verify is best-effort only (Finatic key
  // mismatch must not block checkout).
  if (treatAsSuccess && checkoutUrl) {
    if (body.sign) {
      try {
        const signatureOk = verifyPayloadSignature(body, body.sign)
        if (!signatureOk) {
          console.warn(
            '[PayCloud][CHECKOUT] Response signature did not verify (ignored; code ok and pay_url present)'
          )
        }
      } catch (err) {
        console.warn(
          '[PayCloud][CHECKOUT] Response signature verification threw (ignored):',
          err?.message || err
        )
      }
    }
    return {
      provider: 'paycloud',
      integrationType: 'hosted_checkout',
      paymentStatus: String(body.status || body.trade_status || '').toLowerCase() || 'unknown',
      checkoutUrl,
      qrCodeRaw: null,
      qr: null,
      requires3ds: true,
      rawResponse: body,
      gatewayResponse: {
        code: body.code,
        msg: body.msg,
        psn: body.psn,
        merchant_order_no: body.merchant_order_no || payload.merchant_order_no,
      },
    }
  }

  if (successCode && !['0', 'SUCCESS', '200'].includes(successCode)) {
    const failReason = body.msg || body.sub_msg || 'declined'
    throw new PaycloudRequestError(`Payment declined by PayCloud: ${failReason}`, {
      httpStatus: response.status,
      responseBody: body,
      rawText: raw,
      phase: 'business',
    })
  }

  if (!checkoutUrl) {
    throw new PaycloudRequestError('Hosted checkout URL not returned by PayCloud', {
      httpStatus: response.status,
      responseBody: body,
      rawText: raw,
      phase: 'business',
    })
  }
}

export async function createMerchantHostedCheckoutRequest(input, options = {}) {
  const cfg = getPaycloudConfig()
  const amount = Number(input.amount)

  if (!Number.isFinite(amount) || amount <= 0) {
    throw new PaycloudRequestError('amount must be a positive number', { phase: 'validation' })
  }
  if (!input?.orderId) {
    throw new PaycloudRequestError('orderId is required', { phase: 'validation' })
  }
  if (!input?.card || typeof input.card !== 'object') {
    throw new PaycloudRequestError('card is required for pay.merchant.checkout', { phase: 'validation' })
  }

  const merchantOrderNo = paycloudWireMerchantOrderNo(input.orderId)
  console.log('[PayCloud][MERCHANT_ORDER_NO][mcheckout] value=', merchantOrderNo, 'len=', merchantOrderNo?.length)
  const { notifyUrl, returnUrl } = getPaycloudCheckoutUrls()
  const payload = {
    app_id: cfg.appId,
    merchant_no: input.merchantNo || cfg.merchantNo,
    store_no: input.storeNo || cfg.storeNo,
    charset: 'UTF-8',
    expires: Number(input.expiresSeconds || 300),
    method: FINATIC_PROTOCOL_FIELDS.methodMerchantCheckout,
    format: FINATIC_PROTOCOL_FIELDS.format,
    version: FINATIC_PROTOCOL_FIELDS.version,
    merchant_order_no: merchantOrderNo,
    order_amount: amount.toFixed(2),
    return_url: returnUrl,
    sign_type: 'RSA2',
    price_currency: input.priceCurrency || 'NAD',
    timestamp: Date.now() - PAYCLOUD_CLOCK_OFFSET_MS,
    description: input.description || `FlashTap merchant checkout ${input.orderId}`,
    notify_url: notifyUrl,
    card: encryptMerchantCardPayload(input.card),
  }
  const optionalWireFields = {
    pay_options: input.payOptions,
    term_ip: input.termIp,
    latitude: input.latitude,
    longitude: input.longitude,
    attach: input.attach,
  }
  for (const [key, rawValue] of Object.entries(optionalWireFields)) {
    if (rawValue == null) continue
    if (typeof rawValue === 'string' && rawValue === '') continue
    if (key === 'attach' && typeof rawValue === 'object') {
      payload[key] = JSON.stringify(rawValue)
      continue
    }
    payload[key] = rawValue
  }

  const unsignedPayload = { ...payload }
  payload.sign = signPayload(payload)
  logPaycloudSignedWireDiagnostics('mcheckout', payload)

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), cfg.requestTimeoutMs)
  const transport = options.transport || fetch
  const requestUrl = buildPaycloudOperationUrl(cfg.endpoint, 'mcheckout')

  debugLog('Merchant checkout URL', { requestUrl })
  debugLog('Merchant checkout body before signing', unsignedPayload)
  debugLog('Merchant checkout signed body', payload)

  let response
  try {
    response = await transport(requestUrl, {
      method: 'POST',
      headers: PAYCLOUD_JSON_HEADERS,
      body: JSON.stringify(payload),
      signal: controller.signal,
    })
  } catch (error) {
    clearTimeout(timeout)
    if (error?.name === 'AbortError') {
      throw new PaycloudRequestError('PayCloud merchant checkout request timed out', { phase: 'network' })
    }
    throw new PaycloudRequestError(`Network failure calling PayCloud merchant checkout: ${error.message}`, {
      phase: 'network',
      responseBody: { cause: error?.name },
    })
  }
  clearTimeout(timeout)

  const raw = await response.text()
  debugLog('Merchant checkout response status', { status: response.status, ok: response.ok })
  debugLog('Merchant checkout response headers', Object.fromEntries(response.headers.entries()))
  debugLog('Merchant checkout response body', raw)

  let body
  try {
    body = JSON.parse(raw)
  } catch {
    throw new PaycloudRequestError(`Invalid PayCloud merchant checkout response format: ${raw.slice(0, 200)}`, {
      httpStatus: response.status,
      rawText: raw,
      phase: 'parse',
    })
  }

  if (!response.ok) throw mapPaycloudError(response.status, body, raw)
  const successCode = String(body.code || '').toUpperCase()
  if (successCode && !['0', 'SUCCESS', '200'].includes(successCode)) {
    const failReason = body.msg || body.sub_msg || 'declined'
    throw new PaycloudRequestError(`Merchant checkout declined by PayCloud: ${failReason}`, {
      httpStatus: response.status,
      responseBody: body,
      rawText: raw,
      phase: 'business',
    })
  }

  return {
    status: response.status,
    rawResponse: body,
    gatewayResponse: {
      code: body.code,
      msg: body.msg,
      psn: body.psn,
      merchant_order_no: body.merchant_order_no || payload.merchant_order_no,
    },
  }
}

export async function queryPaymentOrder(input, options = {}) {
  const cfg = getPaycloudConfig()
  if (!input?.orderId) {
    throw new PaycloudRequestError('orderId is required', { phase: 'validation' })
  }
  const merchantOrderNo = paycloudWireMerchantOrderNo(input.orderId)
  console.log('[PayCloud][MERCHANT_ORDER_NO][query] value=', merchantOrderNo, 'len=', merchantOrderNo?.length)

  const payload = {
    app_id: cfg.appId,
    merchant_no: input.merchantNo || cfg.merchantNo,
    store_no: input.storeNo || cfg.storeNo,
    sign_type: 'RSA2',
    format: FINATIC_PROTOCOL_FIELDS.format,
    charset: 'UTF-8',
    version: FINATIC_PROTOCOL_FIELDS.version,
    method: cfg.queryOrderMethod,
    timestamp: Date.now() - PAYCLOUD_CLOCK_OFFSET_MS,
    merchant_order_no: merchantOrderNo,
  }
  const unsignedPayload = { ...payload }
  payload.sign = signPayload(payload)
  logPaycloudSignedWireDiagnostics('query', payload)

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), cfg.requestTimeoutMs)
  const transport = options.transport || fetch
  const requestUrl = buildPaycloudOperationUrl(cfg.endpoint, 'orderquery')
  try {
    const u = new URL(requestUrl)
    if (!u.pathname.replace(/\/+$/, '').toLowerCase().endsWith('/api/entry/orderquery')) {
      throw new Error('path')
    }
  } catch {
    throw new PaycloudRequestError(
      'PAYCLOUD_ENDPOINT query URL must resolve to /api/entry/orderquery',
      { phase: 'validation' }
    )
  }

  const expectedFields = [
    'app_id',
    'merchant_no',
    'sign_type',
    'format',
    'charset',
    'version',
    'method',
    'timestamp',
    'merchant_order_no',
  ]
  const payloadFields = Object.keys(payload).sort()
  const missingFields = expectedFields.filter((k) => !(k in payload))
  const extraFields = payloadFields.filter((k) => !expectedFields.includes(k))

  debugLog('Query URL', { requestUrl })
  debugLog('Query body before signing', unsignedPayload)
  debugLog('Signed query body', payload)
  if (fullQueryDebugEnabled()) {
    console.log('[PayCloud][QUERY][FULL] URL:', requestUrl)
    console.log('[PayCloud][QUERY][FULL] Headers:', PAYCLOUD_JSON_HEADERS)
    console.log('[PayCloud][QUERY][FULL] Payload before sign:', JSON.stringify(unsignedPayload, null, 2))
    console.log('[PayCloud][QUERY][FULL] Payload after sign:', JSON.stringify(payload, null, 2))
    console.log('[PayCloud][QUERY][FULL] Expected fields:', expectedFields)
    console.log('[PayCloud][QUERY][FULL] Payload fields:', payloadFields)
    console.log('[PayCloud][QUERY][FULL] Missing fields:', missingFields)
    console.log('[PayCloud][QUERY][FULL] Extra fields:', extraFields)
  }

  let response
  try {
    response = await transport(requestUrl, {
      method: 'POST',
      headers: PAYCLOUD_JSON_HEADERS,
      body: JSON.stringify(payload),
      signal: controller.signal,
    })
  } catch (error) {
    clearTimeout(timeout)
    if (error?.name === 'AbortError') {
      throw new PaycloudRequestError('PayCloud query request timed out', { phase: 'network' })
    }
    throw new PaycloudRequestError(`Network failure querying PayCloud: ${error.message}`, {
      phase: 'network',
      responseBody: { cause: error?.name },
    })
  }
  clearTimeout(timeout)

  const raw = await response.text()
  debugLog('Query response status', { status: response.status, ok: response.ok })
  debugLog('Query response headers', Object.fromEntries(response.headers.entries()))
  debugLog('Query response body', raw)
  if (fullQueryDebugEnabled()) {
    console.log('[PayCloud][QUERY][FULL] Raw response headers:', Object.fromEntries(response.headers.entries()))
    console.log('[PayCloud][QUERY][FULL] Raw response body:', raw)
  }

  let body
  try {
    body = JSON.parse(raw)
  } catch {
    throw new PaycloudRequestError(`Invalid PayCloud query response format: ${raw.slice(0, 200)}`, {
      httpStatus: response.status,
      rawText: raw,
      phase: 'parse',
    })
  }

  if (!response.ok) {
    throw mapPaycloudError(response.status, body, raw)
  }

  const successCode = String(body.code || '').toUpperCase()
  const treatAsSuccess = !successCode || ['0', 'SUCCESS', '200'].includes(successCode)

  const signature = body.sign
  if (signature && treatAsSuccess) {
    const signatureOk = verifyPayloadSignature(body, signature)
    if (!signatureOk) {
      throw new PaycloudRequestError('PayCloud query signature verification failed', {
        httpStatus: response.status,
        responseBody: body,
        rawText: raw,
        phase: 'signature',
      })
    }
  }

  return {
    status: response.status,
    rawResponse: body,
    gatewayResponse: {
      code: body.code,
      msg: body.msg,
      psn: body.psn,
      merchant_order_no: body.merchant_order_no || payload.merchant_order_no,
      trade_status: body.trade_status || body.status || null,
    },
  }
}

export async function checkPaycloudHealth() {
  const cfg = getPaycloudConfig()
  try {
    const res = await fetch(cfg.endpoint, { method: 'GET' })
    return {
      ok: res.ok,
      status: res.status,
      endpoint: cfg.endpoint,
    }
  } catch (error) {
    return {
      ok: false,
      status: 0,
      endpoint: cfg.endpoint,
      error: error.message,
    }
  }
}
