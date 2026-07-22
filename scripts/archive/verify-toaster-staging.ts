/**
 * Staging verification: Toaster mount + trackInventory-gated ingredient validation.
 *   npx tsx scripts/verify-toaster-staging.ts
 */
import { chromium, type Locator, type Page } from '@playwright/test'
import { createClient } from '@supabase/supabase-js'
import { config } from 'dotenv'
import { resolve } from 'path'
import { requireStagingTestPassword } from '../lib/staging/require-staging-test-password'

config({ path: resolve(__dirname, '../.env.test'), override: true })


const STAGING_TEST_PASSWORD = requireStagingTestPassword()

const BASE_URL = (
  process.env.STAGING_URL ||
  process.env.E2E_BASE_URL ||
  'https://flashtap-staging.llosperofficial.workers.dev'
).replace(/\/$/, '')

const STAGING_RESTAURANT = 'a1999166-ddfa-40d1-ad1f-2f01282a1652'
const TEST_EMAIL = process.env.STAGING_TEST_EMAIL || 'flashtap.staging.test@gmail.com'
const TEST_PASSWORD = STAGING_TEST_PASSWORD
const EXPECTED_COMMIT = process.env.EXPECTED_COMMIT || '52029dc'

const SUPABASE_URL = process.env.SUPABASE_URL || ''
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || ''

if (!SUPABASE_URL.includes('mdqjpxwczrhkxkbqatqa') || !SERVICE_KEY) {
  throw new Error('Refusing: staging Supabase credentials missing (.env.test)')
}

const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
})

type TestResult = { pass: boolean; details: Record<string, unknown> }

async function waitForDeploy() {
  const res = await fetch(`${BASE_URL}/api/version`)
  const body = (await res.json().catch(() => ({}))) as { commit?: string }
  const commit = String(body.commit || '').slice(0, 7)
  if (!commit.startsWith(EXPECTED_COMMIT.slice(0, 7))) {
    throw new Error(`Expected commit ${EXPECTED_COMMIT}, got ${commit || '(missing)'}`)
  }
  return commit
}

async function loginMenuManagement(page: Page) {
  await page.goto(`${BASE_URL}/signin`, { waitUntil: 'domcontentloaded' })
  await page.locator('#email').fill(TEST_EMAIL)
  await page.locator('#password').fill(TEST_PASSWORD)
  await page.getByRole('button', { name: /^sign in$/i }).click()
  await page.waitForURL(/dashboard|menu-management/, { timeout: 60000 })
  await page.goto(`${BASE_URL}/menu-management`, { waitUntil: 'domcontentloaded' })
  await page.getByRole('heading', { name: /menu management/i }).waitFor({ timeout: 60000 })
}

async function openAddItemModal(page: Page) {
  await page.locator('.categories-scroll button').nth(1).waitFor({ state: 'visible', timeout: 30000 })
  await page.locator('.categories-scroll button').nth(1).click()
  await page.getByRole('button', { name: /^add item$/i }).first().click()
  const dialog = page.getByRole('dialog')
  await dialog.getByRole('tab', { name: /^general$/i }).waitFor({ timeout: 15000 })
  return dialog
}

async function getStockNames(): Promise<string[]> {
  const { data, error } = await admin
    .from('stock_items')
    .select('name')
    .eq('restaurant_id', STAGING_RESTAURANT)
    .eq('is_active', true)
    .order('name')
    .limit(20)
  if (error || !data?.length) {
    throw new Error('Need active stock items on staging restaurant')
  }
  return data.map((row) => String(row.name))
}

async function pickIngredient(dialog: Locator, page: Page, rowIndex: number, stockName: string) {
  const row = dialog.locator('div.rounded-xl.border').nth(rowIndex)
  const searchInput = row.getByPlaceholder('Search ingredients...')
  await searchInput.waitFor({ state: 'visible', timeout: 20000 })
  await searchInput.click()
  const query = stockName.slice(0, Math.min(6, stockName.length))
  await searchInput.fill('')
  await page.keyboard.type(query, { delay: 75 })
  const option = row.locator('div.absolute button').first()
  await option.waitFor({ state: 'visible', timeout: 15000 })
  await option.click({ force: true })
}

