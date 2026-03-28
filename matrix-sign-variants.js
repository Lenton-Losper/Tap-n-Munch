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

function toPkcs1Pem(rawPrivateKey) {
  const body = extractPemBase64Body(rawPrivateKey)
  const lines = body.match(/.{1,64}/g) || []
  return `-----BEGIN RSA PRIVATE KEY-----\n${lines.join('\n')}\n-----END RSA PRIVATE KEY-----`
}

function toBase64Url(b64) {
  return String(b64).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

function canonical(payload, mode) {
  const keys = Object.keys(payload)
    .filter((k) => k !== 'sign')
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  return keys
    .map((k) => {
      const v = payload[k] == null ? '' : String(payload[k])
      if (mode === 'urlencode-values') return `${k}=${encodeURIComponent(v)}`
      return `${k}=${v}`
    })
    .join('&')
}

function forgeSign(privatePem, content, encodingMode) {
  const prk = forge.pki.privateKeyFromPem(privatePem)
  const md = forge.md.sha256.create()
  md.update(content, 'utf8')
  const signByte = prk.sign(md)
  const b64 = forge.util.encode64(signByte)
  return encodingMode === 'base64url' ? toBase64Url(b64) : b64
}

async function runCase(cfg) {
  const {
    endpoint,
    includeStoreNo,
    timestampAsString,
    canonicalMode,
    signEncoding,
    appId,
    merchantNo,
    storeNo,
    privatePem,
  } = cfg
  const now = Date.now()
  const orderNo = `VAR-${now}-${Math.floor(Math.random() * 1000)}`
  const ts = timestampAsString ? String(now) : now
  const body = {
    app_id: appId,
    charset: 'UTF-8',
    format: 'JSON',
    merchant_no: merchantNo,
    merchant_order_no: orderNo,
    method: 'order.query',
    sign_type: 'RSA2',
    timestamp: ts,
    version: '1.0',
  }
  if (includeStoreNo) body.store_no = storeNo
  const signStr = canonical(body, canonicalMode)
  body.sign = forgeSign(privatePem, signStr, signEncoding)

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
    includeStoreNo,
    timestampType: timestampAsString ? 'string-ms' : 'number-ms',
    canonicalMode,
    signEncoding,
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
  const privateRaw = process.env.PAYCLOUD_PRIVATE_KEY
  const base = String(process.env.PAYCLOUD_ENDPOINT || '').replace(/\/+$/, '')
  if (!appId || !merchantNo || !storeNo || !privateRaw || !base) {
    throw new Error('Missing required env vars')
  }

  const privatePem = toPkcs1Pem(privateRaw)
  const endpoints = [base, `${base}/orderquery`]
  const includeStoreNoModes = [false, true]
  const timestampModes = [false, true]
  const canonicalModes = ['raw', 'urlencode-values']
  const signEncodings = ['base64', 'base64url']

  const results = []
  for (const endpoint of endpoints) {
    for (const includeStoreNo of includeStoreNoModes) {
      for (const timestampAsString of timestampModes) {
        for (const canonicalMode of canonicalModes) {
          for (const signEncoding of signEncodings) {
            try {
              results.push(
                await runCase({
                  endpoint,
                  includeStoreNo,
                  timestampAsString,
                  canonicalMode,
                  signEncoding,
                  appId,
                  merchantNo,
                  storeNo,
                  privatePem,
                })
              )
            } catch (e) {
              results.push({
                endpoint,
                includeStoreNo,
                timestampType: timestampAsString ? 'string-ms' : 'number-ms',
                canonicalMode,
                signEncoding,
                http: 0,
                code: 'CLIENT_ERR',
                msg: e?.message || String(e),
                psn: null,
              })
            }
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

