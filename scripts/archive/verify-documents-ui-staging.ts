/**
 * Staging E2E: Documents UI + API walkthrough.
 *   npx tsx scripts/verify-documents-ui-staging.ts
 */
import { chromium } from 'playwright'
import { createClient } from '@supabase/supabase-js'
import { config } from 'dotenv'
import { resolve } from 'path'
import { requireStagingTestPassword } from '../lib/staging/require-staging-test-password'

config({ path: resolve(__dirname, '../.env.test'), override: true })


const STAGING_TEST_PASSWORD = requireStagingTestPassword()

const STAGING_BASE = 'https://flashtap-staging.llosperofficial.workers.dev'
const STAGING_REF = 'mdqjpxwczrhkxkbqatqa'
const RESTAURANT_ID = 'a1999166-ddfa-40d1-ad1f-2f01282a1652'
const OWNER_EMAIL = 'flashtap.staging.test@gmail.com'
const OWNER_PASSWORD = STAGING_TEST_PASSWORD
const KITCHEN_EMAIL = 'staging.kitchen.test@gmail.com'
const KITCHEN_PASSWORD = STAGING_TEST_PASSWORD

const SUPABASE_URL = process.env.SUPABASE_URL || ''
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || ''

if (!SUPABASE_URL.includes(STAGING_REF) || !SERVICE_KEY) {
  throw new Error('Refusing: staging credentials missing (.env.test)')
}

const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
})

const INVOICE = {
  shipName: 'Staging Ship Co',
  glLabel: 'GL Number',
  glValue: '1234',
  billName: 'Staging Bill Org',
  billOrg: 'Bill Holdings Ltd',
  line1: { desc: 'Catering tray A', qty: '3', price: '45.50' },
  line2: { desc: 'Beverage package B', qty: '2', price: '120' },
  dueDate: '2026-08-15',
}

const QUOTE = {
  shipName: 'Quote Ship Site',
  billName: 'Quote Bill Contact',
  billOrg: 'Quote Client Corp',
  line1: { desc: 'Event setup', qty: '1', price: '500' },
  reference: 'Corporate lunch staging test',
}

async function login(page: import('playwright').Page, email: string, password: string) {
  await page.goto(`${STAGING_BASE}/signin`, { waitUntil: 'domcontentloaded' })
  await page.locator('#email').fill(email)
  await page.locator('#password').fill(password)
  await page.getByRole('button', { name: /^sign in$/i }).click()
  await page.waitForURL(/\/(dashboard|settings|menu-management|documents)/, { timeout: 90000 })
}

async function getBillingProfile() {
  const { data, error } = await admin
    .from('restaurant_billing_profiles')
    .select('*')
    .eq('restaurant_id', RESTAURANT_ID)
    .maybeSingle()
  if (error) throw error
  return data
}

async function getDocuments() {
  const { data, error } = await admin
    .from('business_documents')
    .select('*')
    .eq('restaurant_id', RESTAURANT_ID)
    .order('created_at', { ascending: true })
  if (error) throw error
  return data ?? []
}

async function resetTestDocuments() {
  await admin.from('business_documents').delete().eq('restaurant_id', RESTAURANT_ID)
  await admin
    .from('document_sequences')
    .update({ current_number: 0 })
    .eq('restaurant_id', RESTAURANT_ID)
}

async function getSequences() {
  const { data, error } = await admin
    .from('document_sequences')
    .select('*')
    .eq('restaurant_id', RESTAURANT_ID)
  if (error) throw error
  return data ?? []
}

function expectedInvoiceSubtotal() {
  return (
    Number(INVOICE.line1.qty) * Number(INVOICE.line1.price) +
    Number(INVOICE.line2.qty) * Number(INVOICE.line2.price)
  )
}

