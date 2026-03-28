import {
  getPaycloudConfig,
  createPaymentRequest,
  queryPaymentOrder,
  PaycloudRequestError,
  maskSecrets,
  PAYCLOUD_JSON_HEADERS,
  logPaycloudSignedWireDiagnostics,
} from './payments/paycloud.js'
import { signPayload, verifyPayloadSignature, loadPrivateKey, formatPaycloudRequestSignature } from './payments/signature.js'
import { testFullFieldCanonical } from './payments/signature.js'
import { verifyWebhook } from './payments/webhook.js'
import crypto from 'crypto'

const PAYCLOUD_CLOCK_OFFSET_MS = Number(process.env.PAYCLOUD_CLOCK_OFFSET_MS || 0)

function ts() {
  return new Date().toISOString()
}

function log(step, message, data) {
  if (data === undefined) {
    console.log(`[${ts()}] [${step}] ${message}`)
    return
  }
  console.log(`[${ts()}] [${step}] ${message}:`, typeof data === 'string' ? data : JSON.stringify(data, null, 2))
}

function serializeHeaders(headers) {
  const out = {}
  for (const [k, v] of headers.entries()) out[k] = v
  return out
}

function logKeyUsageDiagOnce() {
  const pkcs1 = loadPrivateKey()
  console.log('[KEYDIAG] pkcs1_private_key_pem_first60:', pkcs1.slice(0, 60))

  const signer = crypto.createSign('RSA-SHA256')
  signer.update('hello', 'utf8')
  signer.end()
  const sig = formatPaycloudRequestSignature(signer.sign(pkcs1, 'base64'))
  console.log('[KEYDIAG] sign("hello") on_wire_first40:', sig.slice(0, 40))
}

function logDetailedError(step, error) {
  if (error instanceof PaycloudRequestError) {
    log(step, 'ERROR message', error.message)
    log(step, 'ERROR phase', error.phase || null)
    log(step, 'ERROR httpStatus', error.httpStatus ?? null)
    log(step, 'ERROR responseBody', error.responseBody ?? null)
    log(step, 'ERROR rawText', error.rawText ?? null)
    return
  }
  log(step, 'ERROR', error?.stack || error?.message || String(error))
}

async function signedPost(url, payload) {
  const signed = { ...payload, sign: signPayload(payload) }
  logPaycloudSignedWireDiagnostics('STEP1-signedPost', signed, { force: true })
  const res = await fetch(url, {
    method: 'POST',
    headers: { ...PAYCLOUD_JSON_HEADERS },
    body: JSON.stringify(signed),
  })
  const text = await res.text()
  let json = null
  try {
    json = JSON.parse(text)
  } catch {
    json = null
  }
  return { res, text, json, signed }
}

async function postSignedJson(url, signed) {
  logPaycloudSignedWireDiagnostics('GW-paycloud.world-probe', signed, { force: true })
  const res = await fetch(url, {
    method: 'POST',
    headers: { ...PAYCLOUD_JSON_HEADERS },
    body: JSON.stringify(signed),
  })
  const text = await res.text()
  let json = null
  try {
    json = JSON.parse(text)
  } catch {
    json = null
  }
  return { res, text, json }
}

