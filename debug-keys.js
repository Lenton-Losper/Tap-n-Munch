import crypto from 'crypto'
import {
  loadPrivateKey,
  runPaycloudSign123456789DocTest,
  formatPaycloudRequestSignature,
  fromBase64Url,
} from './payments/signature.js'

function normalizePem(raw) {
  const value = String(raw || '')
  return value.replace(/\\n/g, '\n').trim()
}

function ensurePemBlock(value, type) {
  const trimmed = String(value || '').trim()
  if (!trimmed) return ''
  if (trimmed.startsWith('-----BEGIN')) return trimmed
  const compact = trimmed.replace(/\s+/g, '')
  const lines = compact.match(/.{1,64}/g) || []
  return `-----BEGIN ${type}-----\n${lines.join('\n')}\n-----END ${type}-----`
}

function main() {
  const rawPrivate = process.env.PAYCLOUD_PRIVATE_KEY || ''
  console.log('PRIVATE raw length:', rawPrivate.length)
  console.log('PRIVATE contains literal \\\\n:', rawPrivate.includes('\\n'))
  console.log('PRIVATE contains real newlines:', rawPrivate.includes('\n'))

  const normalizedPrivate = normalizePem(rawPrivate)
  console.log('PRIVATE normalized (env) first60:', normalizedPrivate.slice(0, 60))

  const pkcs1PrivatePem = loadPrivateKey()
  console.log('PRIVATE PKCS#1 (for signing) first60:', pkcs1PrivatePem.slice(0, 60))
  console.log('PRIVATE PKCS#1 length:', pkcs1PrivatePem.length)

  let signatureBase64 = ''
  try {
    const signer = crypto.createSign('RSA-SHA256')
    signer.update('test', 'utf8')
    signer.end()
    signatureBase64 = formatPaycloudRequestSignature(signer.sign(pkcs1PrivatePem, 'base64'))
    console.log('SIGN object init:', 'OK')
    console.log('SIGN(test) PKCS#1 RSA-SHA256 on_wire first40:', signatureBase64.slice(0, 40))
  } catch (error) {
    console.log('SIGN object init:', 'FAILED')
    console.log('SIGN error:', error instanceof Error ? error.message : String(error))
  }

  const rawPublic = process.env.PAYCLOUD_PUBLIC_KEY || process.env.PAYCLOUD_GATEWAY_PUBLIC_KEY || ''
  console.log('PUBLIC raw length:', rawPublic.length)
  console.log('PUBLIC source:', process.env.PAYCLOUD_PUBLIC_KEY ? 'PAYCLOUD_PUBLIC_KEY' : 'PAYCLOUD_GATEWAY_PUBLIC_KEY')
  console.log('PUBLIC contains literal \\\\n:', rawPublic.includes('\\n'))
  console.log('PUBLIC contains real newlines:', rawPublic.includes('\n'))

  const normalizedPublic = normalizePem(rawPublic)
  const publicPem = ensurePemBlock(normalizedPublic, 'PUBLIC KEY')
  console.log('PUBLIC normalized length:', publicPem.length)
  console.log('PUBLIC normalized first60:', publicPem.slice(0, 60))
  console.log('PUBLIC normalized full:')
  console.log(publicPem)

  const publicFingerprint = crypto
    .createHash('sha256')
    .update(crypto.createPublicKey(publicPem).export({ type: 'spki', format: 'der' }))
    .digest('hex')
  const derivedPublicFromPrivateDer = crypto
    .createPublicKey(crypto.createPrivateKey(pkcs1PrivatePem))
    .export({ type: 'spki', format: 'der' })
  const derivedPublicFingerprint = crypto.createHash('sha256').update(derivedPublicFromPrivateDer).digest('hex')
  console.log('PUBLIC sha256 fingerprint (hex):', publicFingerprint)
  console.log('DERIVED_FROM_PRIVATE public sha256 fingerprint (hex):', derivedPublicFingerprint)

  try {
    if (!signatureBase64) throw new Error('No signature generated, cannot verify')
    const verifier = crypto.createVerify('RSA-SHA256')
    verifier.update('test', 'utf8')
    verifier.end()
    const ok = verifier.verify(publicPem, fromBase64Url(signatureBase64), 'base64')
    if (ok) {
      console.log('KEY PAIR VALID ✅')
    } else {
      console.log('KEY PAIR MISMATCH ❌')
    }
  } catch (error) {
    console.log('KEY PAIR MISMATCH ❌')
    console.log('VERIFY error:', error instanceof Error ? error.message : String(error))
  }

  console.log('')
  runPaycloudSign123456789DocTest(pkcs1PrivatePem)
}

main()
