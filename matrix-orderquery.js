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

function signCanonicalWithForge(privatePem, canonical) {
  const prk = forge.pki.privateKeyFromPem(privatePem)
  const md = forge.md.sha256.create()
  md.update(canonical, 'utf8')
  const signByte = prk.sign(md)
  return forge.util.encode64(signByte)
}

function canonicalFromObject(payload) {
  return Object.keys(payload)
    .filter((k) => k !== 'sign')
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .map((k) => `${k}=${payload[k] == null ? '' : String(payload[k])}`)
    .join('&')
}

async function runCase({ endpoint, timestampAsString, includeStoreNo, appId, merchantNo, storeNo, privatePem }) {
  const nowMs = Date.now()
  const merchantOrderNo = `MATRIX-${nowMs}-${Math.floor(Math.random() * 1000)}`
  const tsValue = timestampAsString ? String(nowMs) : nowMs

  const payload = {
    app_id: appId,
    charset: 'UTF-8',
    format: 'JSON',
    merchant_no: merchantNo,
    merchant_order_no: merchantOrderNo,
    method: 'order.query',
    sign_type: 'RSA2',
    timestamp: tsValue,
    version: '1.0',
  }
  if (includeStoreNo) payload.store_no = storeNo

  const canonical = canonicalFromObject(payload)
  const sign = signCanonicalWithForge(privatePem, canonical)
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
    timestampType: timestampAsString ? 'string-ms' : 'number-ms',
    includeStoreNo,
    http: res.status,
    code: json?.code || null,
    msg: json?.msg || text,
    psn: json?.psn || null,
    merchantOrderNo,
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
  const timestampModes = [false, true]
  const storeModes = [false, true]

  const results = []
  for (const endpoint of endpoints) {
    for (const timestampAsString of timestampModes) {
      for (const includeStoreNo of storeModes) {
        try {
          const out = await runCase({
            endpoint,
            timestampAsString,
            includeStoreNo,
            appId,
            merchantNo,
            storeNo,
            privatePem,
          })
          results.push(out)
        } catch (e) {
          results.push({
            endpoint,
            timestampType: timestampAsString ? 'string-ms' : 'number-ms',
            includeStoreNo,
            http: 0,
            code: 'CLIENT_ERR',
            msg: e?.message || String(e),
            psn: null,
            merchantOrderNo: null,
          })
        }
      }
    }
  }

  console.log(JSON.stringify(results, null, 2))
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error))
  process.exitCode = 1
})

