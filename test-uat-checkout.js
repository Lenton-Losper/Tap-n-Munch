/**
 * UAT sandbox auth check without making an actual payment:
 * hosted checkout request should return a pay_url/checkout url.
 *
 * Runs a hosted checkout (no card) so the merchant can redirect the customer.
 */
import { createPaymentRequest } from './payments/paycloud.js'

function ts() {
  return new Date().toISOString()
}

async function main() {
  const orderId = `UAT-CHECKOUT-${Date.now()}`
  const res = await createPaymentRequest({
    amount: 1.0,
    orderId,
    description: `UAT hosted checkout probe ${orderId}`,
    merchantNo: process.env.PAYCLOUD_MERCHANT_NO,
    storeNo: process.env.PAYCLOUD_STORE_NO,
    notifyUrl: 'https://example.com/api/webhooks/paycloud',
    returnUrl: 'https://example.com/order-confirmation',
    priceCurrency: 'NAD',
  })

  console.log(`[${ts()}] [RESULT] wrapper response:`)
  console.log(JSON.stringify(res, null, 2))

  console.log(`[${ts()}] [RESULT] raw gateway response (code/msg/pay_url):`)
  console.log(JSON.stringify(res.rawResponse, null, 2))
}

main().catch((e) => {
  console.error(`[${ts()}] [FATAL]`, e?.stack || e?.message || String(e))
  process.exitCode = 1
})

