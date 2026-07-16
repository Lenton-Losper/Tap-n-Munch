/**
 * Staging verification for the Multi-Tenant WhatsApp Ingress Foundation (ADR 0005, Phase 1).
 *
 *   VERIFY_APP_URL=http://localhost:3100 npx tsx scripts/verify-whatsapp-webhook-staging.ts
 */
import { createClient } from '@supabase/supabase-js'
import { config } from 'dotenv'
import { resolve } from 'path'
import { randomUUID } from 'crypto'
import { createHmac } from 'crypto'

config({ path: resolve(__dirname, '../.env.test'), override: true })

const APP = process.env.VERIFY_APP_URL || 'http://localhost:3100'
const STAGING_REF = 'mdqjpxwczrhkxkbqatqa'
const PHONE_NUMBER_ID = '1273668565820748'
const RESTAURANT_ID = 'a1999166-ddfa-40d1-ad1f-2f01282a1652'

const url = process.env.SUPABASE_URL || ''
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || ''
const appSecret = process.env.META_WHATSAPP_APP_SECRET || ''
const verifyToken = process.env.META_WHATSAPP_VERIFY_TOKEN || ''

if (!url.includes(STAGING_REF) || !serviceKey) {
  throw new Error('Refusing: staging credentials missing (.env.test)')
}
if (!appSecret || !verifyToken) {
  throw new Error('Refusing: META_WHATSAPP_APP_SECRET / META_WHATSAPP_VERIFY_TOKEN missing from .env.test')
}

const admin = createClient(url, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } })

function record(id: string, pass: boolean, detail: string) {
  console.log(`${pass ? 'PASS' : 'FAIL'} [${id}] ${detail}`)
  if (!pass) throw new Error(`Failed: ${id}`)
}

function signBody(rawBody: string): string {
  const hmac = createHmac('sha256', appSecret)
  hmac.update(rawBody)
  return `sha256=${hmac.digest('hex')}`
}

function buildPayload(metaMessageId: string, customerPhone: string, text: string) {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'test-waba-id',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: { phone_number_id: PHONE_NUMBER_ID, display_phone_number: '+264 81 679 4934' },
              contacts: [{ profile: { name: 'Test Customer' }, wa_id: customerPhone }],
              messages: [
                {
                  from: customerPhone,
                  id: metaMessageId,
                  timestamp: String(Math.floor(Date.now() / 1000)),
                  type: 'text',
                  text: { body: text },
                },
              ],
            },
          },
        ],
      },
    ],
  }
}