async function fillInvoiceModal(page: import('playwright').Page) {
  const dialog = page.getByRole('dialog')
  await dialog.getByRole('heading', { name: 'New Invoice' }).waitFor()

  await page.locator('#ship-name').fill(INVOICE.shipName)
  await dialog.getByRole('button', { name: 'Add custom field' }).first().click()
  const labelInputs = dialog.locator('label:has-text("Label")').locator('..').locator('input')
  await labelInputs.first().fill(INVOICE.glLabel)
  const valueInputs = dialog.locator('label:has-text("Value")').locator('..').locator('input')
  await valueInputs.first().fill(INVOICE.glValue)

  await page.locator('#bill-name').fill(INVOICE.billName)
  await page.locator('#bill-organization').fill(INVOICE.billOrg)

  const descInputs = dialog.locator('label:has-text("Description")').locator('..').locator('input')
  const qtyInputs = dialog.locator('label:has-text("Quantity")').locator('..').locator('input')
  const priceInputs = dialog.locator('label:has-text("Unit price")').locator('..').locator('input')
  await descInputs.nth(0).fill(INVOICE.line1.desc)
  await qtyInputs.nth(0).fill(INVOICE.line1.qty)
  await priceInputs.nth(0).fill(INVOICE.line1.price)

  await dialog.getByRole('button', { name: 'Add item' }).click()
  await descInputs.nth(1).fill(INVOICE.line2.desc)
  await qtyInputs.nth(1).fill(INVOICE.line2.qty)
  await priceInputs.nth(1).fill(INVOICE.line2.price)

  await page.locator('#document-due-date').fill(INVOICE.dueDate)

  return dialog
}

