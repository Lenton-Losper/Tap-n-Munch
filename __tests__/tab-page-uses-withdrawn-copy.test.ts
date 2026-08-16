/**
 * #209 -- the call site. `payment-method-withdrawn-copy.test.ts` proves the sentence is right and
 * would stay green with `tab/page.tsx` still hardcoding "Cash ... select Card", because a test
 * bound to a shared rule cannot see whether anything calls it. #232 again.
 */
import fs from 'fs'
import path from 'path'

const PAGE = path.join(process.cwd(), 'app', 'menu', '[restaurantId]', 'tab', 'page.tsx')
const source = fs.readFileSync(PAGE, 'utf8')

describe('#209 -- tab/page.tsx renders the parameterised copy', () => {
  it('the scan found a real file', () => {
    expect(source).toContain('settingsVersion')
  })

  it('calls paymentMethodWithdrawnCopy with the preference it sent', () => {
    expect(source).toContain("from '@/lib/customer-copy/payment-method-withdrawn'")
    expect(source).toContain('description: paymentMethodWithdrawnCopy(paymentPreference)')
  })

  it('the hardcoded cash sentence is gone from the page', () => {
    expect(source).not.toContain('Cash payments are no longer available')
    expect(source).not.toContain('Please select Card')
  })
})
