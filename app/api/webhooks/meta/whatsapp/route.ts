import { NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { verifyMetaWebhookSignature } from '@/lib/whatsapp/webhook-signature'
import { normalizeMetaMessage } from '@/lib/whatsapp/normalize-message'
import { messagingDispatcher } from '@/lib/whatsapp/messaging-dispatcher'
import type { NormalizedInboundEvent } from '@/lib/whatsapp/types'

export const dynamic = 'force-dynamic'

type MetaWebhookPayload = {
  object?: string
  entry?: Array<{
    id?: string
    changes?: Array<{
      field?: string
      value?: {
        metadata?: { phone_number_id?: string; display_phone_number?: string }
        messages?: Array<Record<string, unknown>>
      }
    }>
  }>
}

/**
 * Runs `promise` in the background without making the caller wait for it. The promise
 * starts executing immediately either way; when running as a real Cloudflare Worker we
 * additionally register it with ctx.waitUntil so it's guaranteed to finish before the
 * isolate is torn down after the response is sent. Falls back to a plain unawaited
 * promise when there's no Workers context (e.g. local `next dev`, where the process
 * stays alive independent of the response).
 */
function runInBackground(promise: Promise<unknown>): void {
  const guarded = promise.catch((error) => console.error('[whatsapp webhook] background task failed', error))

  import('@opennextjs/cloudflare')
    .then(({ getCloudflareContext }) => {
      const { ctx } = getCloudflareContext()
      ctx.waitUntil(guarded)
    })
    .catch(() => {
      // Not running in a Cloudflare Workers context -- `guarded` is already running
      // unawaited above, which is sufficient there.
    })
}

/** Meta's initial webhook verification handshake. */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)
  const mode = searchParams.get('hub.mode')
  const token = searchParams.get('hub.verify_token')
  const challenge = searchParams.get('hub.challenge')

  const expectedToken = process.env.META_WHATSAPP_VERIFY_TOKEN
  if (mode === 'subscribe' && expectedToken && token === expectedToken && challenge) {
    return new NextResponse(challenge, { status: 200 })
  }
  return NextResponse.json({ error: 'Verification failed' }, { status: 403 })
}

export async function POST(request: Request) {
  const rawBody = await request.text()

  const appSecret = process.env.META_WHATSAPP_APP_SECRET
  if (!appSecret) {
    console.error('[whatsapp webhook] META_WHATSAPP_APP_SECRET is not configured')
    return NextResponse.json({ error: 'Not configured' }, { status: 500 })
  }

  const signatureHeader = request.headers.get('x-hub-signature-256')
  const verified = await verifyMetaWebhookSignature(rawBody, signatureHeader, appSecret)
  if (!verified) {
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 })
  }

  let payload: MetaWebhookPayload
  try {
    payload = JSON.parse(rawBody)
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  if (payload.object !== 'whatsapp_business_account') {
    // Not a WhatsApp event we handle; Meta still expects 200.
    return NextResponse.json({ success: true })
  }

  const supabase = createServerSupabaseClient()

  for (const entry of payload.entry ?? []) {
    for (const change of entry.changes ?? []) {
      const messages = change.value?.messages
      const phoneNumberId = change.value?.metadata?.phone_number_id
      if (!messages || messages.length === 0 || !phoneNumberId) continue

      const { data: account, error: accountError } = await supabase
        .from('restaurant_whatsapp_accounts')
        .select('id, restaurant_id, connection_status')
        .eq('phone_number_id', phoneNumberId)
        .maybeSingle()

      if (accountError) {
        console.error('[whatsapp webhook] account lookup failed', { phoneNumberId, error: accountError })
        continue
      }
      if (!account || account.connection_status !== 'active') {
        console.warn('[whatsapp webhook] unknown or inactive phone_number_id, dropping', {
          phoneNumberId,
          found: !!account,
          status: account?.connection_status,
        })
        continue
      }

      for (const metaMessage of messages) {
        const metaMessageId = String(metaMessage.id || '')
        const customerPhone = String(metaMessage.from || '')
        if (!metaMessageId || !customerPhone) continue

        const { data: existing, error: dedupError } = await supabase
          .from('whatsapp_messages')
          .select('id')
          .eq('meta_message_id', metaMessageId)
          .maybeSingle()

        if (dedupError) {
          console.error('[whatsapp webhook] dedup check failed', { metaMessageId, error: dedupError })
          continue
        }
        if (existing) {
          // Already processed (Meta retries webhooks) -- skip without reprocessing.
          continue
        }

        const { data: conversation, error: convError } = await supabase
          .from('whatsapp_conversations')
          .select('id, message_count')
          .eq('restaurant_id', account.restaurant_id)
          .eq('customer_phone', customerPhone)
          .maybeSingle()

        if (convError) {
          console.error('[whatsapp webhook] conversation lookup failed', { customerPhone, error: convError })
          continue
        }

        let conversationId: string
        const nowIso = new Date().toISOString()
        if (conversation) {
          conversationId = conversation.id
          await supabase
            .from('whatsapp_conversations')
            .update({
              last_message_at: nowIso,
              message_count: (conversation.message_count ?? 0) + 1,
              updated_at: nowIso,
            })
            .eq('id', conversationId)
        } else {
          const { data: created, error: createError } = await supabase
            .from('whatsapp_conversations')
            .insert({
              restaurant_id: account.restaurant_id,
              whatsapp_account_id: account.id,
              customer_phone: customerPhone,
              last_message_at: nowIso,
              message_count: 1,
            })
            .select('id')
            .single()

          if (createError || !created?.id) {
            console.error('[whatsapp webhook] conversation create failed', { customerPhone, error: createError })
            continue
          }
          conversationId = created.id
        }

        const normalizedBody = normalizeMetaMessage(metaMessage)
        const eventId = `evt_${crypto.randomUUID()}`

        const { error: insertError } = await supabase.from('whatsapp_messages').insert({
          conversation_id: conversationId,
          restaurant_id: account.restaurant_id,
          event_id: eventId,
          channel: 'whatsapp',
          sender_type: 'customer',
          message_type: normalizedBody.type,
          message_content: normalizedBody.content,
          meta_message_id: metaMessageId,
          raw_payload: metaMessage,
        })

        if (insertError) {
          // Unique violation on meta_message_id means a concurrent request already
          // won the dedup race -- not a real failure.
          if ((insertError as { code?: string }).code !== '23505') {
            console.error('[whatsapp webhook] message insert failed', { metaMessageId, error: insertError })
          }
          continue
        }

        const normalizedEvent: NormalizedInboundEvent = {
          version: 1,
          eventId,
          channel: 'whatsapp',
          restaurantId: account.restaurant_id,
          whatsappAccountId: account.id,
          phoneNumberId,
          customerPhone,
          metaMessageId,
          message: normalizedBody,
        }

        // Fire-and-forget: the webhook must return 200 quickly and must not block on
        // n8n's response.
        runInBackground(messagingDispatcher.dispatch(normalizedEvent))
      }
    }
  }

  return NextResponse.json({ success: true })
}
