import crypto from 'crypto'

// Paste the PayCloud gateway public key here if you prefer fileless setup.
// Environment variable PAYCLOUD_GATEWAY_PUBLIC_KEY takes precedence.
const PAYCLOUD_GATEWAY_PUBLIC_KEY_PLACEHOLDER = `-----BEGIN PUBLIC KEY-----
PASTE_PAYCLOUD_GATEWAY_PUBLIC_KEY_HERE
-----END PUBLIC KEY-----`

function normalizePem(raw) {
  if (!raw) return ''
  const trimmed = String(raw).trim()
  return trimmed.includes('\\n') ? trimmed.replace(/\\n/g, '\n') : trimmed
}

function toPemBlock(base64Body, type) {
  const compact = String(base64Body || '').replace(/\s+/g, '')
  const lines = compact.match(/.{1,64}/g) || []
  return `-----BEGIN ${type}-----\n${lines.join('\n')}\n-----END ${type}-----`
}

export function buildSignContent(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('Signature payload must be an object')
  }

  const keys = Object.keys(payload)
    .filter((key) => {
      if (key === 'sign') return false
      const value = payload[key]
      if (value === null || value === undefined) return false
      if (typeof value === 'string' && value === '') return false
      return true
    })
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))

  return keys
    .map((key) => {
      const value = payload[key]
      const serialized =
        typeof value === 'object' ? JSON.stringify(value) : String(value)
      return `${key}=${serialized}`
    })
    .join('&')
}

export function loadPrivateKey() {
  const inlineKey = normalizePem(process.env.PAYCLOUD_PRIVATE_KEY)
  if (inlineKey) {
    if (inlineKey.includes('BEGIN')) return inlineKey
    return toPemBlock(inlineKey, 'PRIVATE KEY')
  }
  throw new Error('PAYCLOUD_PRIVATE_KEY is required')
}

export function loadGatewayPublicKey() {
  const envKey = normalizePem(process.env.PAYCLOUD_GATEWAY_PUBLIC_KEY)
  if (envKey && !envKey.includes('PASTE_PAYCLOUD_GATEWAY_PUBLIC_KEY_HERE')) {
    if (envKey.includes('BEGIN')) return envKey
    return toPemBlock(envKey, 'PUBLIC KEY')
  }
  return normalizePem(PAYCLOUD_GATEWAY_PUBLIC_KEY_PLACEHOLDER)
}

export function signPayload(payload, privateKey = loadPrivateKey()) {
  const content = buildSignContent(payload)
  const signer = crypto.createSign('RSA-SHA256')
  signer.update(content, 'utf8')
  signer.end()
  return signer.sign(privateKey, 'base64')
}

export function verifyPayloadSignature(payload, signature, publicKey = loadGatewayPublicKey()) {
  if (!signature) return false
  if (!publicKey || publicKey.includes('PASTE_PAYCLOUD_GATEWAY_PUBLIC_KEY_HERE')) {
    throw new Error('PayCloud gateway public key is not configured')
  }

  const content = buildSignContent(payload)
  const verifier = crypto.createVerify('RSA-SHA256')
  verifier.update(content, 'utf8')
  verifier.end()
  return verifier.verify(publicKey, signature, 'base64')
}
