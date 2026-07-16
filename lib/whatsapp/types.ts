/**
 * Channel-agnostic normalized message body -- not Meta's raw shape. Keeps the same
 * event usable for other channels (Instagram/SMS/Telegram) later without the
 * dispatch target needing to know which channel it came from.
 */
export type NormalizedMessageBody = {
  type: string
  content: unknown
}

/**
 * The event FlashTap hands off to messagingDispatcher.dispatch(). Versioned from day
 * one (ADR 0005, Multi-Tenant WhatsApp Ingress Foundation) so the shape can evolve
 * (version 2, etc.) without breaking whatever already depends on version 1.
 */
export type NormalizedInboundEvent = {
  version: 1
  eventId: string
  channel: 'whatsapp'
  restaurantId: string
  whatsappAccountId: string
  phoneNumberId: string
  customerPhone: string
  metaMessageId: string
  message: NormalizedMessageBody
}
