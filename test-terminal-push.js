const ENDPOINT = 'https://open.finatic.africa/api/entry/ecrorder'

function requiredEnv(name) {
  const value = process.env[name]
  if (!value || !String(value).trim()) {
    throw new Error(`Missing required env var: ${name}`)
  }
  return String(value).trim()
}

const CANONICAL_KEYS = [
  'api_version',
  'app_id',
  'charset',
  'description',
  'expires',
  'format',
  'merchant_no',
  'merchant_order_no',
  'message_receiving_application',
  'method',
  'notify_url',
  'order_amount',
  'pay_scenario',
  'price_currency',
  'reject_trade_when_terminal_offline',
  'required_terminal_authentication',
  'sign_type',
  'store_no',
  'terminal_sn',
  'timestamp',
  'trans_type',
  'version',
]

function canonicalize(params) {
  const sortedKeys = Object.keys(params).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  return sortedKeys.map((key) => `${key}=${String(params[key])}`).join('&')
}

async function main() {
  const { loadPrivateKey, signUtf8WithForgePkcs1RsaSha256, formatPaycloudRequestSignature } = await import('./payments/signature.js')

  const appId = requiredEnv('PAYCLOUD_APP_ID')
  const merchantNo = requiredEnv('PAYCLOUD_MERCHANT_NO')
  const storeNo = requiredEnv('PAYCLOUD_STORE_NO')
  requiredEnv('PAYCLOUD_PRIVATE_KEY')

  const paramsForSigning = {
    app_id: String(appId),
    api_version: String('2.0'),
    charset: String('UTF-8'),
    description: String('FlashTap Terminal Test'),
    expires: 300,
    format: String('JSON'),
    message_receiving_application: String('WISECASHIER'),
    merchant_no: String(merchantNo),
    merchant_order_no: String(`TEST_${Date.now()}`),
    method: String('wisehub.cloud.pay.order'),
    notify_url: String('https://www.flashtap.app/api/webhooks/paycloud'),
    order_amount: Number((1).toFixed(2)),
    pay_scenario: String('SWIPE_CARD'),
    price_currency: String('NAD'),
    reject_trade_when_terminal_offline: 'false',
    required_terminal_authentication: 'false',
    sign_type: String('RSA2'),
    store_no: String(storeNo),
    terminal_sn: String('WPYB002349003019'),
    timestamp: Date.now(),
    trans_type: 1,
    version: String('1.0'),
  }

  const canonicalSource = {}
  for (const key of CANONICAL_KEYS) {
    canonicalSource[key] = paramsForSigning[key]
  }
  const canonicalString = canonicalize(canonicalSource)
  const privateKeyPem = loadPrivateKey()
  const signRaw = signUtf8WithForgePkcs1RsaSha256(canonicalString, privateKeyPem)
  const sign = formatPaycloudRequestSignature(signRaw)
  const payload = {
    ...canonicalSource,
    sign,
  }

  console.log('\n=== CANONICAL STRING (for signing) ===')
  console.log(canonicalString)
  console.log('\n=== FULL REQUEST BODY ===')
  console.log(JSON.stringify(payload, null, 2))

  const response = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })

  const responseText = await response.text()
  let responseJson = null
  try {
    responseJson = JSON.parse(responseText)
  } catch {
    responseJson = null
  }

  console.log('\n=== FINATIC RESPONSE STATUS ===')
  console.log(response.status, response.statusText)
  console.log('\n=== FINATIC RESPONSE BODY (RAW) ===')
  console.log(responseText)
  if (responseJson) {
    console.log('\n=== FINATIC RESPONSE BODY (JSON) ===')
    console.log(JSON.stringify(responseJson, null, 2))
  }
}

main().catch((err) => {
  console.error('\nTEST FAILED:', err?.message || err)
  process.exit(1)
})
