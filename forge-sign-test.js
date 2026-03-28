import forge from 'node-forge'

function extractPemBase64Body(raw) {
  let s = String(raw || '').trim()
  s = s.replace(/\\n/g, '')
  s = s.replace(/\\r/g, '')
  s = s.replace(/-----BEGIN [^-]+-----/g, '')
  s = s.replace(/-----END [^-]+-----/g, '')
  s = s.replace(/\s+/g, '')
  return s
}

function buildPkcs1PemFromEnvPrivateKey(rawPrivateKey) {
  const keyBody = extractPemBase64Body(rawPrivateKey)
  const lines = keyBody.match(/.{1,64}/g) || []
  return `-----BEGIN RSA PRIVATE KEY-----\n${lines.join('\n')}\n-----END RSA PRIVATE KEY-----`
}

async function main() {
  const rawPrivateKey = process.env.PAYCLOUD_PRIVATE_KEY
  if (!rawPrivateKey) {
    throw new Error('PAYCLOUD_PRIVATE_KEY is missing')
  }

  const endpoint = 'https://open.finatic.africa/api/entry/orderquery'
  const now = Date.now()
  const timestamp = now
  const privKeyStr = buildPkcs1PemFromEnvPrivateKey(rawPrivateKey)
  const prk = forge.pki.privateKeyFromPem(privKeyStr)

  async function runVariant(label, timestampInJsonAsString) {
    const merchantOrderNo = `FORGE-TEST-${label}-${timestamp}`
    const signStr =
      `app_id=wz66363c6bb9592fb5&charset=UTF-8&format=JSON&merchant_no=342600032359&merchant_order_no=${merchantOrderNo}&method=order.query&sign_type=RSA2&store_no=4426012791&timestamp=${timestamp}&version=1.0`

    const md = forge.md.sha256.create()
    md.update(signStr, 'utf8')
    const signByte = prk.sign(md)
    const sign = forge.util.encode64(signByte)

    const body = {
      app_id: 'wz66363c6bb9592fb5',
      charset: 'UTF-8',
      format: 'JSON',
      merchant_no: '342600032359',
      merchant_order_no: merchantOrderNo,
      method: 'order.query',
      sign_type: 'RSA2',
      store_no: '4426012791',
      timestamp: timestampInJsonAsString ? String(timestamp) : timestamp,
      version: '1.0',
      sign,
    }

    console.log(`[FORGE][${label}] endpoint=`, endpoint)
    console.log(`[FORGE][${label}] now_ms=`, now)
    console.log(`[FORGE][${label}] canonical_timestamp_number=`, timestamp)
    console.log(`[FORGE][${label}] json_timestamp_type=`, typeof body.timestamp)
    console.log(`[FORGE][${label}] canonical_string=`, signStr)
    console.log(`[FORGE][${label}] sign_len=`, sign.length)
    console.log(`[FORGE][${label}] request_body=`, JSON.stringify(body, null, 2))

    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json;charset=UTF-8',
        Accept: 'application/json',
      },
      body: JSON.stringify(body),
    })

    const text = await res.text()
    let json = null
    try {
      json = JSON.parse(text)
    } catch {
      json = null
    }

    console.log(`[FORGE][${label}] response_status=`, res.status)
    console.log(
      `[FORGE][${label}] response_headers=`,
      JSON.stringify(Object.fromEntries(res.headers.entries()), null, 2)
    )
    console.log(`[FORGE][${label}] response_body=`, json ?? text)
  }

  await runVariant('json-number-ts', false)
  await runVariant('json-string-ts', true)
}

main().catch((error) => {
  console.error('[FORGE] ERROR:', error?.stack || error?.message || String(error))
  process.exitCode = 1
})
