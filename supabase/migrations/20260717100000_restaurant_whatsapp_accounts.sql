-- Multi-Tenant WhatsApp Ingress Foundation (ADR 0005, Phase 1).
-- Canonical mapping of a Meta WhatsApp phone_number_id -> restaurant, resolved by the
-- new POST /api/webhooks/meta/whatsapp endpoint. Distinct from the earlier n8n-prototype
-- whatsapp_restaurant_numbers table (which this Phase 1 ingress path supersedes but does
-- not delete/migrate -- that table is left untouched pending a decision on retiring it).

CREATE TABLE IF NOT EXISTS public.restaurant_whatsapp_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id uuid NOT NULL REFERENCES public.restaurants(id),
  phone_number_id text NOT NULL UNIQUE,
  waba_id text,
  display_phone_number text,
  connection_status text NOT NULL DEFAULT 'active'
    CHECK (connection_status IN ('active', 'disabled')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS restaurant_whatsapp_accounts_restaurant_id_idx
  ON public.restaurant_whatsapp_accounts (restaurant_id);

COMMENT ON TABLE public.restaurant_whatsapp_accounts IS
  'Maps a Meta WhatsApp Business phone_number_id to a restaurant. Resolved by the inbound webhook to determine tenant + reject unknown/disabled numbers.';

ALTER TABLE public.restaurant_whatsapp_accounts ENABLE ROW LEVEL SECURITY;

-- No permissive RLS policies for anon/authenticated roles -- accessed exclusively via the
-- service role key (webhook + future admin tooling), same pattern as payment_events,
-- authorization_events, and whatsapp_restaurant_numbers. RLS enabled with no policies means
-- default-deny for anon/authenticated.
