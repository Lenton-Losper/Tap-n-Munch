import { test, expect } from '@playwright/test'
import { STAGING_BASE, TEST_RESTAURANT_ID } from './constants'

test.describe('Auth and protected routes', () => {

  test('dashboard redirects to login when not authenticated', async ({ page }) => {
    await page.goto(`${STAGING_BASE}/dashboard`)
    await page.waitForLoadState('networkidle')
    // Should redirect to sign-in or show login
    const url = page.url()
    const body = await page.textContent('body')
    const isAuthPage = url.includes('sign-in') || url.includes('login') ||
      url.includes('auth') || body?.includes('Sign in') || body?.includes('Log in')
    expect(isAuthPage).toBe(true)
  })

  test('admin console redirects when not authenticated', async ({ page }) => {
    await page.goto(`${STAGING_BASE}/admin/restaurants`)
    await page.waitForLoadState('networkidle')
    const url = page.url()
    const body = await page.textContent('body')
    const isProtected = url.includes('sign-in') || url.includes('login') ||
      body?.includes('Sign in') || body?.includes('Unauthorized')
    expect(isProtected).toBe(true)
  })

  test('platform API rejects unauthenticated requests', async ({ request }) => {
    const res = await request.get(`/api/platform/restaurants`)
    expect([401, 403]).toContain(res.status())
  })

  test('public menu page is accessible without auth', async ({ page }) => {
    await page.goto(`${STAGING_BASE}/menu/${TEST_RESTAURANT_ID}/browse?table=1`)
    await page.waitForLoadState('networkidle')
    // Should NOT redirect to login
    const url = page.url()
    expect(url).not.toContain('sign-in')
    expect(url).not.toContain('login')
  })

})
