import { test, expect } from '@playwright/test'
import { TEST_KIOSK_URL } from './constants'

test.describe('Kiosk flow', () => {

  test('kiosk page loads name prompt', async ({ page }) => {
    await page.goto(TEST_KIOSK_URL)
    await page.waitForLoadState('networkidle')
    // Should show name input
    await expect(page.getByPlaceholder('Your name')).toBeVisible()
  })

  test('kiosk requires name before proceeding', async ({ page }) => {
    await page.goto(TEST_KIOSK_URL)
    await page.waitForLoadState('networkidle')
    // Start Order button should be disabled with no name
    const button = page.getByRole('button', { name: 'Start Order' })
    await expect(button).toBeDisabled()
  })

  test('kiosk name too short shows error', async ({ page }) => {
    await page.goto(TEST_KIOSK_URL)
    await page.waitForLoadState('networkidle')
    await page.getByPlaceholder('Your name').fill('A')
    await page.getByRole('button', { name: 'Start Order' }).click()
    await expect(page.getByText(/at least 2 characters/i)).toBeVisible()
  })

  test('valid name redirects to browse with kiosk params', async ({ page }) => {
    await page.goto(TEST_KIOSK_URL)
    await page.waitForLoadState('networkidle')
    await page.getByPlaceholder('Your name').fill('TestCustomer')
    await page.getByRole('button', { name: 'Start Order' }).click()
    // Should redirect to browse with kiosk=true and name params
    await page.waitForURL(/browse.*kiosk=true/)
    expect(page.url()).toContain('kiosk=true')
    expect(page.url()).toContain('name=TestCustomer')
  })

})
