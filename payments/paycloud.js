import { signPayload, verifyPayloadSignature } from './signature.js'
import { generateTransactionQr } from './qr.js'

function requiredEnv(name) {
  const value = process.env[name]
  if (!value) throw new Error(`Missing environment variable: ${name}`)
  return value
}

export function maskSecrets(data) {
  const raw = JSON.stringify(data || {})
  return raw.replace(/(token|secret|password|key)"\s*:\s*"[^"]+"/gi, '$1":"***"')
}

export function getPaycloudConfig() {
  return {
    endpoint: requiredEnv('PAYCLOUD_ENDPOINT'),
    appId: requiredEnv('PAYCLOUD_APP_ID'),
    merchantNo: requiredEnv('PAYCLOUD_MERCHANT_NO'),
    storeNo: requiredEnv('PAYCLOUD_STORE_NO'),
    signType: process.env.PAYCLOUD_SIGN_TYPE || 'RSA2',
    merchantCheckoutPath: process.env.PAYCLOUD_MERCHANT_CHECKOUT_PATH || '/mcheckout',
    queryOrderPath: process.env.PAYCLOUD_QUERY_ORDER_PATH || '/query',
    requestTimeoutMs: Number(process.env.PAYCLOUD_TIMEOUT_MS || 15000),
  }
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

  const payload = {
    app_id: cfg.appId,
    merchant_no: input.merchantNo || cfg.merchantNo,
    store_no: input.storeNo || cfg.storeNo,
    sign_type: cfg.signType,
    timestamp: Date.now().toString(),
    merchant_order_no: String(input.orderId),
    order_amount: amount.toFixed(2),
    price_currency: 'NAD',
    description: input.description || `FlashTap order ${input.orderId}`,
    notify_url: input.notifyUrl,
    return_url: input.returnUrl,
    expires: String(input.expiresSeconds || 600),
    attach: JSON.stringify(input.attach || {}),
  }

  if (input.card) {
    payload.card_no = String(input.card.cardNo || '').replace(/\s+/g, '')
    payload.cvv = String(input.card.cvv || '')
    payload.expire_month = String(input.card.expireMonth || '')
    payload.expire_year = String(input.card.expireYear || '')
    payload.card_holder = String(input.card.cardHolder || '')
    payload.term_ip = String(input.card.termIp || input.termIp || '127.0.0.1')
  }

  payload.sign = signPayload(payload)

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), cfg.requestTimeoutMs)
  const transport = options.transport || fetch

  let response
  try {
    response = await transport(`${cfg.endpoint}${cfg.merchantCheckoutPath}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
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

  const signature = body.sign
  if (signature) {
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

  const successCode = String(body.code || '').toUpperCase()
  if (successCode && !['0', 'SUCCESS', '200'].includes(successCode)) {
    const failReason = body.msg || body.sub_msg || 'declined'
    throw new PaycloudRequestError(`Payment declined by PayCloud: ${failReason}`, {
      httpStatus: response.status,
      responseBody: body,
      rawText: raw,
      phase: 'business',
    })
  }

  const paymentUrl = body.pay_url || body.checkout_url || body.payment_url || body.redirect_url || null
  const qrCode = body.qr_code || body.qr_url || null
  const checkoutUrl = paymentUrl || qrCode
  const qrData = checkoutUrl ? await generateTransactionQr(checkoutUrl) : null
  return {
    provider: 'paycloud',
    integrationType: 'merchant_hosted_checkout',
    paymentStatus: String(body.status || body.trade_status || '').toLowerCase() || 'unknown',
    checkoutUrl,
    qrCodeRaw: qrCode,
    qr: qrData,
    requires3ds: Boolean(body.redirect_url || body.three_ds_url),
    rawResponse: body,
    gatewayResponse: {
      code: body.code,
      msg: body.msg,
      psn: body.psn,
      merchant_order_no: body.merchant_order_no || payload.merchant_order_no,
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
