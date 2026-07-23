import {
  generateTerminalMerchantOrderNo,
  isPaycloudSafeMerchantOrderNo,
  TERMINAL_MERCHANT_ORDER_NO_MAX_LEN,
} from '@/lib/payments/terminal-merchant-order'

describe('terminal-merchant-order', () => {
  it('generates PayCloud-safe merchant order numbers within length limit', () => {
    const value = generateTerminalMerchantOrderNo(1_784_789_090_022)
    expect(value.startsWith('FT')).toBe(true)
    expect(value.length).toBeLessThanOrEqual(TERMINAL_MERCHANT_ORDER_NO_MAX_LEN)
    expect(isPaycloudSafeMerchantOrderNo(value)).toBe(true)
  })

  it('rejects unsafe merchant order numbers', () => {
    expect(isPaycloudSafeMerchantOrderNo('')).toBe(false)
    expect(isPaycloudSafeMerchantOrderNo('a:b')).toBe(false)
    expect(isPaycloudSafeMerchantOrderNo('x'.repeat(33))).toBe(false)
  })
})
