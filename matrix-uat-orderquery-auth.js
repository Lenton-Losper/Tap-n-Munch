import forge from 'node-forge'
import { paycloudWireMerchantOrderNo } from './payments/paycloud.js'

function extractPemBase64Body(raw) {
  return String(raw || '')
    .trim()
    .replace(/\\n/g, '')
    .replace(/\\r/g, '')
    .replace(/-----BEGIN [^-]+-----/g, '')
    .replace(/-----END [^-]+-----/g, '')
    .replace(/\s+/g, '')
}

function buildPkcs1PemFromEnvPrivateKey(rawPrivateKey) {
  const keyBody = extractPemBase64Body(rawPrivateKey)
  const lines = keyBody.match(/.{1,64}/g) || []
  return `-----BEGIN RSA PRIVATE KEY-----\n${lines.join('\n')}\n-----END RSA PRIVATE KEY-----`
}

function toBase64(stdB64) {
  // Standard base64 (no URL-safe conversion).
  return String(stdB64 || '')
}

function signContentSorted(toSignObj, prk) {
  const content = Object.keys(toSignObj)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .map((k) => `${k}=${String(toSignObj[k])}`)
    .join('&')

  const md = forge.md.sha256.create()
  md.update(content, 'utf8')
  const signByte = prk.sign(md)
  const sign = toBase64(forge.util.encode64(signByte))
  return { content, sign }
}

async function attempt({ endpoint, appId, merchantNo, storeNo, prk, timestamp, tradeKeyRequest, methodRequest, methodForSign, includeStoreInSign, signatureMethodKey }) {
  const rawOrderId = `UAT-AUTH-${Date.now()}-${Math.floor(Math.random() * 1000)}`
  // UAT sandbox rejects some merchant_order_no formats (E04111).
  // Use digits-only to satisfy any strict charset/length validation.
  const tradeVal = String(Date.now()).slice(-20)

  const requestPayload = {
    app_id: appId,
    merchant_no: merchantNo,
    store_no: storeNo,
    sign_type: 'RSA2',
    format: 'JSON',
    charset: 'UTF-8',
    version: '1.0',
    method: methodRequest,
    timestamp,
    [tradeKeyRequest]: tradeVal,
  }

  // Build signing object (fields that appear in the signing string).
  // Use the trade key name the request uses.
  const toSign = {
    app_id: appId,
    charset: 'UTF-8',
    format: 'JSON',
    merchant_no: merchantNo,
    [signatureMethodKey]: methodForSign,
    sign_type: 'RSA2',
    version: '1.0',
    timestamp: String(timestamp),
    [tradeKeyRequest]: tradeVal,
  }
  if (includeStoreInSign) toSign.store_no = storeNo

  const { sign } = signContentSorted(toSign, prk)
  requestPayload.sign = sign

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json;charset=UTF-8', Accept: 'application/json' },
    body: JSON.stringify(requestPayload),
  })
  const text = await res.text()
  let json = null
  try {
    json = JSON.parse(text)
  } catch {
    json = null
  }
  return {
    tradeKeyRequest,
    methodRequest,
    methodForSign,
    includeStoreInSign,
    signatureMethodKey,
    http: res.status,
    code: json?.code || null,
    msg: json?.msg || text,
    psn: json?.psn || null,
  }
}

async function main() {
  const endpointBase = String(process.env.PAYCLOUD_ENDPOINT || '').replace(/\/+$/, '')
  const endpoint = `${endpointBase}/orderquery`
  const appId = process.env.PAYCLOUD_APP_ID
  const merchantNo = process.env.PAYCLOUD_MERCHANT_NO
  const storeNo = process.env.PAYCLOUD_STORE_NO
  const rawPrivateKey = process.env.PAYCLOUD_PRIVATE_KEY

  if (!endpointBase || !appId || !merchantNo || !storeNo || !rawPrivateKey) {
    throw new Error('Missing required env vars for UAT matrix')
  }

  const prk = forge.pki.privateKeyFromPem(buildPkcs1PemFromEnvPrivateKey(rawPrivateKey))
  const timestamp = Date.now()

  // Small matrix to find working signing rules.
  const results = []

  const requestTradeKeys = ['out_trade_no', 'merchant_order_no']
  const requestMethods = ['order.query'] // per instruction
  const methodForSignOptions = ['order.query', 'pay.orderquery']
  const includeStoreOptions = [false, true]

  for (const tradeKeyRequest of requestTradeKeys) {
    for (const methodRequest of requestMethods) {
      for (const methodForSign of methodForSignOptions) {
        for (const includeStoreInSign of includeStoreOptions) {
          results.push(
            await attempt({
              endpoint,
              appId,
              merchantNo,
              storeNo,
              prk,
              timestamp,
              tradeKeyRequest,
              methodRequest,
              methodForSign,
              includeStoreInSign,
              signatureMethodKey: 'method',
            })
          )
        }
      }
    }
  }

  // Print best matches first.
  results.sort((a, b) => (a.code === '0' ? -1 : 0) - (b.code === '0' ? -1 : 0))
  console.log(JSON.stringify(results, null, 2))
}

main().catch((e) => {
  console.error(e?.stack || e?.message || String(e))
  process.exitCode = 1
})

