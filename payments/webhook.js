import crypto from 'crypto'
import { verifyPayloadSignature } from './signature.js'

const webhookRateBuckets = new Map()
const RATE_WINDOW_MS = 60 * 1000
const RATE_MAX = Number(process.env.PAYCLOUD_WEBHOOK_RATE_MAX || 300)
const DEFAULT_PAYCLOUD_IPS = [
  '8.208.97.72',
  '8.208.116.200',
  '8.208.86.91',
  '8.208.115.19',
  '8.208.9.143',
  '52.76.234.70',
  '52.74.154.164',
]

function normalizeIp(rawIp = 'unknown') {
  const value = String(rawIp).split(',')[0].trim()
  return value.replace(/^::ffff:/, '').replace(/:\d+$/, '') || 'unknown'
}

function getTrustedWebhookIps() {
  const fromEnv = String(process.env.PAYCLOUD_WEBHOOK_ALLOWED_IPS || '')
    .split(',')
    .map((v) => normalizeIp(v))
    .filter(Boolean)
  return new Set(fromEnv.length ? fromEnv : DEFAULT_PAYCLOUD_IPS)
}

export function enforceWebhookRateLimit(ip) {
  const now = Date.now()
  const key = normalizeIp(ip)
  const trustedIps = getTrustedWebhookIps()
  if (trustedIps.has(key)) {
    return { allowed: true, remaining: RATE_MAX, bypass: true }
  }

  const bucket = webhookRateBuckets.get(key) || { count: 0, start: now }

  if (now - bucket.start > RATE_WINDOW_MS) {
    webhookRateBuckets.set(key, { count: 1, start: now })
    return { allowed: true, remaining: RATE_MAX - 1 }
  }

  bucket.count += 1
  webhookRateBuckets.set(key, bucket)

  return {
    allowed: bucket.count <= RATE_MAX,
    remaining: Math.max(0, RATE_MAX - bucket.count),
  }
}

function safeJsonParse(raw) {
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

function verifyWithSharedSecret(rawBody, providedSignature) {
  if (!process.env.PAYCLOUD_WEBHOOK_SECRET || !providedSignature) return false
  const expected = crypto
    .createHmac('sha256', process.env.PAYCLOUD_WEBHOOK_SECRET)
    .update(rawBody, 'utf8')
    .digest('hex')
  const provided = String(providedSignature)
  if (provided.length !== expected.length) return false
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(provided))
}

export function verifyWebhook(rawBody, parsedBody, headers = {}) {
  const headerSignature =
    headers['x-paycloud-sign'] ||
    headers['paycloud-sign'] ||
    headers['x-signature'] ||
    parsedBody?.sign

  if (!headerSignature) {
    return { ok: false, reason: 'Missing webhook signature' }
  }

  const usesSharedSecret = verifyWithSharedSecret(rawBody, headerSignature)
  if (usesSharedSecret) {
    return { ok: true, mode: 'hmac' }
  }

  try {
    const ok = verifyPayloadSignature(parsedBody, headerSignature)
    return ok ? { ok: true, mode: 'rsa' } : { ok: false, reason: 'Invalid RSA signature' }
  } catch (error) {
    return { ok: false, reason: error.message }
  }
}

function extractWebhookOrderRef(payload) {
  return {
    orderId: payload?.merchant_order_no || payload?.order_id || payload?.out_trade_no || null,
    merchantId: payload?.merchant_no || null,
    storeNumber: payload?.store_no || null,
    paidAmount: payload?.amount || payload?.paid_amount || null,
    transactionId: payload?.psn || payload?.transaction_id || null,
    status: String(payload?.status || payload?.trade_status || payload?.payment_status || 'unknown').toLowerCase(),
  }
}

export async function handlePaycloudWebhook(rawBody, headers, handlers = {}) {
  const payload = safeJsonParse(rawBody)
  if (!payload || typeof payload !== 'object') {
    return { status: 400, body: { ok: false, error: 'Invalid JSON payload' } }
  }

  const minimalFields = ['merchant_order_no', 'amount']
  const hasRequired = minimalFields.every((f) => payload[f] !== undefined && payload[f] !== null)
  if (!hasRequired) {
    return { status: 400, body: { ok: false, error: 'Missing required webhook fields' } }
  }

  const verifyResult = verifyWebhook(rawBody, payload, headers)
  if (!verifyResult.ok) {
    return { status: 401, body: { ok: false, error: verifyResult.reason } }
  }

  const ref = extractWebhookOrderRef(payload)
  if (!ref.orderId) {
    return { status: 400, body: { ok: false, error: 'Unable to resolve order reference' } }
  }

  if (typeof handlers.onEvent === 'function') {
    await handlers.onEvent(payload, ref)
  }
  if (typeof handlers.onPaid === 'function' && ['paid', 'success', 'succeeded'].includes(ref.status)) {
    await handlers.onPaid(payload, ref)
  }

  return {
    status: 200,
    body: { ok: true, mode: verifyResult.mode, orderId: ref.orderId, status: ref.status },
  }
}
