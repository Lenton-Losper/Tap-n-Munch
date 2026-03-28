import crypto from 'crypto'
import { normalizePrivateKeyEnvToPkcs1Pem } from './payments/config.js'

function main() {
  const privateKeyPem = normalizePrivateKeyEnvToPkcs1Pem()
  console.log('private_key_loaded_ok:', Boolean(privateKeyPem))

  const probe = crypto.randomBytes(32)
  const signer = crypto.createSign('RSA-SHA256')
  signer.update(probe)
  signer.end()
  const signature = signer.sign(privateKeyPem)

  const derivedPublicObj = crypto.createPublicKey(crypto.createPrivateKey(privateKeyPem))
  const derivedPublicPem = derivedPublicObj.export({ type: 'spki', format: 'pem' })

  const verifier = crypto.createVerify('RSA-SHA256')
  verifier.update(probe)
  verifier.end()
  const verifyOk = verifier.verify(derivedPublicPem, signature)

  console.log('verify_signature_with_derived_public_key:', verifyOk)
  const derivedPublicBase64 = String(derivedPublicPem)
    .replace(/-----BEGIN PUBLIC KEY-----/g, '')
    .replace(/-----END PUBLIC KEY-----/g, '')
    .replace(/\s+/g, '')
  console.log('derived_public_key_base64_spki:', derivedPublicBase64)
  console.log('This is the public key to register in the portal')

  if (!verifyOk) {
    console.error('Private key failed sign/self-verify check.')
  }
}

main()
