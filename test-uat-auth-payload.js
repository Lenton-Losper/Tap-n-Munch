/**
 * Build and (optionally) send a signed PayCloud `order.query` request.
 *
 * Purpose: validate connectivity + credentials against UAT/Sandbox without making a payment.
 *
 * Usage:
 * - Put UAT env values in `.env` (or set them as environment variables).
 * - Run:
 *   node -r dotenv/config --import tsx test-uat-auth-payload.js
 *
 * Env knobs:
 * - PAYCLOUD_UAT_ORDER_ID: order id to use for merchant_order_no (default: UAT-PROBE-<timestamp>)
 * - PAYCLOUD_POST_AUTH_REQUEST: true/false (default: true)
 * - PAYCLOUD_CLOCK_OFFSET_MS: optional clock skew (default 0)
 */

import { getPaycloudConfig, paycloudWireMerchantOrderNo } from './payments/paycloud.js'
import { signPayload } from './payments/signature.js'
import fs from 'fs'
import path from 'path'

function ts() {
  return new Date().toISOString()
}

function buildOrderQueryPayload(cfg, merchantOrderId) {
  const timestamp = Date.now() - Number(process.env.PAYCLOUD_CLOCK_OFFSET_MS || 0)
  const merchant_order_no = paycloudWireMerchantOrderNo(merchantOrderId)

  // Per Finatic/PayCloud UAT probe requirements:
  // - method must be exactly "order.query"
  // - sign must be standard base64 (NOT base64url)
  const prevSigBase64Url = process.env.PAYCLOUD_SIGNATURE_BASE64URL
  process.env.PAYCLOUD_SIGNATURE_BASE64URL = 'false'

  const payload = {
    app_id: cfg.appId,
    merchant_no: cfg.merchantNo,
    store_no: cfg.storeNo,
    sign_type: 'RSA2',
    format: 'JSON',
    charset: 'UTF-8',
    version: '1.0',
    method: 'order.query',
    timestamp,
    merchant_order_no,
  }

  payload.sign = signPayload(payload)
  process.env.PAYCLOUD_SIGNATURE_BASE64URL = prevSigBase64Url
  return payload
}

async function main() {
  console.log(`[${ts()}] [INIT] Loading PayCloud config from env`)
  const cfg = getPaycloudConfig()

  const merchantOrderId = process.env.PAYCLOUD_UAT_ORDER_ID || `UAT-PROBE-${Date.now()}`
  const payload = buildOrderQueryPayload(cfg, merchantOrderId)

  const requestUrl = `${cfg.endpoint.replace(/\/+$/, '')}/orderquery`
  const doPost = String(process.env.PAYCLOUD_POST_AUTH_REQUEST || 'true') === 'true'

  // Persist full payload for copy/paste debugging (includes `sign`, but never includes private key).
  const outPath = path.join(process.cwd(), 'uat-auth-request-payload.json')
  fs.writeFileSync(outPath, JSON.stringify(payload, null, 2), 'utf8')

  console.log(`[${ts()}] [DUMP] Request URL: ${requestUrl}`)
  console.log(`[${ts()}] [DUMP] Request JSON body (includes sign):`)
  console.log(JSON.stringify(payload, null, 2))

  if (!doPost) {
    console.log(`[${ts()}] [DUMP] Skipping POST (PAYCLOUD_POST_AUTH_REQUEST != true)`)
    return
  }

  console.log(`[${ts()}] [POST] Sending POST to ${requestUrl}`)
  const res = await fetch(requestUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json;charset=UTF-8',
      Accept: 'application/json',
    },
    body: JSON.stringify(payload),
  })

  const text = await res.text()
  let json = null
  try {
    json = JSON.parse(text)
  } catch {
    json = null
  }

  console.log(`[${ts()}] [POST] HTTP status: ${res.status}`)
  console.log(`[${ts()}] [POST] Response body: ${json ? JSON.stringify(json, null, 2) : text}`)
}

main().catch((e) => {
  console.error(`[${ts()}] [FATAL]`, e?.stack || e?.message || String(e))
  process.exitCode = 1
})