async function waitForInventoryReady(dialog: Locator) {
  await dialog.getByRole('tab', { name: /^inventory$/i }).click()
  await dialog.getByPlaceholder('Search ingredients...').first().waitFor({ state: 'visible', timeout: 45000 })
}

async function fillBasicItem(dialog: Locator, name: string) {
  await dialog.getByPlaceholder('e.g., Windhoek Lager').fill(name)
  await dialog.getByRole('tab', { name: /^pricing$/i }).click()
  await dialog.getByPlaceholder('25.00').fill('9.99')
  await dialog.getByRole('tab', { name: /^general$/i }).click()
}

async function cleanupMenuItemByName(name: string) {
  const { data: items } = await admin
    .from('menu_items')
    .select('id')
    .eq('restaurant_id', STAGING_RESTAURANT)
    .eq('name', name)
  for (const item of items ?? []) {
    const { data: recipes } = await admin.from('recipes').select('id').eq('menu_item_id', item.id)
    for (const recipe of recipes ?? []) {
      await admin.from('recipe_items').delete().eq('recipe_id', recipe.id)
      await admin.from('recipes').delete().eq('id', recipe.id)
    }
    await admin.from('menu_items').delete().eq('id', item.id)
  }
}

async function test3IncompleteRowBlocksWithToast(stockNames: string[]): Promise<TestResult> {
  const browser = await chromium.launch({ headless: true })
  const page = await browser.newPage()
  const itemName = `Toast Block Test ${Date.now()}`
  try {
    await loginMenuManagement(page)
    const dialog = await openAddItemModal(page)
    await page.waitForTimeout(3000)
    await fillBasicItem(dialog, itemName)

    await dialog.locator('#track-inventory-general').waitFor({ state: 'visible', timeout: 20000 })
    await dialog.locator('#track-inventory-general').click()
    await page.waitForFunction(() => {
      const el = document.querySelector('#track-inventory-general')
      return el?.getAttribute('data-state') === 'checked'
    })

    await waitForInventoryReady(dialog)

    const firstStock = stockNames[0]
    const secondStock = stockNames[1] ?? stockNames[0]
    let usedStockPicker = false
    try {
      await pickIngredient(dialog, page, 0, firstStock)
      await dialog.locator('input[id^="ingredient-qty-"]').first().fill('2')
      await dialog.getByRole('button', { name: /add ingredient/i }).click()
      await pickIngredient(dialog, page, 1, secondStock)
      usedStockPicker = true
    } catch (pickerError) {
      await dialog.locator('input[id^="ingredient-qty-"]').first().fill('2')
    }

    await dialog.getByRole('button', { name: /^create$/i }).click()
    await page.waitForTimeout(2000)

    const validationTitle = page.getByText('Validation Error', { exact: true })
    const incompleteMsg = page.getByText(/ingredient row is incomplete/i)
    const titleVisible = await validationTitle.isVisible()
    const msgVisible = await incompleteMsg.isVisible()
    const modalOpen = await dialog.isVisible()

    const { data: saved } = await admin
      .from('menu_items')
      .select('id')
      .eq('restaurant_id', STAGING_RESTAURANT)
      .eq('name', itemName)

    const pass = titleVisible && msgVisible && modalOpen && (saved ?? []).length === 0
    return {
      pass,
      details: {
        titleVisible,
        msgVisible,
        modalOpen,
        savedCount: (saved ?? []).length,
        usedStockPicker,
        itemName,
        note: usedStockPicker
          ? 'Complete + incomplete ingredient rows via stock picker'
          : 'Stock picker fallback: qty-only partial row',
      },
    }
  } finally {
    await cleanupMenuItemByName(itemName)
    await browser.close()
  }
}

