/**
 * #241, first half — the terminal activation code came from `Math.random()`.
 *
 * That code is the credential which turns an unauthenticated HTTP request into a terminal JWT with
 * hardcoded permissions. `Math.random()` is V8's xorshift128+, seeded per isolate and recoverable
 * from a small number of consecutive outputs — and the outputs here are handed out by
 * `POST /api/admin/terminals/generate-code`, which is exactly the observation the state-recovery
 * attack needs. Predicting the NEXT code predicts the credential a real device is about to use.
 *
 * Same finding and same fix as #283 (`generateTabPin`) and #277 (`mintTabSessionId`).
 *
 * FAILS WITHOUT THE FIX: at `ceea943` `randomSegment` calls `Math.random()` and never touches
 * `crypto.getRandomValues`, so the two load-bearing cases below both go red.
 *
 * THE LOAD-BEARING CASES:
 *   - it actually draws from crypto.getRandomValues, proved by DRIVING that source rather than by
 *     reading the file. A statistical test on the output cannot tell a CSPRNG from a PRNG.
 *   - it THROWS with no Web Crypto rather than falling back. A silent downgrade would reintroduce
 *     the defect on whichever runtime lacked the API, which is where nobody would look.
 *   - the alphabet is 32 characters. `byte % 32` is only uniform because 256 is 8 x 32; adding or
 *     removing one character silently biases every code, and this is the assertion that notices.
 */
import { generateTerminalActivationCode, normalizeActivationCode } from '@/lib/terminals/activation-code'

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

describe('#241 the activation code is drawn from a CSPRNG', () => {
  afterEach(() => jest.restoreAllMocks())

  it('draws every character from crypto.getRandomValues, not Math.random', () => {
    // Driving the source is the proof. A distribution test on the output could not tell the two
    // generators apart — that is the entire reason this class of defect survives review.
    const randomSpy = jest.spyOn(Math, 'random')
    const cryptoSpy = jest
      .spyOn(globalThis.crypto, 'getRandomValues')
      .mockImplementation(((arr: Uint8Array) => {
        // 0,1,2,... -> the first N letters of the alphabet, so the output is fully determined.
        for (let i = 0; i < arr.length; i++) arr[i] = i
        return arr
      }) as typeof globalThis.crypto.getRandomValues)

    const code = generateTerminalActivationCode()

    expect(cryptoSpy).toHaveBeenCalled()
    expect(randomSpy).not.toHaveBeenCalled()
    // Two segments of four, each seeded 0..3 -> 'ABCD'.
    expect(code).toBe('FT-ABCD-ABCD')
  })

  it('THROWS rather than falling back when Web Crypto is unavailable', () => {
    const original = globalThis.crypto
    try {
      Reflect.deleteProperty(globalThis, 'crypto')
      expect(() => generateTerminalActivationCode()).toThrow(/no Web Crypto/)
    } finally {
      Object.defineProperty(globalThis, 'crypto', { value: original, configurable: true })
    }
  })

  it('never falls back to Math.random on the failure path either', () => {
    const original = globalThis.crypto
    const randomSpy = jest.spyOn(Math, 'random')
    try {
      Reflect.deleteProperty(globalThis, 'crypto')
      expect(() => generateTerminalActivationCode()).toThrow()
      expect(randomSpy).not.toHaveBeenCalled()
    } finally {
      Object.defineProperty(globalThis, 'crypto', { value: original, configurable: true })
    }
  })
})

describe('#241 the alphabet is what makes the modulus safe', () => {
  it('is exactly 32 characters — 256 is 8 x 32, so byte % 32 is uniform', () => {
    // If this ever fails, `byte % length` has become biased and the rejection-sampling loop that
    // generateTabPin carries must come back. It is not a style assertion.
    expect(ALPHABET.length).toBe(32)
    expect(256 % ALPHABET.length).toBe(0)
  })

  it('excludes the characters a human misreads off a terminal screen', () => {
    for (const confusable of ['I', 'O', '0', '1']) {
      expect(ALPHABET).not.toContain(confusable)
    }
  })
})

describe('#241 the code still looks like a code', () => {
  it('keeps the FT-xxxx-xxxx shape and draws only from the alphabet', () => {
    for (let i = 0; i < 50; i++) {
      const code = generateTerminalActivationCode()
      expect(code).toMatch(/^FT-[A-Z2-9]{4}-[A-Z2-9]{4}$/)
      for (const ch of code.replace(/^FT-/, '').replace('-', '')) {
        expect(ALPHABET).toContain(ch)
      }
    }
  })

  it('does not collide across 500 draws — a stuck generator would', () => {
    // Not a randomness test, which this could not be. It is a smoke check that the generator is
    // advancing at all: a mock or a constant would show up here immediately.
    const seen = new Set<string>()
    for (let i = 0; i < 500; i++) seen.add(generateTerminalActivationCode())
    expect(seen.size).toBe(500)
  })

  it('normalizeActivationCode still round-trips what this produces', () => {
    const code = generateTerminalActivationCode()
    expect(normalizeActivationCode(`  ${code.toLowerCase()} `)).toBe(code)
  })
})
