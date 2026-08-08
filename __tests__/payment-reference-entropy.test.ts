/**
 * Issue #122(b) — payment references were generated with Math.random().
 *
 * `PAY-<YYYYMMDD>-<8 chars of a 32-char alphabet>`: the date prefix is public, and V8's PRNG
 * (xorshift128+) is not a CSPRNG -- its internal state is recoverable from a modest run of
 * observed outputs, after which past and future draws follow. References are handed to
 * customers on receipts and ride on gateway return URLs, so they are observable in bulk. That
 * made the 40 bits of "randomness" in the suffix worth far less than 40 bits, and the reference
 * is a lookup key for order data.
 *
 * These tests pin the two properties that matter: the draw does not come from Math.random, and
 * the emitted format is byte-for-byte what it always was (see the format test for why).
 */
import { generatePaymentReference } from '@/lib/payment-reference'

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
const FORMAT = /^PAY-\d{8}-[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/

describe('generatePaymentReference', () => {
  afterEach(() => {
    jest.restoreAllMocks()
  })

  it('does not draw from Math.random', () => {
    const spy = jest.spyOn(Math, 'random')
    generatePaymentReference()
    expect(spy).not.toHaveBeenCalled()
  })

  it('still varies when Math.random is pinned to a constant', () => {
    // The sharpest form of the same check: with Math.random frozen, the old generator emitted
    // the identical suffix every time.
    jest.spyOn(Math, 'random').mockReturnValue(0.5)
    const refs = new Set([
      generatePaymentReference(),
      generatePaymentReference(),
      generatePaymentReference(),
    ])
    expect(refs.size).toBe(3)
  })

  it('draws from the Web Crypto global, which is what the Workers runtime provides', () => {
    // Deliberately the global, not node:crypto -- this code runs on Cloudflare Workers, where
    // `crypto` is the Web Crypto API and node's crypto module is only present behind
    // nodejs_compat. lib/terminals/refresh-token.ts and lib/terminal-auth/pin-credentials.ts
    // already call this same global in server code deployed to that worker.
    const spy = jest.spyOn(globalThis.crypto, 'getRandomValues')
    generatePaymentReference()
    expect(spy).toHaveBeenCalled()
  })

  it('keeps the exact PAY-<date>-<8> format', () => {
    // Load-bearing: the column, the receipt layout and every already-issued reference assume
    // this shape. Only the source of randomness changed.
    for (let i = 0; i < 50; i++) {
      expect(generatePaymentReference()).toMatch(FORMAT)
    }
  })

  it('stamps today in UTC as the date prefix', () => {
    const expected = new Date().toISOString().slice(0, 10).replace(/-/g, '')
    expect(generatePaymentReference().slice(4, 12)).toBe(expected)
  })

  it('reaches every symbol in the alphabet', () => {
    // Catches a masking or modulo bug that silently narrows the alphabet -- e.g. `& 15` would
    // still produce well-formed references while halving the keyspace.
    const seen = new Set<string>()
    for (let i = 0; i < 3000; i++) {
      for (const ch of generatePaymentReference().slice(13)) seen.add(ch)
    }
    expect([...seen].sort().join('')).toBe([...ALPHABET].sort().join(''))
  })

  it('does not collide across a large batch', () => {
    const refs = new Set<string>()
    for (let i = 0; i < 5000; i++) refs.add(generatePaymentReference())
    expect(refs.size).toBe(5000)
  })
})