async function testTrackInventoryOffAllowsSave(stockNames: string[]): Promise<TestResult> {
  const browser = await chromium.launch({ headless: true })
  const page = await browser.newPage()
  const itemName = `Track Off Save ${Date.now()}`
  try {
    await loginMenuManagement(page)
    const dialog = await openAddItemModal(page)
    await page.waitForTimeout(3000)
    await fillBasicItem(dialog, itemName)

    // Simulate stray partial row: turn tracking on, pick stock without qty, then turn off
    await dialog.locator('#track-inventory-general').click()
    await page.waitForFunction(() => {
      const el = document.querySelector('#track-inventory-general')
      return el?.getAttribute('data-state') === 'checked'
    })
    await waitForInventoryReady(dialog)
    try {
      await pickIngredient(dialog, page, 0, stockNames[0])
    } catch {
      await dialog.locator('input[id^="ingredient-qty-"]').first().fill('2')
    }

    await dialog.getByRole('tab', { name: /^general$/i }).click()
    await dialog.locator('#track-inventory-general').click()
    await page.waitForFunction(() => {
      const el = document.querySelector('#track-inventory-general')
      return el?.getAttribute('data-state') !== 'checked'
    })
    const trackChecked =
      (await dialog.locator('#track-inventory-general').getAttribute('data-state')) !== 'checked'

    await dialog.getByRole('button', { name: /^create$/i }).click()
    await page.waitForTimeout(4000)

    const successToast = page.getByText('Success', { exact: true })
    const validationError = page.getByText('Validation Error', { exact: true })
    const incompleteMsg = page.getByText(/ingredient row is incomplete/i)

    const { data: saved } = await admin
      .from('menu_items')
      .select('id, name')
      .eq('restaurant_id', STAGING_RESTAURANT)
      .eq('name', itemName)

    const pass =
      trackChecked &&
      (await successToast.isVisible()) &&
      !(await validationError.isVisible()) &&
      !(await incompleteMsg.isVisible()) &&
      (saved ?? []).length === 1

    return {
      pass,
      details: {
        trackChecked,
        successToastVisible: await successToast.isVisible(),
        validationErrorVisible: await validationError.isVisible(),
        incompleteMsgVisible: await incompleteMsg.isVisible(),
        savedCount: (saved ?? []).length,
        itemName,
      },
    }
  } finally {
    await cleanupMenuItemByName(itemName)
    await browser.close()
  }
}

async function testAppWideToastSpotCheck(): Promise<TestResult> {
  const browser = await chromium.launch({ headless: true })
  const page = await browser.newPage()
  try {
    await loginMenuManagement(page)
    const dialog = await openAddItemModal(page)
    await dialog.getByRole('button', { name: /^create$/i }).click()
    await page.waitForTimeout(1500)

    const validationTitle = page.getByText('Validation Error', { exact: true })
    const requiredMsg = page.getByText(/please fill in all required fields/i)
    const toastTitleVisible = await validationTitle.isVisible()
    const requiredMsgVisible = await requiredMsg.isVisible()

    const viewport = page.locator('[data-radix-toast-viewport]').first()
    const viewportVisible = await viewport.isVisible().catch(() => false)

    return {
      pass: toastTitleVisible && requiredMsgVisible,
      details: {
        toastTitleVisible,
        requiredMsgVisible,
        toastSource: 'menu-management required-fields validation (app-wide Toaster)',
        toastViewportVisible: viewportVisible,
      },
    }
  } finally {
    await browser.close()
  }
}

async function main() {
  const deployedCommit = await waitForDeploy()
  console.log(`Deploy confirmed: ${deployedCommit}`)
  const stockNames = await getStockNames()
  console.log(`Stock fixtures: ${stockNames.slice(0, 5).join(', ')}`)

  const results: Record<string, TestResult> = {
    test3_incomplete_row_toast: await test3IncompleteRowBlocksWithToast(stockNames),
    test_track_inventory_off_save: await testTrackInventoryOffAllowsSave(stockNames),
    test_app_wide_toast: await testAppWideToastSpotCheck(),
  }

  console.log(JSON.stringify({ deployedCommit, results }, null, 2))

  const allPass = Object.values(results).every((r) => r.pass)
  if (!allPass) {
    console.error('TOASTER_STAGING_FAIL')
    process.exitCode = 1
  } else {
    console.log('TOASTER_STAGING_OK')
  }
}

main().catch((e) => {
  console.error(e)
  process.exitCode = 1
})
