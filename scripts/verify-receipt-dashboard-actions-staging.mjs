/**
 * Playwright UI + real-delivery check for the two new completed-order-card actions:
 * "Email receipt" (real Resend send) and "Print from this computer" (window.print()).
 *   node scripts/verify-receipt-dashboard-actions-staging.mjs
 */
import { chromium } from '@playwright/test'
import { createClient } from '@supabase/supabase-js'
import { config } from 'dotenv'

config({ path: '.env.test', override: true })

const STAGING_TEST_PASSWORD = process.env.STAGING_TEST_PASSWORD?.trim()
if (!STAGING_TEST_PASSWORD) {
  throw new Error('Refusing: STAGING_TEST_PASSWORD is not set (.env.test)')
}

const STAGING =
  process.env.STAGING_APP_URL || 'https://flashtap-staging.llosperofficial.workers.dev'
const RESTA = 'a1999166-ddfa-40d1-ad1f-2f01282a1652'
const OWNER_EMAIL = 'flashtap.staging.test@gmail.com'
const OWNER_PASSWORD = STAGING_TEST_PASSWORD

const url = process.env.SUPABASE_URL
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY

const db = createClient(url, serviceKey, {
  auth: { autoRefreshToken: false, persistSession: false },
})

const tag = `rcpt-ui-${Date.now()}`
const recipientEmail = process.env.RECEIPT_E2E_EMAIL || 'xshadoey@gmail.com'

const created = { orderIds: [] }

async function cleanup() {
  if (created.orderIds.length) {
    const { data: receiptRows } = await db
      .from('receipt_documents')
      .select('id')
      .in('order_id', created.orderIds)
    const receiptIds = (receiptRows ?? []).map((r) => r.id)
    if (receiptIds.length) {
      await db.from('receipt_deliveries').delete().in('receipt_document_id', receiptIds)
    }
    await db.from('receipt_documents').delete().in('order_id', created.orderIds)
    await db.from('payment_events').delete().overlaps('order_ids', created.orderIds)
    await db.from('orders').delete().in('id', created.orderIds)
  }
}

async function seedCompletedOrder() {
  const now = new Date().toISOString()
  const { data: order, error } = await db
    .from('orders')
    .insert({
      restaurant_id: RESTA,
      table_number: 91,
      status: 'completed',
      payment_status: 'paid',
      payment_method: 'card',
      placed_at: now,
      paid_at: now,
      completed_at: now,
      subtotal: 50,
      tax: 7.5,
      total: 57.5,
      items: [{ name: `${tag} Burger`, quantity: 1, price: 50 }],
      channel: 'pos',
    })
    .select('id, order_number')
    .single()
  if (error || !order) throw error ?? new Error('order insert failed')
  created.orderIds.push(order.id)

  const businessOrderNo = `BON-${tag}`
  const { error: saleError } = await db.from('payment_events').insert({
    restaurant_id: RESTA,
    order_ids: [order.id],
    event_type: 'sale',
    business_order_no: businessOrderNo,
    origin_business_order_no: businessOrderNo,
    transaction_id: `TXN${tag}`,
    terminal_id: 'TERM-UI-TEST',
    amount: 57.5,
    currency: 'NAD',
    idempotency_key: businessOrderNo,
    reason_code: 'sale',
  })
  if (saleError) throw saleError

  return order
}

async function signIn(page, email, password) {
  await page.goto(`${STAGING}/signin`)
  await page.getByRole('textbox', { name: /email/i }).fill(email)
  await page.getByRole('textbox', { name: /password/i }).fill(password)
  await page.getByRole('button', { name: /sign in/i }).click()
  await page.waitForURL(/\/dashboard/, { timeout: 20_000 })
  await page.waitForTimeout(4000)
}

