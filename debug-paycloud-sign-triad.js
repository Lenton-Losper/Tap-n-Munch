import { getPaycloudConfig } from './payments/paycloud.js'
import { signPayload } from './payments/signature.js'

const HEADERS = {
  'content-type': 'application/json',
  accept: 'application/json',
}

function basePayload(cfg, suffix) {
  const now = Date.now()
  return {
    app_id: cfg.appId,
    merchant_no: cfg.merchantNo,
    store_no: cfg.storeNo,
    sign_type: 'RSA2',
    format: 'JSON',
    charset: 'UTF-8',
    version: '1.0',
    method: 'pay.paycloud.checkout',
    timestamp: String(now),
    merchant_order_no: `TRIAD-${suffix}-${now}`,
    order_amount: '1.00',
    price_currency: 'NAD',
    description: `triad-${suffix}`,
    notify_url: 'https://example.com/paycloud/notify',
    return_url: 'https://example.com/paycloud/return',
    expires: '600',
  }
}

async function call(label, payload) {
  const cfg = getPaycloudConfig()
  const url = cfg.endpoint
  console.log(`\n[TRIAD] ${label} request URL:`, url)
  console.log(`[TRIAD] ${label} payload:`, JSON.stringify(payload, null, 2))

  const res = await fetch(url, { method: 'POST', headers: HEADERS, body: JSON.stringify(payload) })
  const raw = await res.text()
  console.log(`[TRIAD] ${label} status:`, res.status)
  console.log(`[TRIAD] ${label} raw response:`, raw)
}

async function main() {
  const cfg = getPaycloudConfig()

  const unsigned = basePayload(cfg, 'NO')
  await call('no-sign', unsigned)

  const bad = basePayload(cfg, 'BAD')
  bad.sign = 'invalid-signature'
  await call('bad-sign', bad)

  const good = basePayload(cfg, 'GOOD')
  good.sign = signPayload(good)
  await call('good-sign', good)
}

main().catch((error) => {
  console.error('[TRIAD] fatal:', error?.stack || error?.message || String(error))
  process.exitCode = 1
})
