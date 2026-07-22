/**
 * Verify all analytics chart sections render for owner on live staging.
 */
import { chromium } from '@playwright/test'
import { config } from 'dotenv'

config({ path: '.env.test', override: true })


const STAGING_TEST_PASSWORD = process.env.STAGING_TEST_PASSWORD?.trim()
if (!STAGING_TEST_PASSWORD) {
  throw new Error('Refusing: STAGING_TEST_PASSWORD is not set (.env.test)')
}

const STAGING = 'https://flashtap-staging.llosperofficial.workers.dev'
const OWNER_EMAIL = 'flashtap.staging.test@gmail.com'
const OWNER_PASSWORD = STAGING_TEST_PASSWORD

const REQUIRED_SECTIONS = [
  'Total Revenue',
  'Sales Over Time',
  'Top Items',
  'Category Breakdown',
  'Peak Hours',
  'Payment Method Split',
]

async function main() {
  const browser = await chromium.launch({ headless: true })
  const page = await browser.newPage()
  try {
    await page.goto(`${STAGING}/signin`)
    await page.getByRole('textbox', { name: /email/i }).fill(OWNER_EMAIL)
    await page.getByRole('textbox', { name: /password/i }).fill(OWNER_PASSWORD)
    await page.getByRole('button', { name: /sign in/i }).click()
    await page.waitForURL(/\/dashboard/, { timeout: 20_000 })
    await page.waitForTimeout(4000)
    const link = page.getByRole('link', { name: /^Analytics$/i })
    await link.waitFor({ state: 'visible', timeout: 10_000 })
    await link.click()
    await page.waitForTimeout(6000)

    const body = (await page.textContent('body')) ?? ''
    const found = {}
    for (const section of REQUIRED_SECTIONS) {
      found[section] = body.includes(section)
    }

    console.log(JSON.stringify({ url: page.url(), sections: found }, null, 2))

    const missing = REQUIRED_SECTIONS.filter((s) => !found[s])
    if (missing.length > 0) {
      console.error('FAIL: missing chart sections:', missing.join(', '))
      process.exit(1)
    }
    console.log('OWNER_CHART_SECTIONS_OK')
  } finally {
    await browser.close()
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
