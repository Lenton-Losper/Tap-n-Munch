import { getPaycloudConfig, queryPaymentOrder } from './payments/paycloud.js'
import { signPayload } from './payments/signature.js'

function ts() {
  return new Date().toISOString()
}

function log(label, value) {
  if (value === undefined) {
    console.log(`[${ts()}] ${label}`)
    return
  }
  console.log(`[${ts()}] ${label}:`, typeof value === 'string' ? value : JSON.stringify(value, null, 2))
}

async function main() {
  const cfg = getPaycloudConfig()
  const orderId = `QUERY-ONLY-${Date.now()}`
  const payloadBeforeSign = {
    app_id: cfg.appId,
    merchant_no: cfg.merchantNo,
    store_no: cfg.storeNo,
    sign_type: cfg.signType,
    format: 'JSON',
    charset: 'UTF-8',
    version: '1.0',
    method: cfg.queryOrderMethod,
    timestamp: Date.now().toString(),
    merchant_order_no: orderId,
  }
  const payloadAfterSign = { ...payloadBeforeSign, sign: signPayload(payloadBeforeSign) }
  const requestUrl = cfg.endpoint

  log('CONFIG', {
    endpoint: cfg.endpoint,
    queryOrderMethod: cfg.queryOrderMethod,
    requestUrl,
  })
  log('QUERY BEFORE SIGN', payloadBeforeSign)
  log('QUERY AFTER SIGN', payloadAfterSign)

  try {
    const query = await queryPaymentOrder({ orderId })
    log('QUERY RESULT', query)
  } catch (error) {
    const e = error
    log('QUERY ERROR', {
      message: e?.message || String(e),
      phase: e?.phase || null,
      httpStatus: e?.httpStatus ?? null,
      responseBody: e?.responseBody ?? null,
      rawText: e?.rawText ?? null,
    })
    process.exitCode = 1
  }
}

main().catch((error) => {
  log('FATAL', error?.stack || error?.message || String(error))
  process.exitCode = 1
})
