import forge from 'node-forge'

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

function canonicalFromObject(payload) {
  return Object.keys(payload)
    .filter((k) => k !== 'sign')
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .map((k) => `${k}=${payload[k] == null ? '' : String(payload[k])}`)
    .join('&')
}

function toBase64Url(b64) {
  return String(b64).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function signCanonicalWithForge(privatePem, canonical, encoding) {
  const prk = forge.pki.privateKeyFromPem(privatePem)
  const md = forge.md.sha256.create()
  md.update(canonical, 'utf8')
  const signByte = prk.sign(md)
  const std = forge.util.encode64(signByte)
  if (encoding === 'base64url') return toBase64Url(std)
  return std
}

async function runCase({ endpoint, appId, merchantNo, storeNo, privatePem, method, timestampAsString, includeStoreNo, signEncoding }) {
  const nowMs = Date.now()
  const merchantOrderNo = `MATRIXM-${nowMs}-${Math.floor(Math.random() * 1000)}`
  const tsValue = timestampAsString ? String(nowMs) : nowMs

  const payload = {
    app_id: appId,
    charset: 'UTF-8',
    format: 'JSON',
    merchant_no: merchantNo,
    merchant_order_no: merchantOrderNo,
    method,
    sign_type: 'RSA2',
    timestamp: tsValue,
    version: '1.0',
  }
  if (includeStoreNo) payload.store_no = storeNo

  const canonical = canonicalFromObject(payload)
  const sign = signCanonicalWithForge(privatePem, canonical, signEncoding)
  const body = { ...payload, sign }

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json;charset=UTF-8', Accept: 'application/json' },
    body: JSON.stringify(body),
  })
  const text = await res.text()
  let json = null
  try {
    json = JSON.parse(text)
  } catch {
    json = null
  }

  return {
    endpoint,
    method,
    signEncoding,
    timestampType: timestampAsString ? 'string-ms' : 'number-ms',
    includeStoreNo,
    http: res.status,
    code: json?.code || null,
    msg: json?.msg || text,
    psn: json?.psn || null,
  }
}

async function main() {
  const appId = process.env.PAYCLOUD_APP_ID
  const merchantNo = process.env.PAYCLOUD_MERCHANT_NO
  const storeNo = process.env.PAYCLOUD_STORE_NO
  const rawPrivateKey = process.env.PAYCLOUD_PRIVATE_KEY
  const baseEndpoint = String(process.env.PAYCLOUD_ENDPOINT || '').replace(/\/+$/, '')
  if (!appId || !merchantNo || !storeNo || !rawPrivateKey || !baseEndpoint) {
    throw new Error('Missing required env values')
  }
  const privatePem = buildPkcs1PemFromEnvPrivateKey(rawPrivateKey)

  const endpoints = [baseEndpoint, `${baseEndpoint}/orderquery`]
  const methods = ['order.query', 'pay.orderquery']
  const signEncodings = ['base64', 'base64url']
  const timestampModes = [false, true]
  const storeModes = [false, true]

  const results = []
  for (const endpoint of endpoints) {
    for (const method of methods) {
      for (const signEncoding of signEncodings) {
        for (const timestampAsString of timestampModes) {
          for (const includeStoreNo of storeModes) {
            results.push(
              await runCase({
                endpoint,
                appId,
                merchantNo,
                storeNo,
                privatePem,
                method,
                timestampAsString,
                includeStoreNo,
                signEncoding,
              })
            )
          }
        }
      }
    }
  }

  console.log(JSON.stringify(results, null, 2))
}

main().catch((e) => {
  console.error(e?.stack || e?.message || String(e))
  process.exitCode = 1
})

