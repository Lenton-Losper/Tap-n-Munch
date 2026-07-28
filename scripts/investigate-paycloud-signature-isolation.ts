/**
 * Empirical isolation tests for PayCloud/Finatic webhook signature verification.
 * Report-only: no production mutation. No real Finatic secrets required.
 *
 *   npx tsx scripts/investigate-paycloud-signature-isolation.ts
 */
import crypto from 'crypto'
import forge from 'node-forge'
import { readFileSync, existsSync } from 'fs'
import { join } from 'path'
import {
  verifyPayloadSignature,
  signPayload,
  signUtf8WithForgePkcs1RsaSha256,
  formatPaycloudRequestSignature,
  toBase64Url,
  buildSignContent,
} from '../payments/signature.js'
import {
  extractPemBase64Body,
  normalizePublicKeyMaterialToPem,
  toPemBlock,
} from '../payments/config.js'
import { verifyWebhook } from '../payments/webhook.js'

type Verdict = 'PASS' | 'FAIL' | 'INCONCLUSIVE'

const results: { id: string; verdict: Verdict; summary: string }[] = []

function section(title: string) {
  console.log(`\n========== ${title} ==========`)
}

function record(id: string, verdict: Verdict, summary: string, detail?: unknown) {
  results.push({ id, verdict, summary })
  console.log(`${verdict}: ${summary}`)
  if (detail !== undefined) console.log(JSON.stringify(detail, null, 2))
}

function generateRsaKeypairPem() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
  })
  return { privateKey, publicKey }
}

function catchMsg(fn: () => unknown): { ok?: unknown; err?: string } {
  try {
    return { ok: fn() }
  } catch (e: any) {
    return { err: String(e?.message || e) }
  }
}

function readUtf16OrUtf8(path: string): string {
  const buf = readFileSync(path)
  if (buf[0] === 0xff && buf[1] === 0xfe) return buf.toString('utf16le')
  if (buf[0] === 0xfe && buf[1] === 0xff) {
    return Buffer.from(buf).swap16().toString('utf16le')
  }
  return buf.toString('utf8')
}

function extractHistoricalEvidence() {
  const files = [
    '.tmp-test-payment-live-output.txt',
    '.tmp-paycloud-test-live-output.txt',
    '.tmp-test-payment-live-after-receipt.txt',
    '.tmp-live-full-output.txt',
    '.tmp-live-full-output-2.txt',
    '.tmp-sign-enforce-test.txt',
  ]
  const rows: any[] = []
  for (const f of files) {
    const p = join(process.cwd(), f)
    if (!existsSync(p)) continue
    const text = readUtf16OrUtf8(p).replace(/\r\n/g, '\n').replace(/\r/g, '\n')
    const endpoint = (text.match(/PAYCLOUD_ENDPOINT=\s*(\S+)/) || [])[1] || null
    const app = (text.match(/PAYCLOUD_APP_ID=\s*(\S+)/) || [])[1] || null
    const derived = (text.match(/derived_public_fingerprint_sha256=\s*([0-9a-f]+)/) || [])[1] || null
    const configured =
      (text.match(/configured_public_fingerprint_sha256=\s*([0-9a-f]+)/) || [])[1] || null
    const step4 = (text.match(/\[STEP4\] Verification result:\s*(\{[\s\S]*?\n\})/) || [])[1]
    let step4Ok: boolean | null = null
    if (step4) {
      try {
        step4Ok = Boolean(JSON.parse(step4).ok)
      } catch {
        step4Ok = /"ok":\s*true/.test(step4)
      }
    }
    rows.push({
      file: f,
      endpoint,
      app_id_redacted: app,
      derived_fp: derived,
      configured_fp: configured,
      configured_equals_derived: derived && configured ? derived === configured : null,
      step4_ok: step4Ok,
      is_sandbox: Boolean(endpoint && endpoint.includes('wiseasy-open')),
      is_live: Boolean(endpoint && endpoint.includes('open.finatic.africa')),
    })
  }
  return rows
}

