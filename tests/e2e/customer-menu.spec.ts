import { test, expect } from '@playwright/test'
import { TEST_MENU_URL, TEST_BROWSE_URL, TEST_RESTAURANT_ID } from './constants'

test.describe('Customer menu flow', () => {

  test('menu landing page loads', async ({ page }) => {
    await page.goto(TEST_MENU_URL)
    await expect(page).not.toHaveTitle(/404/)
    // Should show restaurant name or loading state
    await page.waitForLoadState('networkidle')
    const body = await page.textContent('body')
    expect(body).not.toContain('Restaurant Not Found')
  })

  test('browse page loads menu items', async ({ page }) => {
    await page.goto(TEST_BROWSE_URL)
    await page.waitForLoadState('networkidle')
    // Should show at least one menu item or "coming soon"
    const body = await page.textContent('body')
    const hasItems = body?.includes('Test Burger') || body?.includes('coming soon') || body?.includes('Menu')
    expect(hasItems).toBe(true)
  })

  test('public features endpoint returns 200', async ({ request }) => {
    const res = await request.get(
      `/api/menu/${TEST_RESTAURANT_ID}/features`
    )
    expect(res.status()).toBe(200)
    const body = await res.json()
    expect(body).toHaveProperty('features')
  })

  test('menu page has no console errors on load', async ({ page }) => {
    const errors: string[] = []
    page.on('pageerror', err => errors.push(err.message))
    await page.goto(TEST_BROWSE_URL)
    await page.waitForLoadState('networkidle')
    // Filter out known non-critical errors
    const criticalErrors = errors.filter(e =>
      !e.includes('analytics') &&
      !e.includes('insights') &&
      !e.includes('fonts')
    )
    expect(criticalErrors).toHaveLength(0)
  })

})
