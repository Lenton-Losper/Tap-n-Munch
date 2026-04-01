import forge from 'node-forge'

const APP_ID = 'wz66363c6bb9592fb5'
const MERCHANT_NO = '342600032359'
const STORE_NO = '4426012791'

// Full private keys shared in chat (complete values only)
const PRIVATE_KEYS = [
  {
    label: 'initial_mcS7q',
    key:
      'MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQCmcS7qDT7H0fgYOlxpk72VVbWXt8fa3bLoAozC50YU8xCIJotoKPuYRAHHjPbaH4s00HEUXW39CrUTZxcTq/iunxX23KlttHmlDqJw3++UticjQARvzMr9vU2l7jdXGTmeWRdsM2JC2TV0vEPlPU2tov0KvdZjAeP/MeTPMUsJ7f101JMQLTOf1AE5YEPDnq9/ayBCINZkV8isAGY97aQ5l1YYssfsqZs/76hqJA1MZnz7kmek7dJuHdwUwwxhet+3+ajXtrb1dGpZt4FTMsOZoefdXkNHC18BxuHq/oZRAs0npJZp/Hy2ZnAEIDZjHP0d33Z2Vk/PVJnPGKfZNPu7AgMBAAECggEAX2cO6g9vhd+/ojuJjualS3zWWsF35+cdzkjv4CPqksWEG1Zkn+6lz/BjSLtvHzXnd/1mY7LuAZXqltWHb7oqEAWV9GslHoHNHCQYTjS9wfLq2hSutlqfm/OvF0ZFKEKIOVB90YJed0zDjEcBb9vEs5tyCX8o7JU/154EthJeHbEEFaZuodbksRrgGuGkHfgOOBUJC/wUosscm9sMfKBHRSoiLwSb99RCZnUvFOzoU+950Rg/M5URRAuYQ0h3fSmrNFP57p+ndfniiv6Xw29ZAi3a8nHPLfN6X16XYuF9tffAOmfwsCqYeInZreu8Fjl0vrLgE61hp3s9mtdPkPg0sQKBgQDgi3GdKng1+t5Kmgkys77vqGM7bNDuiS8x+zkB110SMy5PAY3HDl2CHLCRfh7pPhePDy9I/3XWKPZojqTTjQAZYV6No/geyNoySCCumsOQ5hU6x5pkM5hNeGic4LHhixSqxAyJ1W/Kis1oz/wGJtM7xXFTSxYpxW8xFmMSBeE0eQKBgQC9whTvctbLsQZqRvr9vNxxYS4JJkPRl8LohEe759Sakx0illoeU3Mqi3SI5k8uuOKtV4llkBov0uBzty4WqbAjrm86/wOUo8x2HmgvFPx0DV7G9z44lXqvcBQcsywcwJrLTQrde2obMy4168rDi7DrMcPsnnyUmNMlCSxBoEWc0wKBgB4PzSgjdXCUo4oNUUnucpOXUaG1Ecu9pgnk/l7WvGkhXQPKy3Zo3+/5c1InNnA3lePbPpNhUB9Z4JNi9YI1EFxVgtknqKJGdZ/htC5sHd6aTyFNc8gSeEN26VqHYok1m5C5KoyRfKP7LUDpB26zZ/hKmL90AAWbnyVNP/o7u0jRAoGAOX6huz9vZ342tGLXT6Q2or/QJAONDudNrgfOeFew6jji3gTyPzgHr/9bCtPFcCGixOS+A6Da3lyll0oMU9+MN/N1TknQOuw6Whuyc3mHWF5oth5Zoulfp+JspZmAJyIQhMLOJPds2drzCHFuGTutGkYU2A/ZLWj0qMcTurql/PMCgYEAoMMB8MWvUYfWFjye+dUhKiMDdeUVmWAA041Md9pHZKWARZHk4oc1Wfnxk6to5vEMdj9BVLlvJhKfrs7+ASAU9/Pr83+LTSDjAZLmZ2ifR1duqJyc5bNnBUX/gPZAe3MPatO6HDux1ijMOwyApNAWgXcMpqfSKYDXD3UkJg4LaY4=',
  },
  {
    label: 'new_Ap9US',
    key:
      'MIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQCn1RLWoxbD8mK+3aSzTxzD2n88i7faA6OK0Xqda3Fq/rvoc8HYMIi9sDQGNwGi8ZKKGOQtZolReefynYYeBK9iFFZQb6WhZugaB46DEZzSTJ/p0kJFzPMcbDydWZWVHreCL92iBR1koNJbVFKxeGWMpChvLLt5DFXj5qaisxvon7u0sRg2VtV80O+xhKFFrG1YY3IU3E69pnvgr+7KFhpNH6XBK+PlwpjArM/HXFD0KGfsGinzonCQt38gMxulQGD1fysChDpx3pqAydvHfol/20hjyv2V0OMvdeANupXuY+DbSotTPYnRcsXcSkaK5euGiPNxicYHmilAVqnM89p1AgMBAAECggEAJvqovmrwXaAM6RFnMDH+l0pG5NP6ZksUD6ipVqheliAFmm5QJhrXl162Jn9eBO8gPqybSiQXXnH2ufV18cDazue0SEg16q+Q1oLMyYospvce6Nppg/aevAozZcQpppGUw0rEqd2QPw/O62FBN3Cj/S8fKPr1q55+0EiAiScaI0OdefWhwjrpD58NcUoxa1EykRfT8/XsOgbdH4xYh4piulZHBYcjSwtdI1YDdWjcK786ZVXyAegNM50DS/NWHLvcMxuhGClXEPy86ctUMrOW766jiT37wSDasonM9+yU+hXRPSg3Zamu5v+tK+VqNyt47W47dk6ZVRAVJ1X/9scrHQKBgQDebVFuC/U1t2p0uakAehXX1y02aQ7YMDRDFYOvt8R96kwukgp4inOgzt2SoLNjDHFNtN/kbuY5TvltfdtpcLYF8Vckz30GM4ThyYfofQuHdMauoB5gWHpomWLFwHaFjgM1OsnrlypPZuKKyHRWPO5Z2686WE0xBRo+zDtC6EarjwKBgQDBKjDuCDGzxs+qGxDhrINt5DN5WXWhvoWpdNEe1Ooer70XJtHAWy4AH6Nt3j/RhYDPBqHWHOCxtCynipVrmTOsFW6kq5QXhzrcT/xWUd60jd8DFgta3tbTmhYA/nofGTy9Z6nwSEJPv3jd0vSY/OwUgMRZGq6abl5xUSekGdJnuwKBgQDS6jR6NsqZ2kgPUXJpaltGJdvQqYSTCfq01jTeLlMb103QJ1nYfekxRpgjD1GrjcPvHKHmGicjlri808h4TpG8RuMMm9gBRl8uP40pr1F8bAZu1pSXZa8FetWHkX6SHFz8X7fTN6++RWBym6x9jh+yg7fAirT/08fUXpOfWWSSDwKBgQCZtrFpOiwTG8p1W0R70YRlFou/rWjmZW6IAuXG2zfTY5Xdro6LvANHJeYvsASo/swZ8vUmJaTIxNAkIyv0i92KuyNo9wDKGFrGpv/u0QegNqWZFxnCHkJl8OBBukAEL1kegDfDdj0OqRfNrennNJ3JUw7suUborZuKIUKiW8oLsQKBgEeKEaLRTh/4zRD+uAkufSzT7jCMcLqCdoU/ICSQffvwSI8F/AO5Z/FW/mGf8VybJANI0z3xTI+A7x8fkLYLgPzikpZXgC050AN/h/LMHeMmxjFT8Dko4z39HsRHzRsoHriCa9OjX5BzRI4qmy+CDKeLULu6B0VI1UXx8a+Da9lp',
  },
]

