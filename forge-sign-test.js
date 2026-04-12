import forge from 'node-forge'
import { paycloudWireMerchantOrderNo } from './payments/paycloud.js'

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

  const baseEndpointRaw = process.env.PAYCLOUD_ENDPOINT
  const appId = process.env.PAYCLOUD_APP_ID
  const merchantNo = process.env.PAYCLOUD_MERCHANT_NO
  const storeNo = process.env.PAYCLOUD_STORE_NO
  if (!baseEndpointRaw || !appId || !merchantNo || !storeNo) {
    throw new Error('Missing required UAT env vars: PAYCLOUD_ENDPOINT/PAYCLOUD_APP_ID/PAYCLOUD_MERCHANT_NO/PAYCLOUD_STORE_NO')
  }

  const baseEndpoint = String(baseEndpointRaw).replace(/\/+$/, '')
  const endpoint = `${baseEndpoint}/orderquery`
  const now = Date.now()
  const timestamp = now
  const privKeyStr = buildPkcs1PemFromEnvPrivateKey(rawPrivateKey)
  const prk = forge.pki.privateKeyFromPem(privKeyStr)

  async function runVariant(label, timestampInJsonAsString) {
    const rawMerchantOrderNo = `FORGE-TEST-${label}-${timestamp}`
    const outTradeNo = paycloudWireMerchantOrderNo(rawMerchantOrderNo)

    // PayCloud: build Content_To_Be_Signed using ASCII-sorted `key=value` pairs.
    // For order.query, the signature parameter list (per integration docs) does not include store_no.
    const timestampValue = timestampInJsonAsString ? String(timestamp) : timestamp
    const toSign = {
      app_id: appId,
      // Docs/example signing string uses `method=pay.orderquery` even when UAT request uses `order.query`.
      method: 'pay.orderquery',
      format: 'JSON',
      charset: 'UTF-8',
      sign_type: 'RSA2',
      version: '1.0',
      timestamp: String(timestampValue),
      merchant_no: merchantNo,
      out_trade_no: outTradeNo,
      store_no: storeNo,
    }
    const signContent = Object.keys(toSign)
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
      .map((k) => `${k}=${toSign[k]}`)
      .join('&')

    const md = forge.md.sha256.create()
    md.update(signContent, 'utf8')
    const signByte = prk.sign(md)
    const sign = forge.util.encode64(signByte)

    const body = {
      app_id: appId,
      charset: 'UTF-8',
      format: 'JSON',
      merchant_no: merchantNo,
      out_trade_no: outTradeNo,
      method: 'order.query',
      sign_type: 'RSA2',
      store_no: storeNo,
      timestamp: timestampInJsonAsString ? String(timestamp) : timestamp,
      version: '1.0',
      sign,
    }

    console.log(`[FORGE][${label}] endpoint=`, endpoint)
    console.log(`[FORGE][${label}] now_ms=`, now)
    console.log(`[FORGE][${label}] canonical_timestamp_number=`, timestamp)
    console.log(`[FORGE][${label}] json_timestamp_type=`, typeof body.timestamp)
    console.log(`[FORGE][${label}] canonical_string=`, signContent)
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
