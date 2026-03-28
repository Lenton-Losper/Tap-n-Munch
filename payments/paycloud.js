import {
  exportCanonicalString,
  getDerivedPublicKeyFingerprintFromPrivateKey,
  getPublicKeyFingerprint,
  signPayload,
  verifyPayloadSignature,
} from './signature.js'

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
  methodQuery: 'order.query',
}

/**
 * Finatic PayCloud uses one HTTPS entry for every operation; the JSON `method` field
 * selects checkout vs order query, etc. Normalize host-only URLs to …/api/entry.
 * Do not append /checkout or /orderquery — those are not used.
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
  if (!cfg.endpoint.includes('open.finatic.africa')) {
    throw new Error('Invalid PayCloud endpoint: must use Finatic gateway')
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
  const payload = {
    app_id: cfg.appId,
    merchant_no: input.merchantNo || cfg.merchantNo,
    store_no: input.storeNo || cfg.storeNo,
    sign_type: 'RSA2',
    format: FINATIC_PROTOCOL_FIELDS.format,
    charset: 'UTF-8',
    version: FINATIC_PROTOCOL_FIELDS.version,
    method: FINATIC_PROTOCOL_FIELDS.methodHostedCheckout,
    timestamp: String(Date.now() - PAYCLOUD_CLOCK_OFFSET_MS),
    merchant_order_no: String(input.orderId),
    order_amount: amount.toFixed(2),
    price_currency: 'NAD',
    description: input.description || `FlashTap order ${input.orderId}`,
    notify_url: input.notifyUrl,
    return_url: input.returnUrl,
    expires: Number(input.expiresSeconds || 600),
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

  const signature = body.sign
  if (signature && treatAsSuccess) {
    const signatureOk = verifyPayloadSignature(body, signature)
    if (!signatureOk) {
      throw new PaycloudRequestError('PayCloud response signature verification failed', {
        httpStatus: response.status,
        responseBody: body,
        rawText: raw,
        phase: 'signature',
      })
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

  let responseData = body?.data
  if (typeof responseData === 'string') {
    try {
      responseData = JSON.parse(responseData)
    } catch {
      responseData = null
    }
  }

  const paymentUrl =
    body.pay_url ||
    responseData?.pay_url ||
    body.checkout_url ||
    responseData?.checkout_url ||
    body.payment_url ||
    responseData?.payment_url ||
    body.redirect_url ||
    responseData?.redirect_url ||
    null
  const checkoutUrl = paymentUrl
  if (!checkoutUrl) {
    throw new PaycloudRequestError('Hosted checkout URL not returned by PayCloud', {
      httpStatus: response.status,
      responseBody: body,
      rawText: raw,
      phase: 'business',
    })
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

export async function queryPaymentOrder(input, options = {}) {
  const cfg = getPaycloudConfig()
  if (!input?.orderId) {
    throw new PaycloudRequestError('orderId is required', { phase: 'validation' })
  }

  const payload = {
    app_id: cfg.appId,
    merchant_no: input.merchantNo || cfg.merchantNo,
    store_no: input.storeNo || cfg.storeNo,
    sign_type: 'RSA2',
    format: FINATIC_PROTOCOL_FIELDS.format,
    charset: 'UTF-8',
    version: FINATIC_PROTOCOL_FIELDS.version,
    method: cfg.queryOrderMethod,
    timestamp: String(Date.now() - PAYCLOUD_CLOCK_OFFSET_MS),
    merchant_order_no: String(input.orderId),
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