function assert(condition, message) {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`)
}

async function main() {
  const order = await seedCompletedOrder()
  const report = {}

  const browser = await chromium.launch({ headless: true })
  const context = await browser.newContext()
  // Stub window.print on every page (including the popup opened for "Print from this
  // computer") so we can detect that it was actually invoked, headless.
  await context.addInitScript(() => {
    window.__printCallCount = 0
    window.print = () => {
      window.__printCallCount += 1
    }
  })
  const page = await context.newPage()

  try {
    await signIn(page, OWNER_EMAIL, OWNER_PASSWORD)

    await page.getByRole('button', { name: /^Completed(\s*\(\d+\))?$/i }).click()
    const card = page.locator('.bg-card', { hasText: `${tag} Burger` }).first()
    await card.waitFor({ state: 'visible', timeout: 20_000 })
    report.cardFound = true

    // --- Email receipt: real Resend send to a real inbox ---
    await card.getByRole('button', { name: /Email receipt/i }).click()
    const emailInput = page.getByPlaceholder('customer@example.com')
    await emailInput.waitFor({ state: 'visible', timeout: 10_000 })
    await emailInput.fill(recipientEmail)

    const emailResponsePromise = page.waitForResponse(
      (res) => res.url().includes(`/api/orders/${order.id}/receipt/email`) && res.request().method() === 'POST',
      { timeout: 20_000 },
    )
    await page.getByRole('button', { name: /Send Receipt/i }).click()
    const emailResponse = await emailResponsePromise
    report.emailSendStatus = emailResponse.status()
    report.emailSendOk = emailResponse.ok()
    await page.waitForTimeout(1500)

    // --- Print from this computer: popup renders receipt HTML + calls window.print() ---
    const popupPromise = context.waitForEvent('page', { timeout: 20_000 })
    await card.getByRole('button', { name: /Print from this computer/i }).click()
    const popup = await popupPromise
    await popup.waitForLoadState('load', { timeout: 20_000 })
    // The popup opens blank ('load' fires immediately); content arrives later via
    // document.write() once the receipt fetch resolves, with no further 'load' event.
    await popup
      .waitForFunction(() => document.body && document.body.innerText.trim().length > 0, {
        timeout: 20_000,
      })
      .catch(() => {})
    await popup.waitForTimeout(1500)

    const popupText = await popup.evaluate(() => document.body?.innerText ?? '')
    report.popupText = popupText.slice(0, 300)
    report.popupHasItem = popupText.includes(`${tag} Burger`)
    report.popupHasTotal = popupText.includes('57.50')
    report.printCallCount = await popup.evaluate(() => window.__printCallCount)

    console.log(JSON.stringify(report, null, 2))

    assert(report.cardFound, 'completed order card should be visible')
    assert(report.emailSendOk, `email send should succeed (status ${report.emailSendStatus})`)
    assert(report.popupHasItem, 'print popup should contain the receipt line item')
    assert(report.popupHasTotal, 'print popup should contain the grand total')
    assert(report.printCallCount >= 1, 'window.print() should have been called in the popup')

    // --- Real DB confirmation: receipt_deliveries row for the EMAIL send, logged correctly ---
    const { data: receipt } = await db
      .from('receipt_documents')
      .select('id, document_number')
      .eq('order_id', order.id)
      .eq('document_type', 'SALE_RECEIPT')
      .single()
    assert(receipt, 'receipt_documents row should exist for the order (issued automatically or on demand)')

    const { data: deliveries } = await db
      .from('receipt_deliveries')
      .select('id, method, status, destination, provider')
      .eq('receipt_document_id', receipt.id)
      .eq('method', 'EMAIL')
      .order('attempt_number', { ascending: false })
      .limit(1)

    assert(deliveries?.length === 1, 'exactly one EMAIL receipt_deliveries row should exist')
    assert(deliveries[0].status === 'sent', `EMAIL delivery status should be sent, got ${deliveries[0].status}`)
    assert(deliveries[0].destination === recipientEmail, 'destination should match the address entered in the modal')
    assert(deliveries[0].provider === 'resend', 'provider should be resend')

    console.log('RECEIPT_DASHBOARD_ACTIONS_STAGING_UI_OK', {
      orderId: order.id,
      orderNumber: order.order_number,
      receiptId: receipt.id,
      documentNumber: receipt.document_number,
      deliveryId: deliveries[0].id,
      recipientEmail,
    })
  } finally {
    await browser.close()
    await cleanup()
  }
}

main().catch(async (error) => {
  console.error('RECEIPT_DASHBOARD_ACTIONS_STAGING_UI_FAIL', error)
  try {
    await cleanup()
  } catch {
    /* ignore */
  }
  process.exit(1)
})