function toPkcs1Pem(raw) {
  const body = String(raw || '').replace(/\s+/g, '')
  const lines = body.match(/.{1,64}/g) || []
  return `-----BEGIN RSA PRIVATE KEY-----\n${lines.join('\n')}\n-----END RSA PRIVATE KEY-----`
}

function canonicalize(payload) {
  return Object.keys(payload)
    .filter((k) => k !== 'sign')
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .map((k) => `${k}=${payload[k] == null ? '' : String(payload[k])}`)
    .join('&')
}

function signWithForge(pkcs1Pem, content) {
  const prk = forge.pki.privateKeyFromPem(pkcs1Pem)
  const md = forge.md.sha256.create()
  md.update(content, 'utf8')
  const signByte = prk.sign(md)
  return forge.util.encode64(signByte)
}

function buildPayload(method, timestampMs, orderNo, includeStoreNo) {
  if (method === 'order.query') {
    const p = {
      app_id: APP_ID,
      merchant_no: MERCHANT_NO,
      sign_type: 'RSA2',
      format: 'JSON',
      charset: 'UTF-8',
      version: '1.0',
      method,
      timestamp: timestampMs,
      merchant_order_no: orderNo,
    }
    if (includeStoreNo) p.store_no = STORE_NO
    return p
  }
  const p = {
    app_id: APP_ID,
    merchant_no: MERCHANT_NO,
    sign_type: 'RSA2',
    format: 'JSON',
    charset: 'UTF-8',
    version: '1.0',
    method,
    timestamp: timestampMs,
    merchant_order_no: orderNo,
    order_amount: '1.00',
    price_currency: 'NAD',
    description: `hunt-${orderNo}`,
    notify_url: 'https://example.com/api/webhooks/paycloud',
    return_url: 'https://example.com/order-confirmation',
    expires: 600,
  }
  if (includeStoreNo) p.store_no = STORE_NO
  return p
}

async function runCase({ keyLabel, keyValue, endpoint, method, includeStoreNo }) {
  const ts = Date.now()
  const orderNo = `HUNT-${keyLabel}-${ts}`
  const payload = buildPayload(method, ts, orderNo, includeStoreNo)
  const canonical = canonicalize(payload)
  const sign = signWithForge(toPkcs1Pem(keyValue), canonical)
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
    keyLabel,
    endpoint,
    method,
    includeStoreNo,
    http: res.status,
    code: json?.code || null,
    msg: json?.msg || text,
    psn: json?.psn || null,
  }
}

async function main() {
  const base = 'https://open.finatic.africa/api/entry'
  const endpoints = [
    base,
    `${base}/checkout`,
    `${base}/hostedcheckout`,
    `${base}/orderquery`,
  ]
  const methods = ['pay.paycloud.checkout', 'checkout', 'hostedcheckout', 'order.query']
  const includeStoreModes = [false, true]

  const out = []
  for (const key of PRIVATE_KEYS) {
    for (const endpoint of endpoints) {
      for (const method of methods) {
        for (const includeStoreNo of includeStoreModes) {
          // Keep some method/endpoint sanity: still try cross combos (that's the point), but skip redundant query body amount noise
          try {
            const r = await runCase({
              keyLabel: key.label,
              keyValue: key.key,
              endpoint,
              method,
              includeStoreNo,
            })
            out.push(r)
          } catch (e) {
            out.push({
              keyLabel: key.label,
              endpoint,
              method,
              includeStoreNo,
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

  console.log(JSON.stringify(out, null, 2))
}

main().catch((e) => {
  console.error(e?.stack || e?.message || String(e))
  process.exitCode = 1
})

