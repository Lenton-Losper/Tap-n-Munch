-- Allow 'cash_settlement' as a privileged authorization purpose.
--
-- Cash taken at the table has no gateway record behind it, so the audit trail is the only
-- evidence that it was collected and by whom. The terminal tab settle route accepts an
-- optional authorization token to name that staff member; without this the purpose is
-- rejected by the CHECK constraint and /api/terminal/authorize fails on the token insert,
-- leaving every cash settlement unattributable.
--
-- Deliberately not a hard gate: settling in cash without a token remains allowed and is
-- recorded as actor_attribution='terminal_only'.

ALTER TABLE public.privileged_authorization_tokens
  DROP CONSTRAINT IF EXISTS privileged_authorization_tokens_purpose_check;

ALTER TABLE public.privileged_authorization_tokens
  ADD CONSTRAINT privileged_authorization_tokens_purpose_check
  CHECK (purpose IN ('refund', 'cash_settlement'));