async function main() {
  const report: Record<string, unknown> = {
    deployCommit: null as string | null,
    billingProfileBefore: null as unknown,
    sequencesBefore: [] as unknown[],
    checks: {} as Record<string, unknown>,
    createdDocuments: [] as unknown[],
    sequencesAfter: [] as unknown[],
  }

  const versionRes = await fetch(`${STAGING_BASE}/api/version`)
  report.deployCommit = await versionRes.json().then((j) => j.commit).catch(() => null)

  report.billingProfileBefore = await getBillingProfile()
  report.sequencesBefore = await getSequences()
  await resetTestDocuments()

  const browser = await chromium.launch({ headless: true })
  const ownerContext = await browser.newContext()
  const ownerPage = await ownerContext.newPage()

  try {
    await login(ownerPage, OWNER_EMAIL, OWNER_PASSWORD)

    // Check 1: sidebar Documents link
    const sidebarDocs = ownerPage.getByRole('link', { name: 'Documents' })
    await sidebarDocs.waitFor({ timeout: 30000 })
    report.checks.sidebarOwner = { documentsLinkVisible: await sidebarDocs.isVisible() }

    await sidebarDocs.click()
    await ownerPage.waitForURL(/\/documents/, { timeout: 30000 })
    await ownerPage.getByRole('heading', { name: 'Documents' }).waitFor()

    const toastLocator = ownerPage.locator('[role="status"], [data-state="open"]')

    // Check 2: New Invoice + live totals
    await ownerPage.getByRole('button', { name: 'New Invoice' }).click()
    const dialog = await fillInvoiceModal(ownerPage)

    const subtotalText = await dialog.locator('text=Subtotal').locator('..').locator('span').nth(1).innerText()
    const totalText = await dialog.locator('text=Total').locator('..').locator('span').nth(1).innerText()
    const subtotal = Number(subtotalText.replace(/[^\d.]/g, ''))
    const expectedSub = expectedInvoiceSubtotal()
    report.checks.invoicePreview = {
      subtotalText,
      totalText,
      expectedSubtotal: expectedSub,
      subtotalMatches: Math.abs(subtotal - expectedSub) < 0.01,
    }

    // tweak qty to confirm live update
    await dialog.locator('label:has-text("Quantity")').locator('..').locator('input').nth(0).fill('4')
    const subtotalAfter = Number(
      (await dialog.locator('text=Subtotal').locator('..').locator('span').nth(1).innerText()).replace(
        /[^\d.]/g,
        '',
      ),
    )
    report.checks.invoicePreviewLiveUpdate = {
      subtotalAfterQty4: subtotalAfter,
      changed: Math.abs(subtotalAfter - subtotal) > 0.01,
    }

    const vatPreviewText = await dialog
      .locator('text=/^VAT/')
      .locator('..')
      .locator('span')
      .nth(1)
      .innerText()
    const totalPreviewText = await dialog
      .locator('text=Total')
      .locator('..')
      .locator('span')
      .nth(1)
      .innerText()
    const vatPreview = Number(vatPreviewText.replace(/[^\d.]/g, ''))
    const totalPreview = Number(totalPreviewText.replace(/[^\d.]/g, ''))
    report.checks.invoicePreviewVat = {
      vatPreviewText,
      totalPreviewText,
      vatPreview,
      totalPreview,
      expectedVat: 63.3,
      expectedTotal: 485.3,
      vatMatches: Math.abs(vatPreview - 63.3) < 0.01,
      totalMatches: Math.abs(totalPreview - 485.3) < 0.01,
    }

    // Check 3: submit invoice
    const warningPromise = toastLocator
      .filter({ hasText: 'No billing profile is configured' })
      .first()
      .waitFor({ timeout: 12000 })
      .then(() => true)
      .catch(() => false)

    await dialog.getByRole('button', { name: 'Create document' }).click()
    await dialog.waitFor({ state: 'hidden', timeout: 30000 })
    const sawBillingWarning = await warningPromise
    const toastTexts = await ownerPage
      .locator('[data-state="open"]')
      .allInnerTexts()
      .catch(() => [] as string[])
    await ownerPage.getByRole('cell', { name: INVOICE.billName }).waitFor({ timeout: 15000 })
    const invoiceRowText = await ownerPage
      .locator('tbody tr')
      .filter({ hasText: INVOICE.billName })
      .first()
      .innerText()
    report.checks.invoiceSubmit = {
      dialogClosed: true,
      billingWarningToast: sawBillingWarning,
      toastTexts,
      listRowText: invoiceRowText,
    }

    // Check 4/5: New Quote
    await ownerPage.getByRole('button', { name: 'New Quote' }).click()
    const quoteDialog = ownerPage.getByRole('dialog')
    await quoteDialog.getByRole('heading', { name: 'New Quote' }).waitFor()
    await ownerPage.locator('#ship-name').fill(QUOTE.shipName)
    await ownerPage.locator('#bill-name').fill(QUOTE.billName)
    await ownerPage.locator('#bill-organization').fill(QUOTE.billOrg)
    const qDesc = quoteDialog.locator('label:has-text("Description")').locator('..').locator('input')
    const qQty = quoteDialog.locator('label:has-text("Quantity")').locator('..').locator('input')
    const qPrice = quoteDialog.locator('label:has-text("Unit price")').locator('..').locator('input')
    await qDesc.first().fill(QUOTE.line1.desc)
    await qQty.first().fill(QUOTE.line1.qty)
    await qPrice.first().fill(QUOTE.line1.price)
    await ownerPage.locator('#document-reference-note').fill(QUOTE.reference)
    await quoteDialog.getByRole('button', { name: 'Create document' }).click()
    await quoteDialog.waitFor({ state: 'hidden', timeout: 30000 })
    await ownerPage.getByRole('cell', { name: QUOTE.billName }).waitFor({ timeout: 15000 })
    report.checks.quoteSubmit = { dialogClosed: true }

    await ownerContext.close()

    // Kitchen check
    const kitchenContext = await browser.newContext()
    const kitchenPage = await kitchenContext.newPage()
    await login(kitchenPage, KITCHEN_EMAIL, KITCHEN_PASSWORD)
    const kitchenDocsLink = kitchenPage.getByRole('link', { name: 'Documents' })
    report.checks.kitchenSidebar = {
      documentsLinkCount: await kitchenDocsLink.count(),
      documentsLinkVisible: await kitchenDocsLink.isVisible().catch(() => false),
    }
    await kitchenContext.close()
    await browser.close()

    const docs = await getDocuments()
    report.createdDocuments = docs.map((d) => ({
      id: d.id,
      type: d.document_type,
      document_number: d.document_number,
      due_date: d.due_date,
      reference_note: d.reference_note,
      ship_to: d.ship_to,
      bill_to: d.bill_to,
      line_items: d.line_items,
      subtotal: d.subtotal,
      tax_amount: d.tax_amount,
      total: d.total,
      balance: d.balance,
      registration_number: d.registration_number,
      vat_number: d.vat_number,
      bank_name: d.bank_name,
      bank_account_name: d.bank_account_name,
      bank_account_number: d.bank_account_number,
      bank_branch_code: d.bank_branch_code,
      restaurant_name: d.restaurant_name,
      restaurant_address: d.restaurant_address,
    }))
    report.sequencesAfter = await getSequences()

    const billing = report.billingProfileBefore as Record<string, string> | null
    if (billing) {
      const invoice = docs.find((d) => d.document_type === 'invoice')
      report.checks.billingSnapshotMatch = invoice
        ? {
            registration_number: invoice.registration_number === billing.registration_number,
            vat_number: invoice.vat_number === billing.vat_number,
            bank_name: invoice.bank_name === billing.bank_name,
            bank_account_name: invoice.bank_account_name === billing.bank_account_name,
            bank_account_number: invoice.bank_account_number === billing.bank_account_number,
            bank_branch_code: invoice.bank_branch_code === billing.bank_branch_code,
          }
        : null
    }

    console.log(JSON.stringify(report, null, 2))
  } catch (error) {
    await browser.close().catch(() => undefined)
    console.error(error)
    process.exit(1)
  }
}

void main()
