import type { NormalizedInboundEvent } from './types'

/**
 * Isolates the "how do we hand this event off" decision behind one function. Today it
 * forwards to n8n; later it could target a queue or a different orchestrator without
 * the webhook (or anything else calling dispatch()) ever changing.
 *
 * Deliberately thin -- not a queue abstraction, not a retry framework. Just this.
 */
async function forwardToN8n(event: NormalizedInboundEvent): Promise<void> {
  const webhookUrl = process.env.N8N_WHATSAPP_WEBHOOK_URL
  if (!webhookUrl) {
    console.error('[messagingDispatcher] N8N_WHATSAPP_WEBHOOK_URL is not configured; dropping event', {
      eventId: event.eventId,
    })
    return
  }

  try {
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(event),
    })
    if (!res.ok) {
      console.error('[messagingDispatcher] n8n forward returned non-OK status', {
        eventId: event.eventId,
        status: res.status,
      })
    }
  } catch (error) {
    console.error('[messagingDispatcher] n8n forward failed', {
      eventId: event.eventId,
      error,
    })
  }
}

export const messagingDispatcher = {
  dispatch: forwardToN8n,
}
