/**
 * Read-only + safe cron simulation for order #67 sticky-pending decline.
 * - List whether CRON_SECRET exists on the staging Worker (name only)
 * - Query Finatic for FT17852482265916501
 * - Run autoCancelStalePosOrders(verifyWithFinatic) and report skippedUncertainIds
 * - POST cleanup-stale-orders without/with secret from env
 *
 * Trigger: [probe-order67-cron]
 */
import { createClient } from '@supabase/supabase-js'
import { execSync } from 'child_process'
import { autoCancelStalePosOrders } from '../lib/orders/auto-cancel-stale-pos-orders'
import { getRestaurantFinaticCredentials } from '../lib/payments/finatic-restaurant-credentials'
import {
  isFinaticMerchantOrderInvalidError,
  queryFinaticOrderPaid,
} from '../lib/payments/query-finatic-order-paid'

const STAGING_REF = 'mdqjpxwczrhkxkbqatqa'
const ORDER_ID = 'fc059012-2f97-4121-a170-dff1df3ad3a7'
const RESTAURANT_ID = 'a1999166-ddfa-40d1-ad1f-2f01282a1652'
const WORKER_URL = process.env.STAGING_WORKER_URL || 'https://flashtap-staging.llosperofficial.workers.dev'

const url = process.env.SUPABASE_URL || process.env.STAGING_SUPABASE_URL || ''
const key =
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.STAGING_SUPABASE_SERVICE_ROLE_KEY || ''

if (!url.includes(STAGING_REF)) throw new Error('not staging')
if (!key) throw new Error('missing service role')

const admin = createClient(url, key, {
  auth: { autoRefreshToken: false, persistSession: false },
})

function log(label: string, value: unknown) {
  console.log(`\n===== ${label} =====`)
  console.log(JSON.stringify(value, null, 2))
}

async function main() {
  const { data: order, error: orderErr } = await admin.from('orders').select('*').eq('id', ORDER_ID).maybeSingle()
  if (orderErr) throw orderErr
  log('ORDER_67', {
    id: order?.id,
    order_number: order?.order_number,
    total: order?.total,
    status: order?.status,
    payment_status: order?.payment_status,
    cancellation_reason: order?.cancellation_reason,
    cancelled_at: order?.cancelled_at,
    paycloud_merchant_order_no: order?.paycloud_merchant_order_no,
    placed_at: order?.placed_at,
  })

  const { data: audits } = await admin
    .from('audit_logs')
    .select('*')
    .eq('entity_type', 'order')
    .eq('entity_id', ORDER_ID)
    .order('created_at', { ascending: true })
  log('ORDER_67_AUDITS', audits)

  // Worker secret names (not values)
  let secretListRaw = ''
  try {
    secretListRaw = execSync('npx wrangler@3.99.0 secret list', {
      encoding: 'utf8',
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (err: any) {
    secretListRaw = String(err?.stdout || '') + String(err?.stderr || err)
  }
  log('WRANGLER_SECRET_LIST_RAW', secretListRaw)
  const hasCronSecretName = /CRON_SECRET/i.test(secretListRaw)
  log('WORKER_HAS_CRON_SECRET_NAME', {
    hasCronSecretName,
    stagingCronSecretEnvPresent: Boolean(process.env.STAGING_CRON_SECRET || process.env.CRON_SECRET),
    stagingCronSecretEnvLength: String(process.env.STAGING_CRON_SECRET || process.env.CRON_SECRET || '')
      .length,
  })

  // Unauthenticated cron hit
  const noAuth = await fetch(`${WORKER_URL}/api/cron/cleanup-stale-orders`, { method: 'POST' })
  const noAuthBody = await noAuth.text()
  log('CRON_HTTP_NO_AUTH', { status: noAuth.status, body: noAuthBody.slice(0, 500) })

  const cronSecret = process.env.STAGING_CRON_SECRET || process.env.CRON_SECRET || ''
  if (cronSecret) {
    const withAuth = await fetch(`${WORKER_URL}/api/cron/cleanup-stale-orders`, {
      method: 'POST',
      headers: { 'x-cron-secret': cronSecret },
    })
    const withAuthBody = await withAuth.text()
    log('CRON_HTTP_WITH_SECRET', { status: withAuth.status, body: withAuthBody.slice(0, 2000) })
  } else {
    log('CRON_HTTP_WITH_SECRET', { skipped: true, reason: 'STAGING_CRON_SECRET empty in Actions env' })
  }

  // Direct Finatic probe for this merchant order
  let finaticProbe: unknown = null
  try {
    const creds = await getRestaurantFinaticCredentials(RESTAURANT_ID)
    log('FINATIC_CREDS_PRESENT', {
      merchantNo: creds.merchantNo ? `${String(creds.merchantNo).slice(0, 4)}…` : null,
      storeNo: creds.storeNo ? `${String(creds.storeNo).slice(0, 4)}…` : null,
    })
    try {
      const result = await queryFinaticOrderPaid({
        merchantOrderNo: String(order?.paycloud_merchant_order_no || ''),
        merchantNo: creds.merchantNo,
        storeNo: creds.storeNo,
      })
      finaticProbe = { ok: true, result }
    } catch (err) {
      finaticProbe = {
        ok: false,
        isE04111: isFinaticMerchantOrderInvalidError(err),
        message: err instanceof Error ? err.message : String(err),
        responseBody: (err as any)?.responseBody ?? null,
      }
    }
  } catch (err) {
    finaticProbe = {
      ok: false,
      credsError: err instanceof Error ? err.message : String(err),
    }
  }
  log('FINATIC_ORDER_QUERY_PROBE', finaticProbe)

  // Simulate what the cron would do (does mutate if it decides to cancel — only if Finatic is conclusive).
  // For #67 with attempt_started + E04111, expected: skippedUncertainIds includes order.
  const cancelResult = await autoCancelStalePosOrders(admin as any, {
    restaurantId: RESTAURANT_ID,
    verifyWithFinatic: true,
  })
  log('AUTO_CANCEL_RESULT', cancelResult)
  log('ORDER_67_IN_SKIPPED_UNCERTAIN', {
    inSkipped: cancelResult.skippedUncertainIds.includes(ORDER_ID),
    inCancelled: cancelResult.cancelledIds.includes(ORDER_ID),
    inCorrected: cancelResult.correctedToPaidIds.includes(ORDER_ID),
  })

  const { data: orderAfter } = await admin.from('orders').select('*').eq('id', ORDER_ID).maybeSingle()
  log('ORDER_67_AFTER_AUTO_CANCEL', {
    status: orderAfter?.status,
    payment_status: orderAfter?.payment_status,
    cancellation_reason: orderAfter?.cancellation_reason,
    cancelled_at: orderAfter?.cancelled_at,
  })
}

main().catch((err) => {
  console.error('PROBE_ORDER67_CRON_FAILED', err)
  process.exit(1)
})
