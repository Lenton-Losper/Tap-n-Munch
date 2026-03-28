import crypto from 'crypto'
import { normalizePrivateKeyEnvToPkcs1Pem } from './payments/config.js'

function main() {
  const privateKeyPem = normalizePrivateKeyEnvToPkcs1Pem()
  const publicPem = crypto
    .createPublicKey(crypto.createPrivateKey(privateKeyPem))
    .export({ type: 'spki', format: 'pem' })

  const base64Body = String(publicPem)
    .replace(/-----BEGIN PUBLIC KEY-----/g, '')
    .replace(/-----END PUBLIC KEY-----/g, '')
    .replace(/\s+/g, '')

  console.log(base64Body)
}

main()
