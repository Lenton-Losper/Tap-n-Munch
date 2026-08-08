/**
 * #171 — PayCloud signing material must never reach the logs.
 *
 * From 2026-03-28 until the commit that added this file, `signPayload` logged the canonical
 * signing string verbatim, again as raw hex, and the resulting RSA signature. Together those are
 * a complete, replayable signed request. They became RETAINED rather than discarded on
 * 2026-08-05, when Workers Logs were enabled on production (#155).
 *
 * This suite is hermetic — it generates a throwaway keypair and touches no network and no
 * database — so it is safe to run in the production deploy gate, which is the point. The leak
 * was invisible for four months because nothing asserted on log output.
 *
 * The assertions are deliberately written against what is PRINTED, not against the source. A
 * test that greps the file for `console.log` would pass the day someone reintroduces the value
 * through a helper.
 */
import crypto from 'crypto'
import { signPayload, loggableFingerprint, loadPrivateKey } from '../payments/signature'

/** Throwaway key. Never a real credential. */
function throwawayPkcs1Pem(): string {
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })
  return privateKey.export({ type: 'pkcs1', format: 'pem' }).toString()
}

const PAYLOAD = {
  app_id: 'APPID_TESTVALUE',
  merchant_no: 'MERCHANT_TESTVALUE',
  store_no: 'STORE_TESTVALUE',
  terminal_sn: 'TERMINALSN_TESTVALUE',
  merchant_order_no: 'FTTEST0000000001',
  order_amount: 40.56,
  sign_type: 'RSA2',
  charset: 'UTF-8',
  timestamp: 1754600000,
}

/** Everything signPayload printed, as one blob, plus the signature it returned. */
function capture(): { printed: string; signature: string } {
  const lines: string[] = []
  const spy = jest.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    lines.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '))
  })
  try {
    const signature = signPayload({ ...PAYLOAD }, throwawayPkcs1Pem())
    return { printed: lines.join('\n'), signature }
  } finally {
    spy.mockRestore()
  }
}

/** The canonical string signPayload builds: all fields minus `sign`, sorted, key=value joined. */
function expectedCanonical(): string {
  return Object.keys(PAYLOAD)
    .sort()
    .map((k) => {
      const v = PAYLOAD[k as keyof typeof PAYLOAD]
      // applyPaycloudSigningStrictFields fixes order_amount to 2dp before signing.
      return `${k}=${k === 'order_amount' ? Number(v).toFixed(2) : String(v)}`
    })
    .join('&')
}

describe('#171 PayCloud signing logs carry no replayable material', () => {
  it('never prints the canonical signing string', () => {
    const { printed } = capture()
    expect(printed).not.toContain(expectedCanonical())
  })

  it('never prints the canonical string as hex', () => {
    const { printed } = capture()
    expect(printed).not.toContain(Buffer.from(expectedCanonical(), 'utf8').toString('hex'))
  })

  it('never prints the generated signature', () => {
    const { printed, signature } = capture()
    expect(signature.length).toBeGreaterThan(80) // guard: a real signature, not an empty string
    expect(printed).not.toContain(signature)
  })

  it('never prints private key material, via the real loadPrivateKey path', () => {
    // Must exercise loadPrivateKey() itself. Passing a key into signPayload skips it entirely,
    // and an assertion that never runs the code it names is worth nothing — the first draft of
    // this test passed against the UNFIXED tree for exactly that reason.
    const pem = throwawayPkcs1Pem()
    const prev = process.env.PAYCLOUD_PRIVATE_KEY
    process.env.PAYCLOUD_PRIVATE_KEY = pem
    const lines: string[] = []
    const spy = jest.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      lines.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '))
    })
    try {
      const loaded = loadPrivateKey()
      expect(loaded).toContain('BEGIN RSA PRIVATE KEY') // control: it really did load the key
      const printed = lines.join('\n')
      expect(printed).not.toContain('PRIVATE KEY')
      expect(printed).not.toMatch(/pkcs1_private_key/i)
      expect(printed).not.toContain(pem.slice(32, 60)) // the exact 28 chars #171 was about
    } finally {
      spy.mockRestore()
      if (prev === undefined) delete process.env.PAYCLOUD_PRIVATE_KEY
      else process.env.PAYCLOUD_PRIVATE_KEY = prev
    }
  })

  it('leaks no individual credential value', () => {
    const { printed } = capture()
    // Field NAMES are fine and deliberately kept. Values are not.
    for (const value of ['MERCHANT_TESTVALUE', 'STORE_TESTVALUE', 'TERMINALSN_TESTVALUE']) {
      expect(printed).not.toContain(value)
    }
  })

  it('still emits the diagnostics #107 needed: fingerprint, length, field names', () => {
    const { printed } = capture()
    expect(printed).toMatch(/canonical_string_sha256_8= [0-9a-f]{8}/)
    expect(printed).toMatch(/generated_signature_sha256_8= [0-9a-f]{8}/)
    expect(printed).toMatch(/canonical_string_utf8_bytes= \d+/)
    expect(printed).toContain('included_fields=')
  })

  it('fingerprints the canonical string it actually signed', () => {
    const { printed } = capture()
    // Ties the logged fingerprint to the real canonical string. Without this, the fingerprint
    // could be of anything and the log would be useless for the comparison it exists to support.
    expect(printed).toContain(`canonical_string_sha256_8= ${loggableFingerprint(expectedCanonical())}`)
  })

  it('fingerprints are stable for equal input and differ for unequal input', () => {
    // The whole diagnostic value is "same fingerprint => same string".
    expect(loggableFingerprint('a&b=1')).toBe(loggableFingerprint('a&b=1'))
    expect(loggableFingerprint('a&b=1')).not.toBe(loggableFingerprint('a&b=2'))
    expect(loggableFingerprint('a&b=1')).toMatch(/^[0-9a-f]{8}$/)
  })
})
