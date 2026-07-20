-- Multi-Tenant WhatsApp Ingress Foundation (ADR 0005, Phase 1): FlashTap's own durable
-- conversation/message record, separate from n8n's execution history (which is not a
-- permanent business record).
--
-- Scope note: the existing whatsapp_sessions table (earlier n8n prototype) does NOT fit
-- this need and is intentionally left alone, not reused/extended -- its shape (stage
-- enum browsing/confirming/awaiting_payment/completed/expired/cancelled, cart jsonb,
-- order_id, payment_link_url) is specific to n8n's own checkout-flow state machine, not
-- general conversation/message-log state. Conflating the two would tie this ingress
-- layer's schema to one particular bot flow's lifecycle. Flagging this per the task
-- instructions rather than forcing a reuse that doesn't cleanly fit.

-- ---------------------------------------------------------------------------
-- 1. whatsapp_conversations: conversation state per customer/restaurant pair.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.whatsapp_conversations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id uuid NOT NULL REFERENCES public.restaurants(id),
  whatsapp_account_id uuid NOT NULL REFERENCES public.restaurant_whatsapp_accounts(id),
  customer_phone text NOT NULL,
  last_message_at timestamptz,
  message_count integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (restaurant_id, customer_phone)
);

CREATE INDEX IF NOT EXISTS whatsapp_conversations_restaurant_id_idx
  ON public.whatsapp_conversations (restaurant_id);

COMMENT ON TABLE public.whatsapp_conversations IS
  'One row per (restaurant, customer) WhatsApp thread. Ingress-layer conversation tracking -- not the checkout-flow state machine (see whatsapp_sessions).';

-- ---------------------------------------------------------------------------
-- 2. whatsapp_messages: permanent message log, dedup by Meta message id, and the
--    backing store for a future FlashTap Inbox (full thread: customer/bot/staff, in
--    order). Body is stored normalized ({ type, content }), not Meta's raw shape.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.whatsapp_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES public.whatsapp_conversations(id),
  restaurant_id uuid NOT NULL REFERENCES public.restaurants(id),
  event_id text NOT NULL UNIQUE,
  channel text NOT NULL DEFAULT 'whatsapp'
    CHECK (channel IN ('whatsapp')),
  sender_type text NOT NULL
    CHECK (sender_type IN ('customer', 'bot', 'staff')),
  message_type text NOT NULL,
  message_content jsonb NOT NULL,
  meta_message_id text,
  raw_payload jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS whatsapp_messages_conversation_id_created_at_idx
  ON public.whatsapp_messages (conversation_id, created_at);

CREATE INDEX IF NOT EXISTS whatsapp_messages_restaurant_id_idx
  ON public.whatsapp_messages (restaurant_id);

-- Dedup key: meta_message_id is only present for messages that actually came from Meta
-- (customer-sent, or a bot/staff reply once the future send endpoint records Meta's
-- response id) -- nullable partial-unique so it doesn't block rows with no Meta id yet.
CREATE UNIQUE INDEX IF NOT EXISTS whatsapp_messages_meta_message_id_unique_idx
  ON public.whatsapp_messages (meta_message_id)
  WHERE meta_message_id IS NOT NULL;

COMMENT ON TABLE public.whatsapp_messages IS
  'Permanent message log (customer/bot/staff), normalized body, internal event_id as the primary platform identifier. Designed to double as the backing store for a future Inbox view -- not built in this pass.';
COMMENT ON COLUMN public.whatsapp_messages.event_id IS
  'Internal evt_-prefixed id the rest of the platform refers to -- not Meta''s wamid, which is a channel-specific detail (see meta_message_id).';
COMMENT ON COLUMN public.whatsapp_messages.message_content IS
  'Normalized { type, content } body (e.g. text content is a plain string), not Meta''s raw message shape. Keeps the same event usable for other channels later.';
COMMENT ON COLUMN public.whatsapp_messages.raw_payload IS
  'Original Meta payload, kept alongside the normalized fields purely for support/debugging -- not the primary consumption path.';

ALTER TABLE public.whatsapp_conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.whatsapp_messages ENABLE ROW LEVEL SECURITY;

-- No permissive RLS policies for anon/authenticated roles on either table -- accessed
-- exclusively via the service role key (webhook + future Inbox API), same pattern as
-- payment_events/authorization_events/whatsapp_restaurant_numbers. RLS enabled with no
-- policies means default-deny for anon/authenticated.
