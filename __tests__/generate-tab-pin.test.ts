/**
 * Binds to lib/tabs/generate-tab-pin.ts (#283, first half).
 *
 * THE TWO ASSERTIONS THAT CARRY THIS FILE:
 *
 *   `never falls back to Math.random` — a silent downgrade would reintroduce the defect on
 *   whichever runtime lacked Web Crypto, invisibly. #277 made the same call for session ids and
 *   for the same reason: failing loudly means somebody sees an error instead of being handed a
 *   guessable credential.
 *
 *   `is uniform over the range` — the whole point of the change is that the distribution is not
 *   exploitable, and `% 9000` over a 16-bit draw is measurably biased toward the low PINs because
 *   65536 is not a multiple of 9000. Rejection sampling is what removes that, and it is the part
 *   an "optimisation" would quietly delete.
 */
import { generateTabPin } from '@/lib/tabs/generate-tab-pin'

describe('generateTabPin — shape', () => {
  it('is always four digits with no leading zero', () => {
    for (let i = 0; i < 500; i++) {
      const pin = generateTabPin()
      expect(pin).toMatch(/^[1-9][0-9]{3}$/)
    }
  })

  it('stays inside the inclusive/exclusive bounds', () => {
    for (let i = 0; i < 500; i++) {
      const n = Number(generateTabPin())
      expect(n).toBeGreaterThanOrEqual(1000)
      expect(n).toBeLessThan(10000)
    }
  })
})

describe('generateTabPin — it is a CSPRNG, and it does not fail open', () => {
  const realCrypto = globalThis.crypto

  afterEach(() => {
    Object.defineProperty(globalThis, 'crypto', { value: realCrypto, configurable: true })
  })

  it('draws from crypto.getRandomValues', () => {
    const spy = jest.fn((arr: Uint16Array) => {
      arr[0] = 1234
      return arr
    })
    Object.defineProperty(globalThis, 'crypto', {
      value: { getRandomValues: spy },
      configurable: true,
    })

    expect(generateTabPin()).toBe(String(1000 + (1234 % 9000)))
    expect(spy).toHaveBeenCalled()
  })

  it('never falls back to Math.random — it throws instead', () => {
    Object.defineProperty(globalThis, 'crypto', { value: {}, configurable: true })
    const mathSpy = jest.spyOn(Math, 'random')

    expect(() => generateTabPin()).toThrow(/Web Crypto/i)
    // The assertion that matters: nothing reached for the weak generator on the way out.
    expect(mathSpy).not.toHaveBeenCalled()
    mathSpy.mockRestore()
  })

  it('rejects the biased tail rather than folding it in', () => {
    // 63000 is the largest multiple of 9000 under 65536. A draw at or above it must be DISCARDED;
    // folding it in with `% 9000` is exactly the bias this test exists to catch.
    const draws = [64000, 63000, 42]
    let i = 0
    Object.defineProperty(globalThis, 'crypto', {
      value: {
        getRandomValues: (arr: Uint16Array) => {
          arr[0] = draws[Math.min(i++, draws.length - 1)]
          return arr
        },
      },
      configurable: true,
    })

    // Both out-of-range draws are thrown away; the PIN comes from the third.
    expect(generateTabPin()).toBe(String(1000 + 42))
    expect(i).toBe(3)
  })
})

describe('generateTabPin — distribution', () => {
  it('is uniform over the range, not clustered at the low end', () => {
    // The `% 9000` bias would over-represent the first 65536 - 63000 = 2536 values by ~50%.
    // A crude split test catches that without being flaky: with 6000 samples the halves should be
    // close, and a 50% skew on the bottom 28% of the range is far outside this tolerance.
    const SAMPLES = 6000
    let low = 0
    for (let i = 0; i < SAMPLES; i++) {
      if (Number(generateTabPin()) < 1000 + 9000 / 2) low++
    }
    const ratio = low / SAMPLES
    expect(ratio).toBeGreaterThan(0.44)
    expect(ratio).toBeLessThan(0.56)
  })
})