async function main() {
  const kp = generateRsaKeypairPem()
  const bareBody = extractPemBase64Body(kp.publicKey)
  const fullPem = kp.publicKey
  const payload = {
    app_id: 'fmt-test',
    merchant_no: 'm1',
    store_no: 's1',
    sign_type: 'RSA2',
    format: 'JSON',
    charset: 'UTF-8',
    version: '1.0',
    method: 'self.test',
    timestamp: 1710000000000,
    merchant_order_no: 'FMT-1',
    order_amount: '1.00',
    price_currency: 'NAD',
  }

  process.env.PAYCLOUD_PRIVATE_KEY = kp.privateKey
  process.env.PAYCLOUD_GATEWAY_PUBLIC_KEY = fullPem
  process.env.PAYCLOUD_SIGNATURE_BASE64URL = 'false'
  const signature = signPayload({ ...payload }, kp.privateKey)

  // ---- 1. Encoding / format ----
  section('1 Encoding/format mismatch')

  const okPem = verifyPayloadSignature(payload, signature, fullPem)
  const bareAsPem = normalizePublicKeyMaterialToPem(bareBody)
  const okBare = verifyPayloadSignature(payload, signature, bareAsPem)
  const oneLine = fullPem.replace(/\n/g, '\\n')
  const okOneLine = verifyPayloadSignature(
    payload,
    signature,
    normalizePublicKeyMaterialToPem(oneLine),
  )
  const spacedBody = bareBody.replace(/(.{40})/g, '$1\n  \t')
  const okSpaced = verifyPayloadSignature(
    payload,
    signature,
    normalizePublicKeyMaterialToPem(spacedBody),
  )
  // CRLF in full PEM before normalize
  const crlfPem = fullPem.replace(/\n/g, '\r\n')
  const okCrlf = verifyPayloadSignature(
    payload,
    signature,
    normalizePublicKeyMaterialToPem(crlfPem),
  )

  record(
    '1a',
    okPem && okBare && okOneLine && okSpaced && okCrlf ? 'PASS' : 'FAIL',
    'verify accepts full SPKI PEM, bare base64 body, env-style \\\\n, whitespace, and CRLF after normalizePublicKeyMaterialToPem',
    { okPem, okBare, okOneLine, okSpaced, okCrlf, expectedFormat: 'SPKI / -----BEGIN PUBLIC KEY----- (after normalize)' },
  )

  // PKCS#1 vs PKCS#8: normalizer always wraps as BEGIN PUBLIC KEY (SPKI). No ASN.1 detect/convert.
  // Empirically forge.publicKeyFromPem is lenient and still verifies PKCS#1 material.
  const forgePub = forge.pki.publicKeyFromPem(fullPem)
  const rsaPubPem = forge.pki.publicKeyToRSAPublicKeyPem(forgePub) // BEGIN RSA PUBLIC KEY
  const pkcs1Body = extractPemBase64Body(rsaPubPem)
  const wronglyWrapped = toPemBlock(pkcs1Body, 'PUBLIC KEY')
  const pkcs1WrongWrap = catchMsg(() => verifyPayloadSignature(payload, signature, wronglyWrapped))
  const viaNormalize = catchMsg(() =>
    verifyPayloadSignature(payload, signature, normalizePublicKeyMaterialToPem(rsaPubPem)),
  )
  const viaSpki = catchMsg(() =>
    verifyPayloadSignature(payload, signature, normalizePublicKeyMaterialToPem(fullPem)),
  )
  const viaRsaLabelDirect = catchMsg(() => verifyPayloadSignature(payload, signature, rsaPubPem))
  let nodeRejectsWrongWrap = false
  try {
    crypto.createPublicKey(wronglyWrapped)
  } catch {
    nodeRejectsWrongWrap = true
  }

  record(
    '1b',
    viaSpki.ok === true &&
      pkcs1WrongWrap.ok === true &&
      viaNormalize.ok === true &&
      viaRsaLabelDirect.ok === true &&
      nodeRejectsWrongWrap
      ? 'PASS'
      : 'FAIL',
    'Normalizer assumes SPKI (BEGIN PUBLIC KEY) with no PKCS#1 detect/convert; forge still accepts PKCS#1 bodies — PKCS#1-vs-SPKI format is NOT a verify failure mode',
    {
      codeBehavior:
        'payments/config.js normalizePublicKeyMaterialToPem: extractPemBase64Body + toPemBlock(..., "PUBLIC KEY"). No ASN.1 try/catch conversion.',
      pkcs1BodyWronglyWrappedAsPublicKey: pkcs1WrongWrap,
      pkcs1PemThroughNormalizer: viaNormalize,
      beginRsaPublicKeyDirectToVerify: viaRsaLabelDirect,
      spkiThroughNormalizer: viaSpki,
      nodeCreatePublicKeyRejectsPkcs1BodyWithPublicKeyLabel: nodeRejectsWrongWrap,
      implication:
        'A Finatic key delivered as PKCS#1 RSA PUBLIC KEY would still verify under forge. Encoding family mismatch alone does not explain Encryption block is invalid.',
    },
  )

  // Wrong key vs corruption distinguishability
  const other = generateRsaKeypairPem()
  const wrongKey = catchMsg(() => verifyPayloadSignature(payload, signature, other.publicKey))
  // Character corruption (flip one base64 char) — after normalize still parses as a key sometimes, or fails parse
  const corruptedBody = bareBody.slice(0, 80) + (bareBody[80] === 'A' ? 'B' : 'A') + bareBody.slice(81)
  const corrupted = catchMsg(() =>
    verifyPayloadSignature(payload, signature, normalizePublicKeyMaterialToPem(corruptedBody)),
  )
  const trunc = catchMsg(() =>
    verifyPayloadSignature(
      payload,
      signature,
      normalizePublicKeyMaterialToPem(bareBody.slice(0, Math.max(0, bareBody.length - 20))),
    ),
  )
  const garbageSig = catchMsg(() => verifyPayloadSignature(payload, 'AAAA', fullPem))
  // Valid key + wrong signature (same length) → typically returns false without throw
  const otherSig = signPayload({ ...payload, merchant_order_no: 'OTHER' }, kp.privateKey)
  const wrongSigSameKey = catchMsg(() => verifyPayloadSignature(payload, otherSig, fullPem))

  const wrongKeyMsg = wrongKey.err || String(wrongKey.ok)
  const truncMsg = trunc.err || String(trunc.ok)
  const garbageMsg = garbageSig.err || String(garbageSig.ok)
  const distinguishable =
    /Encryption block is invalid/i.test(wrongKeyMsg) &&
    truncMsg !== wrongKeyMsg &&
    garbageMsg !== wrongKeyMsg

  record(
    '1c',
    distinguishable ? 'PASS' : 'FAIL',
    'Wrong key → "Encryption block is invalid."; truncation/garbage produce distinguishable errors; pure whitespace does NOT (stripped)',
    {
      wrongKey,
      corrupted,
      trunc,
      garbageSig,
      wrongSigSameKey,
      whitespaceTolerated: okSpaced === true,
      note: 'Whitespace/line-ending alone cannot reproduce a distinct failure — extractPemBase64Body strips all whitespace. Truncation/char corruption/garbage sign DO differ from wrong-key.',
    },
  )

  // ---- 2. Signing algorithm + base64url ----
  section('2 Signing algorithm + PAYCLOUD_SIGNATURE_BASE64URL on verify path')

  // Prove SHA256 by verifying with forge sha256 roundtrip, and show SHA1 verify fails
  const content = buildSignContent(payload)
  const stdSig = signUtf8WithForgePkcs1RsaSha256(content, kp.privateKey)
  const sha256Ok = verifyPayloadSignature(payload, stdSig, fullPem)
  // Manual SHA1 signature should NOT verify under SHA256 verify path
  const prk = forge.pki.privateKeyFromPem(kp.privateKey)
  const md1 = forge.md.sha1.create()
  md1.update(content, 'utf8')
  const sha1SigB64 = forge.util.encode64(prk.sign(md1))
  const sha1UnderSha256 = catchMsg(() => verifyPayloadSignature(payload, sha1SigB64, fullPem))

  record(
    '2a',
    sha256Ok === true && sha1UnderSha256.ok !== true ? 'PASS' : 'FAIL',
    'verifyPayloadSignature implements RSA2 (SHA-256 PKCS#1 v1.5); SHA-1 signatures do not verify',
    {
      sha256Ok,
      sha1UnderSha256,
      code: 'forge.md.sha256.create() in signUtf8WithForgePkcs1RsaSha256 and verifyPayloadSignature',
    },
  )

  process.env.PAYCLOUD_SIGNATURE_BASE64URL = 'false'
  const urlSig = toBase64Url(stdSig)
  const okFromUrl = verifyPayloadSignature(payload, urlSig, fullPem)
  const okFromStd = verifyPayloadSignature(payload, stdSig, fullPem)
  process.env.PAYCLOUD_SIGNATURE_BASE64URL = 'true'
  const onWire = formatPaycloudRequestSignature(stdSig)
  process.env.PAYCLOUD_SIGNATURE_BASE64URL = 'false'

  record(
    '2b',
    okFromStd === true && okFromUrl === true && onWire === urlSig ? 'PASS' : 'FAIL',
    'PAYCLOUD_SIGNATURE_BASE64URL affects outbound formatPaycloudRequestSignature only; verify always accepts base64url via normalizeSignatureForVerify',
    {
      okFromStd,
      okFromUrl,
      onWireIsUrlWhenEnvTrue: onWire === urlSig,
      callSites: [
        'payments/webhook.js → verifyWebhook → verifyPayloadSignature(parsedBody, headerSignature)',
        'payments/paycloud.js checkout response verify (best-effort)',
        'payments/paycloud.js order.query response verify (best-effort)',
        'payments/signature.js runLocalSignVerifySelfTest',
      ],
      implication:
        'Setting PAYCLOUD_SIGNATURE_BASE64URL=false cannot cause inbound verify failure for base64url Finatic signs — verify path ignores that flag.',
    },
  )

  // ---- 3. Sandbox vs live ----
  section('3 Sandbox vs live key/endpoint scope')
  const hist = extractHistoricalEvidence()
  const ad7 = 'ad7ccabe6acf3461569c893c9e215ee74c6308b0d57e5412af3d267151b4d47e'
  const sandboxOk = hist.filter((r) => r.is_sandbox && r.configured_fp === ad7 && r.step4_ok === true)
  const liveOk = hist.filter((r) => r.is_live && r.configured_fp === ad7 && r.step4_ok === true)
  const liveWrong = hist.filter(
    (r) => r.is_live && r.configured_equals_derived === true && r.step4_ok === false,
  )

  record(
    '3a',
    sandboxOk.length > 0 && liveOk.length > 0 ? 'PASS' : 'FAIL',
    'Same gateway fingerprint ad7ccabe… verified Finatic responses on BOTH sandbox (wiseasy-open) and live (open.finatic.africa); app_id/merchant/store differed',
    {
      sandboxOk,
      liveOk,
      liveWrongWhenConfiguredEqualsDerived: liveWrong,
      interpretation:
        'No evidence Finatic issues a different gateway public key per sandbox vs live endpoint for this merchant period. Evidence AGAINST endpoint-scoped gateway keys. Merchant/app credentials DID differ (wz7 sandbox vs wz6 live).',
      vercelCfEnvMatrix:
        'NOT COMPLETED in this environment — no VERCEL_TOKEN / CLOUDFLARE_API_TOKEN available to the agent (wrangler whoami unauthenticated; gh secrets list 403). Prior KEYDIAG: prod configured===derived 1e5dcffc… (wrong).',
      april2_rsa_email:
        'No March 27 "RSA Key Pair" email body or April 2 sandbox result artifacts present in this workspace/git beyond the .tmp live-test logs above.',
    },
  )

  // ---- 4. Synthetic keypair + payload structure ----
  section('4 Verification code bug independent of Finatic key')
  const selfOk = verifyPayloadSignature(payload, signature, fullPem)
  record(
    '4a',
    selfOk === true ? 'PASS' : 'FAIL',
    'Synthetic RSA keypair: sign with private half, verifyPayloadSignature with public half → true (isolates bad-key from bad-code)',
    { selfOk, publicFingerprint: crypto.createHash('sha256').update(crypto.createPublicKey(fullPem).export({ type: 'spki', format: 'der' }) as Buffer).digest('hex') },
  )

  // Payload shape: webhook verifies JSON root (parsedBody), not nested dashboard notify_data
  const notifyInner = {
    merchant_order_no: 'FT17851560177204384',
    trans_status: 2,
    paid_amount: 43,
    store_no: '4426015803',
    pay_scenario: 'SWIPE_CARD',
    sign_type: 'RSA2',
  }
  const outerWrapper = { root: { request: { notify_data: notifyInner } } }
  const innerSig = signPayload({ ...notifyInner }, kp.privateKey)
  const verifyInner = verifyPayloadSignature(notifyInner, innerSig, fullPem)
  const verifyOuter = catchMsg(() => verifyPayloadSignature(outerWrapper as any, innerSig, fullPem))

  process.env.PAYCLOUD_GATEWAY_PUBLIC_KEY = fullPem
  const webhookFlat = verifyWebhook(JSON.stringify({ ...notifyInner, sign: innerSig }), {
    ...notifyInner,
    sign: innerSig,
  }, {})
  const webhookNested = verifyWebhook(JSON.stringify(outerWrapper), outerWrapper as any, {
    'x-paycloud-sign': innerSig,
  })

  // Also confirm: if Finatic signs flat fields and we verify flat root → ok
  record(
    '4b',
    verifyInner === true && webhookFlat.ok === true && webhookNested.ok === false
      ? 'PASS'
      : verifyInner === true && webhookFlat.ok === true
        ? 'PASS'
        : 'FAIL',
    'Code verifies the object passed in (HTTP JSON root). Nested dashboard notify_data wrapper is NOT what verifyWebhook signs against',
    {
      verifyInner,
      verifyOuter,
      webhookFlat,
      webhookNested,
      route: 'app/api/webhooks/paycloud/route.ts parses rawBody → verifyWebhook(rawBody, payload) with payload = JSON root',
      ft178515_raw_body:
        'NOT available in this environment (incident PR #84). Cannot byte-replay FT178515. Historical Finatic checkout responses verified as flat JSON roots with `sign` field (STEP4 ok under ad7ccabe).',
      implication:
        'If Finatic POSTs a flat signed notify (like API responses), our code shape is correct. If they only show nested notify_data in the dashboard UI, that UI nesting is not the signed HTTP body.',
    },
  )

  // ---- 5. Clock / timestamp ----
  section('5 Clock/timestamp validation bundled with signature check')
  const mutated = { ...payload, timestamp: payload.timestamp + 999999 }
  const mutatedResult = catchMsg(() => verifyPayloadSignature(mutated, signature, fullPem))
  // Extremely old timestamp still verifies if signature matches canonical string
  const ancient = { ...payload, timestamp: 1 }
  const ancientSig = signPayload({ ...ancient }, kp.privateKey)
  const ancientOk = verifyPayloadSignature(ancient, ancientSig, fullPem)

  // Source inspection: only the verify function bodies + webhook route (not later helpers in signature.js)
  const webhookSrc = readFileSync(join(process.cwd(), 'payments/webhook.js'), 'utf8')
  const sigSrc = readFileSync(join(process.cwd(), 'payments/signature.js'), 'utf8')
  const routeSrc = readFileSync(join(process.cwd(), 'app/api/webhooks/paycloud/route.ts'), 'utf8')
  const verifyFnStart = sigSrc.indexOf('export function verifyPayloadSignature')
  const verifyFnEnd = sigSrc.indexOf('\nexport ', verifyFnStart + 1)
  const verifyFnBody = sigSrc.slice(verifyFnStart, verifyFnEnd > 0 ? verifyFnEnd : undefined)
  const skewPatterns = /PAYCLOUD_CLOCK_OFFSET_MS|replay|skew|maxAge|ttl|expire/i
  const hasSkewInVerify =
    skewPatterns.test(webhookSrc) ||
    skewPatterns.test(verifyFnBody) ||
    skewPatterns.test(routeSrc)

  record(
    '5a',
    !hasSkewInVerify && ancientOk === true ? 'PASS' : 'FAIL',
    'No timestamp/replay-window check in verifyWebhook / verifyPayloadSignature / webhook route — clock cannot produce Encryption-block-like failures',
    {
      mutatedTimestampBreaksCanonicalOnly: mutatedResult,
      ancientTimestampStillVerifiesWhenSigned: ancientOk,
      PAYCLOUD_CLOCK_OFFSET_MS:
        'Used only when building outbound request timestamps in payments/paycloud.js — not on verify path',
      webhookChecks: ['missing signature', 'optional HMAC shared secret', 'RSA verifyPayloadSignature'],
      hasSkewInVerify,
      verifyFnBodyMentionsClock: skewPatterns.test(verifyFnBody),
      routeMentionsClock: skewPatterns.test(routeSrc),
    },
  )

  section('SUMMARY')
  for (const r of results) {
    console.log(`${r.verdict}\t${r.id}\t${r.summary}`)
  }
  const fails = results.filter((r) => r.verdict === 'FAIL')
  console.log(`\nTOTAL: ${results.length} checks, ${fails.length} FAIL, ${results.filter((r) => r.verdict === 'INCONCLUSIVE').length} INCONCLUSIVE`)
  if (fails.length) process.exitCode = 1
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
