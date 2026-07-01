require('dotenv').config()

async function run() {
  const { createPaymentRequest } = await import('./payments/paycloud.js')
  const { handlePaycloudWebhook } = await import('./payments/webhook.js')
  const useLiveGateway = process.env.PAYCLOUD_TEST_LIVE === 'true'

  const mockOrder = {
    id: 'order_test_001',
    restaurantId: 'rest_001',
    status: 'pending',
    payment_status: 'pending',
  }

  const payment = await createPaymentRequest(
    {
      amount: 129.5,
      orderId: `${mockOrder.restaurantId}:${mockOrder.id}`,
      merchantNo: process.env.PAYCLOUD_MERCHANT_NO,
      storeNo: process.env.PAYCLOUD_STORE_NO,
      description: 'Hosted checkout order',
      notifyUrl: 'https://localhost/webhooks/paycloud',
      returnUrl: 'https://localhost/order-confirmation',
    },
    useLiveGateway
      ? {}
      : {
          transport: async () => {
            const responsePayload = {
              code: 'SUCCESS',
              msg: 'ok',
              pay_url: 'https://open.finatic.africa/api/entry/checkout/mock',
              merchant_order_no: `${mockOrder.restaurantId}:${mockOrder.id}`,
              psn: 'mock-psn-001',
              status: 'paid',
            }
            return {
              ok: true,
              status: 200,
              text: async () => JSON.stringify(responsePayload),
            }
          },
        }
  )

  console.log('Payment request created:', {
    checkoutUrl: payment.checkoutUrl,
    expiresAt: payment.qr?.expiresAt || null,
    qrHasBase64: Boolean(payment.qr?.base64Png),
    qrHasSvg: Boolean(payment.qr?.svg),
    status: payment.paymentStatus,
    liveMode: useLiveGateway,
  })

  const webhookPayload = {
    merchant_order_no: `${mockOrder.restaurantId}:${mockOrder.id}`,
    amount: '129.50',
    status: 'paid',
    psn: 'mock-psn-001',
  }
  const webhookRaw = JSON.stringify(webhookPayload)
  const webhookSignature = require('crypto')
    .createHmac('sha256', process.env.PAYCLOUD_WEBHOOK_SECRET || 'PAYCLOUD_WEBHOOK_SECRET')
    .update(webhookRaw, 'utf8')
    .digest('hex')

  const webhookResult = await handlePaycloudWebhook(
    webhookRaw,
    { 'x-paycloud-sign': webhookSignature },
    {
      onPaid: async (_payload, ref) => {
        if (ref.orderId === `${mockOrder.restaurantId}:${mockOrder.id}`) {
          mockOrder.payment_status = 'paid'
        }
      },
    }
  )

  console.log('Webhook result:', webhookResult)
  console.log('Final order payment status:', mockOrder.payment_status)

  if (mockOrder.payment_status !== 'paid') {
    throw new Error('Test failed: order was not marked paid')
  }

  console.log('PASS: End-to-end hosted checkout simulation succeeded')
}

run().catch((error) => {
  console.error('FAIL:', error.message)
  process.exit(1)
})