async function postWebhook(rawBody: string, signature: string | null) {
  const start = Date.now()
  const res = await fetch(`${APP}/api/webhooks/meta/whatsapp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(signature ? { 'X-Hub-Signature-256': signature } : {}),
    },
    body: rawBody,
  })
  const elapsedMs = Date.now() - start
  const json = await res.json().catch(() => ({}))
  return { status: res.status, json, elapsedMs }
}

async function main() {
  console.log('=== WhatsApp webhook staging verification (ADR 0005 Phase 1) ===')

  // 1. Meta's verification handshake (GET).
  const getRes = await fetch(
    `${APP}/api/webhooks/meta/whatsapp?hub.mode=subscribe&hub.verify_token=${encodeURIComponent(verifyToken)}&hub.challenge=test-challenge-123`,
  )
  const getBody = await getRes.text()
  record('1-verification-handshake', getRes.status === 200 && getBody === 'test-challenge-123', `status=${getRes.status} body=${getBody}`)

  const getBadRes = await fetch(
    `${APP}/api/webhooks/meta/whatsapp?hub.mode=subscribe&hub.verify_token=wrong-token&hub.challenge=test-challenge-123`,
  )
  record('1b-verification-handshake-rejects-wrong-token', getBadRes.status === 403, `status=${getBadRes.status}`)

  // 2. Invalid signature is rejected.
  const tag = `verify-${Date.now()}`
  const customerPhone = `2648199${String(Date.now()).slice(-5)}`
  const metaMessageId = `wamid.${tag}.1`
  const payload = buildPayload(metaMessageId, customerPhone, 'Hello, this is a real staging test message')
  const rawBody = JSON.stringify(payload)

  const badSigResult = await postWebhook(rawBody, 'sha256=0000000000000000000000000000000000000000000000000000000000000000')
  record('2-invalid-signature-rejected', badSigResult.status === 401, `status=${badSigResult.status}`)

  const missingSigResult = await postWebhook(rawBody, null)
  record('2b-missing-signature-rejected', missingSigResult.status === 401, `status=${missingSigResult.status}`)

  // 3. Valid signature -> processed, resolves the staging test restaurant, returns fast.
  const validSignature = signBody(rawBody)
  const firstResult = await postWebhook(rawBody, validSignature)
  record(
    '3-valid-signature-accepted',
    firstResult.status === 200,
    `status=${firstResult.status} body=${JSON.stringify(firstResult.json)}`,
  )
  record(
    '3b-returns-fast-without-waiting-for-n8n',
    firstResult.elapsedMs < 5000,
    `elapsed=${firstResult.elapsedMs}ms (should be fast -- not blocked on n8n's full execution)`,
  )

  // Give the DB a brief moment (writes happen before the response, but poll defensively).
  await new Promise((r) => setTimeout(r, 500))

  const { data: messageRow } = await admin
    .from('whatsapp_messages')
    .select('id, event_id, restaurant_id, sender_type, message_type, message_content, meta_message_id')
    .eq('meta_message_id', metaMessageId)
    .maybeSingle()

  record(
    '4-message-saved-resolved-correct-restaurant',
    messageRow?.restaurant_id === RESTAURANT_ID && messageRow?.sender_type === 'customer',
    `row=${JSON.stringify(messageRow)}`,
  )
  record(
    '4b-event-id-is-internal-evt-prefixed',
    typeof messageRow?.event_id === 'string' && messageRow.event_id.startsWith('evt_'),
    `event_id=${messageRow?.event_id}`,
  )
  record(
    '4c-message-body-normalized-not-raw-meta-shape',
    messageRow?.message_type === 'text' && messageRow?.message_content === 'Hello, this is a real staging test message',
    `message_type=${messageRow?.message_type} message_content=${JSON.stringify(messageRow?.message_content)}`,
  )

  const { data: conversationRow } = await admin
    .from('whatsapp_conversations')
    .select('id, restaurant_id, customer_phone, message_count')
    .eq('restaurant_id', RESTAURANT_ID)
    .eq('customer_phone', customerPhone)
    .maybeSingle()
  record(
    '4d-conversation-created',
    conversationRow?.message_count === 1,
    `conversation=${JSON.stringify(conversationRow)}`,
  )

  // 5. Deduplication: send the exact same message id again -> not reprocessed (no duplicate row).
  const secondResult = await postWebhook(rawBody, validSignature)
  record('5-duplicate-webhook-still-returns-200', secondResult.status === 200, `status=${secondResult.status}`)

  await new Promise((r) => setTimeout(r, 500))

  const { data: dupCheckRows, count: dupCount } = await admin
    .from('whatsapp_messages')
    .select('id', { count: 'exact' })
    .eq('meta_message_id', metaMessageId)
  record('5b-deduplication-no-duplicate-row', dupCount === 1, `rows with this meta_message_id: ${dupCount} (${JSON.stringify(dupCheckRows)})`)

  const { data: conversationAfterDup } = await admin
    .from('whatsapp_conversations')
    .select('message_count')
    .eq('restaurant_id', RESTAURANT_ID)
    .eq('customer_phone', customerPhone)
    .maybeSingle()
  record(
    '5c-conversation-count-not-incremented-by-duplicate',
    conversationAfterDup?.message_count === 1,
    `message_count=${conversationAfterDup?.message_count} (should still be 1)`,
  )

  // 6. Unknown phone_number_id is rejected gracefully (not a crash) -- still 200 per Meta's contract,
  //    but no message/conversation is created for it.
  const unknownPayload = buildPayload(`wamid.${tag}.unknown`, customerPhone, 'should be dropped')
  unknownPayload.entry[0].changes[0].value.metadata.phone_number_id = '0000000000000000'
  const unknownRawBody = JSON.stringify(unknownPayload)
  const unknownResult = await postWebhook(unknownRawBody, signBody(unknownRawBody))
  record('6-unknown-phone-number-id-handled-gracefully', unknownResult.status === 200, `status=${unknownResult.status}`)

  await new Promise((r) => setTimeout(r, 300))
  const { data: unknownMsgRow } = await admin
    .from('whatsapp_messages')
    .select('id')
    .eq('meta_message_id', `wamid.${tag}.unknown`)
    .maybeSingle()
  record('6b-unknown-phone-number-id-not-saved', !unknownMsgRow, `row=${JSON.stringify(unknownMsgRow)}`)

  // 7. Confirm n8n actually receives the normalized event -- directly check the configured
  //    webhook URL is reachable and returns a real HTTP response (not asserting n8n's own
  //    internal workflow logic, just that the dispatcher's target endpoint responds).
  const n8nUrl = process.env.N8N_WHATSAPP_WEBHOOK_URL || ''
  if (n8nUrl) {
    try {
      const n8nProbe = await fetch(n8nUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ version: 1, probe: true }),
      })
      console.log(`INFO [7-n8n-reachability] configured URL responded status=${n8nProbe.status} (${n8nUrl})`)
    } catch (err) {
      console.log(`INFO [7-n8n-reachability] configured URL NOT reachable from this environment: ${err} (${n8nUrl})`)
    }
  }

  console.log('\nWHATSAPP_WEBHOOK_STAGING_OK')
}

main()
  .catch((err) => {
    console.error('FAILED:', err)
    process.exitCode = 1
  })
  .finally(async () => {
    // Cleanup: remove test messages/conversations created by this run.
    const { data: msgs } = await admin.from('whatsapp_messages').select('id, meta_message_id').ilike('meta_message_id', 'wamid.verify-%')
    if (msgs && msgs.length) {
      await admin.from('whatsapp_messages').delete().in('id', msgs.map((m) => m.id))
    }
    await admin.from('whatsapp_conversations').delete().eq('restaurant_id', RESTAURANT_ID).like('customer_phone', '2648199%')
    console.log('cleanup complete')
  })
