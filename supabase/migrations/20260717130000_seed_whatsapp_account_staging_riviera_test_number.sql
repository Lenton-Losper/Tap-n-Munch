-- Multi-Tenant WhatsApp Ingress Foundation (ADR 0005, Phase 1): seed a SECOND
-- STAGING-only phone_number_id into restaurant_whatsapp_accounts.
--
-- STAGING ONLY -- additive alongside 20260717120000, does not replace it. That
-- migration seeded phone_number_id 1273668565820748 (a separate, older Riviera
-- test number). This one is for a different number, +264 81 239 8945, newly
-- registered under Riviera's WABA and confirmed from the Meta Phone Profile
-- screen: phone_number_id 1239948345862179. Both map to the same staging test
-- restaurant (a1999166-ddfa-40d1-ad1f-2f01282a1652) -- Riviera's real
-- production restaurant id (01bf27f1-a958-4322-bb3e-cc5240987808) still does
-- not exist on staging, so as with 20260717120000, the real production
-- restaurant mapping belongs on production, applied separately. Do NOT apply
-- this specific migration to production.

INSERT INTO public.restaurant_whatsapp_accounts
  (restaurant_id, phone_number_id, display_phone_number, connection_status)
VALUES
  ('a1999166-ddfa-40d1-ad1f-2f01282a1652', '1239948345862179', '+264 81 239 8945', 'active')
ON CONFLICT (phone_number_id) DO NOTHING;
