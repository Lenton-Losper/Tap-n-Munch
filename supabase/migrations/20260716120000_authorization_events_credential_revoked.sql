-- Expand authorization_events.event_type for PIN revocation (issue #27 PIN dashboard).

ALTER TABLE public.authorization_events
  DROP CONSTRAINT authorization_events_event_type_check;

ALTER TABLE public.authorization_events
  ADD CONSTRAINT authorization_events_event_type_check
  CHECK (event_type IN (
    'issued', 'validated', 'consumed', 'expired', 'denied',
    'credential_set', 'credential_reset', 'credential_revoked'
  ));

-- credential_revoked: an existing PIN was cleared entirely (terminal_authorization_credentials
-- row deleted), distinct from credential_reset (overwritten with a new PIN).
