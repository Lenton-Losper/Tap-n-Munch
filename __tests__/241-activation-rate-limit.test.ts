/**
 * #241 — the activation rate limit.
 *
 * The assertions that carry weight here are about the KEY, not the counting. Cloudflare does the
 * counting; what we can get wrong is what we hand it. Keying on a client-controlled header lets an
 * attacker rotate the key per request and defeat the limit completely while every test that only
 * checked "a limit exists" still passes.
 */
import {
  activationRateLimitKey,
  checkActivationRateLimit,
} from '@/lib/terminals/activation-rate-limit'

const req = (headers: Record<string, string>) =>
  new Request('https://flashtap.app/api/terminals/activate', { method: 'POST', headers })

describe('#241 activation rate limit — the key', () => {
  it('prefers CF-Connecting-IP over x-forwarded-for, because only the first cannot be spoofed', () => {
    const key = activationRateLimitKey(
      req({ 'CF-Connecting-IP': '203.0.113.7', 'x-forwarded-for': '198.51.100.9' }),
    )
    // If this ever returns the x-forwarded-for value, an attacker sets that header per request,
    // gets a fresh bucket every time, and the limit counts to one forever.
    expect(key).toBe('203.0.113.7')
  })

  it('falls back to the LEFT-MOST x-forwarded-for entry when the edge header is absent', () => {
    expect(activationRateLimitKey(req({ 'x-forwarded-for': '198.51.100.9, 10.0.0.1, 10.0.0.2' })))
      .toBe('198.51.100.9')
  })

  it('falls back to x-real-ip last', () => {
    expect(activationRateLimitKey(req({ 'x-real-ip': '192.0.2.44' }))).toBe('192.0.2.44')
  })

  it('gives an unkeyable caller a SHARED key, never a unique one', () => {
    // Two different unkeyable requests must land in the SAME bucket. Handing each one its own
    // key would mean anyone who strips headers gets an unlimited private allowance.
    const a = activationRateLimitKey(req({}))
    const b = activationRateLimitKey(req({ 'user-agent': 'something-else' }))
    expect(a).toBe(b)
    expect(a).toBe('unknown-origin')
  })

  it('ignores a whitespace-only header rather than keying on empty string', () => {
    expect(activationRateLimitKey(req({ 'CF-Connecting-IP': '   ', 'x-real-ip': '192.0.2.44' })))
      .toBe('192.0.2.44')
  })
})

describe('#241 activation rate limit — failing open', () => {
  it('ALLOWS and reports unenforced when no Cloudflare binding is reachable', async () => {
    // This is the jest environment: there is no Workers context. The outcome must be allowed,
    // and it must say so was a default rather than a decision -- a caller that could not tell
    // the difference would log "allowed" all day while nothing was being enforced.
    const outcome = await checkActivationRateLimit(req({ 'CF-Connecting-IP': '203.0.113.7' }))
    expect(outcome.allowed).toBe(true)
    expect(outcome.unenforced).toBe(true)
  })
})
