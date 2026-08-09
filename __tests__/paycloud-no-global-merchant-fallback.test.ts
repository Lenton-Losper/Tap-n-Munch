/**
 * A restaurant with no configured merchant must never transact under the global env merchant.
 *
 * Before this guard, `resolveWireMerchantStore` read
 * `String(input?.merchantNo ?? cfg.merchantNo ?? '')`, where `cfg.merchantNo` is
 * `process.env.PAYCLOUD_MERCHANT_NO`. In production that is 342600032359 — Mingle's OLD merchant
 * number. A venue with a NULL `finatic_merchant_no` therefore did not fail; it silently went out
 * under another venue's former identity.
 *
 * Measured on production 2026-08-08: seven restaurants have a NULL `finatic_merchant_no`. Six are
 * empty test rows. One, Digi Cofee, is real — 20 orders, 8 paid, 15 card. Two of its orders were
 * allocated a merchant order number (#18 and #19, both 2026-07-27) with no gateway response ever
 * recorded, so nothing is known to have completed under the wrong merchant. This guard exists so
 * that stays true.
 *
 * The `??` detail matters and is pinned below: an EMPTY STRING credential already threw, but a
 * NULL one fell through to the global. The database stores NULL, so the silent path was the one
 * real restaurants actually took. A test that only covered '' would have passed before the fix.
 */
import crypto from 'crypto'
import { queryPaymentOrder } from '../payments/paycloud'

const GLOBAL_MERCHANT = '999999000000'
const GLOBAL_STORE = '888888000000'

const RESTAURANT_ID = 'ed8bda2b-beb0-4da7-9531-5b597344e6d5'

/**
 * THROWAWAY keypair, generated once. Never a real credential.
 *
 * Without it the suite dies at `PAYCLOUD_PRIVATE_KEY is required` before ever reaching the
 * merchant resolution — which looks like eight failing tests but is a BROKEN SUITE, not
 * evidence. The first draft of this file had exactly that problem, and taking its red as
 * proof would have shipped a guard with nothing behind it.
 */
const { privateKey: throwawayKey, publicKey: throwawayPublic } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
})
const THROWAWAY_PRIVATE_PEM = throwawayKey.export({ type: 'pkcs1', format: 'pem' }).toString()
const THROWAWAY_PUBLIC_PEM = throwawayPublic.export({ type: 'spki', format: 'pem' }).toString()

let fetchSpy: jest.SpyInstance
let errorSpy: jest.SpyInstance

beforeEach(() => {
  process.env.PAYCLOUD_ENDPOINT = 'https://open.finatic.africa/api/entry'
  process.env.PAYCLOUD_APP_ID = 'wz663test'
  process.env.PAYCLOUD_MERCHANT_NO = GLOBAL_MERCHANT
  process.env.PAYCLOUD_STORE_NO = GLOBAL_STORE
  process.env.PAYCLOUD_PRIVATE_KEY = THROWAWAY_PRIVATE_PEM
  process.env.PAYCLOUD_GATEWAY_PUBLIC_KEY = THROWAWAY_PUBLIC_PEM
  process.env.PAYCLOUD_NOTIFY_URL = 'https://example.invalid/api/webhooks/paycloud'
  process.env.PAYCLOUD_RETURN_URL = 'https://example.invalid/return'

  // Any outbound call is a failure of the guard, so record and neutralise it rather than
  // letting a test reach the network.
  fetchSpy = jest.spyOn(global, 'fetch' as never).mockImplementation((async () => ({
    ok: true,
    status: 200,
    headers: new Headers(),
    text: async () => JSON.stringify({ code: '0', msg: 'ok' }),
  })) as never)
  errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  fetchSpy.mockRestore()
  errorSpy.mockRestore()
})

/** Everything the process tried to send, as one string. */
function outboundBodies(): string {
  return fetchSpy.mock.calls.map((c) => JSON.stringify(c[1] ?? {})).join('\n')
}

describe('a named restaurant with no credentials is refused, not silently rerouted', () => {
  it('NULL credentials do not fall back to the global merchant', async () => {
    await expect(
      queryPaymentOrder({
        orderId: 'FT-TEST-0001',
        restaurantId: RESTAURANT_ID,
        merchantNo: null,
        storeNo: null,
      } as never)
    ).rejects.toThrow(/not set up to take card payments/i)

    // The point of the whole exercise: nothing went to the gateway.
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(outboundBodies()).not.toContain(GLOBAL_MERCHANT)
  })

  it('UNDEFINED credentials do not fall back either', async () => {
    await expect(
      queryPaymentOrder({ orderId: 'FT-TEST-0002', restaurantId: RESTAURANT_ID } as never)
    ).rejects.toThrow(/not set up to take card payments/i)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('EMPTY-STRING credentials are refused with the same message', async () => {
    // These already threw before the fix, but via the generic branch. Pinning them here stops a
    // future refactor quietly routing them somewhere else.
    await expect(
      queryPaymentOrder({
        orderId: 'FT-TEST-0003',
        restaurantId: RESTAURANT_ID,
        merchantNo: '',
        storeNo: '',
      } as never)
    ).rejects.toThrow(/not set up to take card payments/i)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('a half-configured restaurant is refused — store number missing', async () => {
    await expect(
      queryPaymentOrder({
        orderId: 'FT-TEST-0004',
        restaurantId: RESTAURANT_ID,
        merchantNo: '342600160494',
        storeNo: null,
      } as never)
    ).rejects.toThrow(/not set up to take card payments/i)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('the refusal names the restaurant and is readable by a merchant', async () => {
    const err = await queryPaymentOrder({
      orderId: 'FT-TEST-0005',
      restaurantId: RESTAURANT_ID,
      restaurantName: 'Digi Cofee',
    } as never).catch((e: Error) => e)

    const message = String((err as Error).message)
    expect(message).toContain('Digi Cofee')
    expect(message).toMatch(/nothing has been charged/i)
    // Not a stack-trace phrase and not a column name — whoever reads this is at a venue.
    expect(message).not.toMatch(/finatic_merchant_no|undefined|null/)
  })

  it('the refusal is logged at error level with an alertable marker', async () => {
    await queryPaymentOrder({
      orderId: 'FT-TEST-0006',
      restaurantId: RESTAURANT_ID,
      restaurantName: 'Digi Cofee',
    } as never).catch(() => undefined)

    const logged = errorSpy.mock.calls.map((c) => c.join(' ')).join('\n')
    expect(logged).toContain('payment.restaurant_not_configured')
    expect(logged).toContain('"severity":"error"')
    expect(logged).toContain('"requiresAttention":true')
    expect(logged).toContain(RESTAURANT_ID)
  })
})

describe('callers with no restaurant context keep working', () => {
  it('local tools may still use the environment credentials', async () => {
    // The debug query route and reconciliation scripts pass an explicit merchant and no
    // restaurantId. Removing the env path outright would have broken them while making no live
    // payment path safer.
    await expect(
      queryPaymentOrder({ orderId: 'FT-TEST-0007' } as never)
    ).resolves.toBeDefined()
    expect(fetchSpy).toHaveBeenCalled()
    expect(outboundBodies()).toContain(GLOBAL_MERCHANT)
  })

  it('an explicit merchant with no restaurantId is honoured', async () => {
    await expect(
      queryPaymentOrder({
        orderId: 'FT-TEST-0008',
        merchantNo: '342600131153',
        storeNo: '4426015803',
      } as never)
    ).resolves.toBeDefined()
    expect(outboundBodies()).toContain('342600131153')
    expect(outboundBodies()).not.toContain(GLOBAL_MERCHANT)
  })
})
