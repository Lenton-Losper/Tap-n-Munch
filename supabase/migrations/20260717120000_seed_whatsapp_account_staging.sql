-- Multi-Tenant WhatsApp Ingress Foundation (ADR 0005, Phase 1): seed the STAGING-only
-- test WhatsApp number into the new restaurant_whatsapp_accounts mapping table.
--
-- STAGING ONLY. Riviera's real production restaurant id
-- (01bf27f1-a958-4322-bb3e-cc5240987808) does not exist on staging, so it cannot be
-- seeded here -- that row belongs on production, with Riviera's real phone_number_id
-- (not this test number), applied separately once this work reaches production, the
-- same two-step staging-then-production pattern as the platform-admin bootstrap
-- (20260716140000 vs 20260716160000). Do NOT apply this specific migration to production.
--
-- Seeds the "staging test" restaurant (a1999166-ddfa-40d1-ad1f-2f01282a1652), which is
-- already the restaurant tied to the one verified/working test phone_number_id
-- (1273668565820748) in the existing whatsapp_restaurant_numbers prototype table -- the
-- right stand-in for proving the new ingress path end-to-end on staging.

INSERT INTO public.restaurant_whatsapp_accounts
  (restaurant_id, phone_number_id, display_phone_number, connection_status)
VALUES
  ('a1999166-ddfa-40d1-ad1f-2f01282a1652', '1273668565820748', '+264 81 679 4934', 'active')
ON CONFLICT (phone_number_id) DO NOTHING;
