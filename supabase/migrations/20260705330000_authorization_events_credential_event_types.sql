-- Expand authorization_events.event_type for credential management audit events.

ALTER TABLE public.authorization_events
  DROP CONSTRAINT authorization_events_event_type_check;

ALTER TABLE public.authorization_events
  ADD CONSTRAINT authorization_events_event_type_check
  CHECK (event_type IN (
    'issued', 'validated', 'consumed', 'expired', 'denied',
    'credential_set', 'credential_reset'
  ));

-- credential_set: a user set their own PIN for the first time, or an owner/manager set it
--   on someone's behalf for the first time.
-- credential_reset: an existing PIN was overwritten/changed.
-- These are distinct from the token lifecycle events (issued/validated/consumed/expired/denied),
-- which relate to a specific authorization token, not the underlying credential.
