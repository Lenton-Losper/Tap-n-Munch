/**
 * Build full UAT hosted checkout payload (including `sign`) and send it.
 * No cards included, so this is just an auth/checkout-probe (no charge).
 */
import { getPaycloudConfig, paycloudWireMerchantOrderNo, paycloudCheckoutReturnUrl } from './payments/paycloud.js'
import { signPayload } from './payments/signature.js'

function ts() {
  return new Date().toISOString()
}

async function main() {
  const cfg = getPaycloudConfig()

  const orderId = `UAT-CHECKOUT-${Date.now()}`
  const timestamp = Date.now() - Number(process.env.PAYCLOUD_CLOCK_OFFSET_MS || 0)

  const payload = {
    app_id: cfg.appId,
    merchant_no: cfg.merchantNo,
    store_no: cfg.storeNo,
    charset: 'UTF-8',
    expires: 900,
    method: 'pay.paycloud.checkout',
    format: 'JSON',
    version: '1.0',
    merchant_order_no: paycloudWireMerchantOrderNo(orderId),
    order_amount: Number(1.0).toFixed(2),
    return_url: paycloudCheckoutReturnUrl('https://example.com/order-confirmation'),
    sign_type: 'RSA2',
    price_currency: 'NAD',
    timestamp,
    description: `UAT hosted checkout probe ${orderId}`,
    notify_url: 'https://example.com/api/webhooks/paycloud',
  }

  payload.sign = signPayload(payload)

  const requestUrl = `${cfg.endpoint.replace(/\/+$/, '')}/checkout`

  console.log(`[${ts()}] [DUMP] requestUrl: ${requestUrl}`)
  console.log(`[${ts()}] [DUMP] full payload JSON:`)
  console.log(JSON.stringify(payload, null, 2))

  const res = await fetch(requestUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json;charset=UTF-8', Accept: 'application/json' },
    body: JSON.stringify(payload),
  })

  const text = await res.text()
  let json = null
  try {
    json = JSON.parse(text)
  } catch {
    json = null
  }

  console.log(`[${ts()}] [POST] HTTP ${res.status}`)
  console.log(`[${ts()}] [POST] response body:`)
  console.log(json ?? text)
}

main().catch((e) => {
  console.error(`[${ts()}] [FATAL]`, e?.stack || e?.message || String(e))
  process.exitCode = 1
})

