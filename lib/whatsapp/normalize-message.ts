import type { NormalizedMessageBody } from './types'

/**
 * Normalizes Meta's raw per-type message shape into a channel-agnostic { type, content }
 * body. Only `text` is meaningfully handled in Phase 1 (the rest of the platform/n8n
 * only needs text today) -- other types are passed through with their raw Meta payload
 * as `content` so nothing is silently dropped, without over-building normalization for
 * message types nothing consumes yet.
 */
export function normalizeMetaMessage(metaMessage: Record<string, unknown>): NormalizedMessageBody {
  const type = String(metaMessage.type || 'unknown')

  if (type === 'text') {
    const text = metaMessage.text as { body?: unknown } | undefined
    return { type: 'text', content: typeof text?.body === 'string' ? text.body : '' }
  }

  return { type, content: metaMessage[type] ?? null }
}
