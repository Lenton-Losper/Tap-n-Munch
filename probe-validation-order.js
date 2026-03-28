import forge from 'node-forge'

const BASE = 'https://open.finatic.africa/api/entry'
const APP_ID = process.env.PAYCLOUD_APP_ID || 'wz66363c6bb9592fb5'
const MERCHANT_NO = process.env.PAYCLOUD_MERCHANT_NO || '342600032359'
const STORE_NO = process.env.PAYCLOUD_STORE_NO || '4426012791'
const RAW_PRIVATE = process.env.PAYCLOUD_PRIVATE_KEY || ''

function toPkcs1Pem(raw) {
  const body = String(raw || '')
    .trim()
    .replace(/\\n/g, '')
    .replace(/\\r/g, '')
    .replace(/-----BEGIN [^-]+-----/g, '')
    .replace(/-----END [^-]+-----/g, '')
    .replace(/\s+/g, '')
  const lines = body.match(/.{1,64}/g) || []
  return `-----BEGIN RSA PRIVATE KEY-----\n${lines.join('\n')}\n-----END RSA PRIVATE KEY-----`
}

function canonical(payload) {
  return Object.keys(payload)
    .filter((k) => k !== 'sign')
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .map((k) => `${k}=${payload[k] == null ? '' : String(payload[k])}`)
    .join('&')
}

function sign(payload) {
  const pem = toPkcs1Pem(RAW_PRIVATE)
  const prk = forge.pki.privateKeyFromPem(pem)
  const md = forge.md.sha256.create()
  md.update(canonical(payload), 'utf8')
  return forge.util.encode64(prk.sign(md))
}

async function hit(name, endpoint, payload) {
  const res = await fetch(endpoint, {
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
  return {
    name,
    endpoint,
    method: payload.method,
    app_id: payload.app_id,
    merchant_no: payload.merchant_no,
    store_no: payload.store_no,
    has_sign: Object.prototype.hasOwnProperty.call(payload, 'sign'),
    sign_len: typeof payload.sign === 'string' ? payload.sign.length : null,
    http: res.status,
    code: json?.code || null,
    msg: json?.msg || text,
    psn: json?.psn || null,
  }
}

async function main() {
  const ts = Date.now()
  const basePayload = {
    app_id: APP_ID,
    merchant_no: MERCHANT_NO,
    store_no: STORE_NO,
    sign_type: 'RSA2',
    format: 'JSON',
    charset: 'UTF-8',
    version: '1.0',
    method: 'order.query',
    timestamp: ts,
    merchant_order_no: `PROBE-${ts}`,
  }

  const tests = []

  // Signed "expected" request
  const signed = { ...basePayload, sign: sign(basePayload) }
  tests.push(await hit('signed_valid_fields', `${BASE}/orderquery`, signed))

  // Missing sign
  tests.push(await hit('missing_sign', `${BASE}/orderquery`, { ...basePayload }))

  // Empty sign
  tests.push(await hit('empty_sign', `${BASE}/orderquery`, { ...basePayload, sign: '' }))

  // Garbage sign
  tests.push(await hit('garbage_sign', `${BASE}/orderquery`, { ...basePayload, sign: 'abc123' }))

  // Wrong app id, properly signed for that wrong app id
  const wrongApp = { ...basePayload, app_id: 'wzINVALIDAPPID0000' }
  tests.push(await hit('wrong_app_signed', `${BASE}/orderquery`, { ...wrongApp, sign: sign(wrongApp) }))

  // Wrong merchant, signed
  const wrongMerch = { ...basePayload, merchant_no: '999999999999' }
  tests.push(
    await hit('wrong_merchant_signed', `${BASE}/orderquery`, { ...wrongMerch, sign: sign(wrongMerch) })
  )

  // Wrong store, signed
  const wrongStore = { ...basePayload, store_no: '9999999999' }
  tests.push(await hit('wrong_store_signed', `${BASE}/orderquery`, { ...wrongStore, sign: sign(wrongStore) }))

  // Hosted checkout style probe from support
  const hosted = {
    app_id: APP_ID,
    merchant_no: MERCHANT_NO,
    store_no: STORE_NO,
    sign_type: 'RSA2',
    format: 'JSON',
    charset: 'UTF-8',
    version: '1.0',
    method: 'hostedcheckout',
    timestamp: ts,
    merchant_order_no: `PROBE-H-${ts}`,
    order_amount: '1.00',
    price_currency: 'NAD',
    description: 'probe',
    notify_url: 'https://example.com/api/webhooks/paycloud',
    return_url: 'https://example.com/order-confirmation',
    expires: 600,
  }
  tests.push(await hit('hostedcheckout_on_hosted_path', `${BASE}/hostedcheckout`, { ...hosted, sign: sign(hosted) }))
  tests.push(await hit('hostedcheckout_on_entry_path', `${BASE}`, { ...hosted, sign: sign(hosted) }))

  console.log(JSON.stringify(tests, null, 2))
}

main().catch((e) => {
  console.error(e?.stack || e?.message || String(e))
  process.exitCode = 1
})