async function main() {
  console.log('[CLOCK] offset_ms:', PAYCLOUD_CLOCK_OFFSET_MS)
  console.log('[CLOCK] corrected_timestamp:', Date.now() - PAYCLOUD_CLOCK_OFFSET_MS)
  console.log(
    '[CLOCK] corrected_date:',
    new Date(Date.now() - PAYCLOUD_CLOCK_OFFSET_MS).toISOString()
  )

  const cfg = getPaycloudConfig()
  const baseOrderId = `TEST001-${Date.now()}`

  logKeyUsageDiagOnce()

  try {
    await testFullFieldCanonical()
  } catch (error) {
    console.error('[TEST_FULL_CANON] failed:', error instanceof Error ? error.message : String(error))
  }
  log('INIT', 'Starting live PayCloud test suite')
  log('INIT', 'Config', {
    endpoint: cfg.endpoint,
    step1Method: 'pay.paycloud.checkout',
    queryOrderMethod: cfg.queryOrderMethod,
    checkoutMethod: 'pay.paycloud.checkout',
    timeoutMs: cfg.requestTimeoutMs,
  })

  // Step 1: Connectivity using hosted checkout method (same method as production)
  try {
    log('STEP1', 'Connectivity test started (pay.paycloud.checkout)')
    const payload = {
      app_id: cfg.appId,
      merchant_no: cfg.merchantNo,
      store_no: cfg.storeNo,
      sign_type: 'RSA2',
      format: 'JSON',
      charset: 'UTF-8',
      version: '1.0',
      method: 'pay.paycloud.checkout',
      timestamp: Date.now() - PAYCLOUD_CLOCK_OFFSET_MS,
      merchant_order_no: `${baseOrderId}-CONNECT`,
      order_amount: '1.00',
      price_currency: 'NAD',
      description: `FlashTap STEP1 connectivity ${baseOrderId}`,
      notify_url: 'https://example.com/api/webhooks/paycloud',
      return_url: 'https://example.com/order-confirmation',
      expires: 600,
    }
    const url = cfg.endpoint
    log('STEP1', 'Request URL', url)
    log('STEP1', 'Unsigned payload', JSON.parse(maskSecrets(payload)))
    const { res, text, json, signed } = await signedPost(url, payload)
    log('STEP1', 'Signed payload', JSON.parse(maskSecrets(signed)))
    log('STEP1', 'HTTP status', res.status)
    log('STEP1', 'Response headers', serializeHeaders(res.headers))
    log('STEP1', 'Response body', json ?? text)
    if (json?.code && String(json.code).toUpperCase() === 'SYS002') {
      console.log('[STEP1][SYS002] Compare SIGN_STRING_BYTES (hex above) with gateway-expected canonical UTF-8 bytes.')
      console.log('[STEP1][SYS002] psn=', json.psn)
    }

    const gwUrl = 'https://gw.paycloud.world/api/entry'
    const gw = await postSignedJson(gwUrl, signed)
    console.log(`[GW-PAYCLOUD][CHECKOUT] url=${gwUrl} status=${gw.res.status}`)
    if (gw.json) console.log(`[GW-PAYCLOUD][CHECKOUT] response=${JSON.stringify(gw.json, null, 2)}`)
    else console.log(`[GW-PAYCLOUD][CHECKOUT] responseText=${gw.text}`)
  } catch (error) {
    logDetailedError('STEP1', error)
  }

  // Step 2: Create hosted checkout payment (NAD 1.00)
  let createdOrderId = baseOrderId
  /** Last JSON body from checkout call (success or PayCloud error) — used for STEP4 verify */
  let lastCheckoutGatewayBody = null
  try {
    log('STEP2', 'Hosted checkout request started')
    const response = await createPaymentRequest({
      amount: 1.0,
      orderId: createdOrderId,
      description: `FlashTap live test ${createdOrderId}`,
      merchantNo: cfg.merchantNo,
      storeNo: cfg.storeNo,
      notifyUrl: 'https://example.com/api/webhooks/paycloud',
      returnUrl: 'https://example.com/order-confirmation',
    })
    log('STEP2', 'Create payment response', JSON.parse(maskSecrets(response)))
    lastCheckoutGatewayBody = response?.rawResponse || null
    if (response.checkoutUrl) {
      log('STEP2', 'Checkout URL', response.checkoutUrl)
    } else {
      throw new Error('Hosted checkout URL was not returned')
    }
  } catch (error) {
    logDetailedError('STEP2', error)
    if (error instanceof PaycloudRequestError && error.responseBody && typeof error.responseBody === 'object') {
      lastCheckoutGatewayBody = error.responseBody
    }
    process.exitCode = 1
  }

  // Step 3: Query order status
  try {
    log('STEP3', 'Order query started')
    const query = await queryPaymentOrder({
      orderId: createdOrderId,
      merchantNo: cfg.merchantNo,
      storeNo: cfg.storeNo,
    })
    log('STEP3', 'Query result', JSON.parse(maskSecrets(query)))
  } catch (error) {
    logDetailedError('STEP3', error)
  }

  // Step 4: Gateway response signature verification (environment key correctness)
  try {
    log('STEP4', 'Gateway response signature verification started')
    if (!lastCheckoutGatewayBody?.sign) {
      throw new Error('No gateway sign in checkout response (no HTTP body captured)')
    }
    const result = {
      ok: verifyPayloadSignature(lastCheckoutGatewayBody, lastCheckoutGatewayBody.sign),
      mode: 'rsa',
      note: 'Verifies Finatic gateway public key against the last checkout HTTP body (success or SYS002).',
    }
    log('STEP4', 'Verification result', result)
    if (!result.ok) process.exitCode = 1
  } catch (error) {
    logDetailedError('STEP4', error)
    process.exitCode = 1
  }

  log('DONE', 'Live PayCloud test suite finished')
}

main().catch((error) => {
  log('FATAL', 'Unhandled error', error?.stack || error?.message || String(error))
  process.exitCode = 1
})
