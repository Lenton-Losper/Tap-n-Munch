-- Terminal Privileged Authorization service (Phase 1: refund purpose).
-- PIN material is stored as PBKDF2 hash + salt (Web Crypto on the app side; not bcrypt).

-- ---------------------------------------------------------------------------
-- 1. terminal_authorization_credentials
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.terminal_authorization_credentials (
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  restaurant_id uuid NOT NULL REFERENCES public.restaurants(id) ON DELETE CASCADE,
  pin_hash text NOT NULL,
  pin_salt text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, restaurant_id)
);

CREATE INDEX IF NOT EXISTS terminal_authorization_credentials_restaurant_id_idx
  ON public.terminal_authorization_credentials (restaurant_id);

COMMENT ON TABLE public.terminal_authorization_credentials IS
  'Manager/owner PIN credentials for terminal privileged actions. pin_hash/pin_salt are PBKDF2 (Web Crypto), not bcrypt.';
COMMENT ON COLUMN public.terminal_authorization_credentials.pin_hash IS
  'PBKDF2 digest (application-defined encoding, e.g. base64).';
COMMENT ON COLUMN public.terminal_authorization_credentials.pin_salt IS
  'PBKDF2 salt (application-defined encoding, e.g. base64).';

-- ---------------------------------------------------------------------------
-- 2. privileged_authorization_tokens
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.privileged_authorization_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  restaurant_id uuid NOT NULL REFERENCES public.restaurants(id) ON DELETE CASCADE,
  terminal_id uuid NOT NULL REFERENCES public.restaurant_terminals(id) ON DELETE CASCADE,
  purpose text NOT NULL,
  nonce text NOT NULL,
  ttl_seconds integer NOT NULL DEFAULT 90,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  CONSTRAINT privileged_authorization_tokens_purpose_check
    CHECK (purpose IN ('refund')),
  CONSTRAINT privileged_authorization_tokens_ttl_positive
    CHECK (ttl_seconds > 0),
  CONSTRAINT privileged_authorization_tokens_expires_after_created
    CHECK (expires_at > created_at),
  UNIQUE (user_id, restaurant_id, terminal_id, purpose, nonce)
);

CREATE INDEX IF NOT EXISTS privileged_authorization_tokens_restaurant_id_idx
  ON public.privileged_authorization_tokens (restaurant_id);

CREATE INDEX IF NOT EXISTS privileged_authorization_tokens_terminal_id_idx
  ON public.privileged_authorization_tokens (terminal_id);

CREATE INDEX IF NOT EXISTS privileged_authorization_tokens_expires_at_idx
  ON public.privileged_authorization_tokens (expires_at)
  WHERE used_at IS NULL;

COMMENT ON TABLE public.privileged_authorization_tokens IS
  'Short-lived, single-use authorization tokens after PIN verification. Backend/service-role only; no client RLS policies.';
COMMENT ON COLUMN public.privileged_authorization_tokens.ttl_seconds IS
  'TTL chosen at issuance time; not hardcoded in application logic.';
COMMENT ON COLUMN public.privileged_authorization_tokens.nonce IS
  'Single-use nonce; uniqueness scoped to user, restaurant, terminal, and purpose.';

-- ---------------------------------------------------------------------------
-- 3. authorization_events
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.authorization_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_id uuid REFERENCES public.privileged_authorization_tokens(id) ON DELETE SET NULL,
  event_type text NOT NULL,
  actor_user_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
  restaurant_id uuid NOT NULL REFERENCES public.restaurants(id) ON DELETE CASCADE,
  terminal_id uuid REFERENCES public.restaurant_terminals(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  detail jsonb,
  CONSTRAINT authorization_events_event_type_check
    CHECK (event_type IN ('issued', 'validated', 'consumed', 'expired', 'denied'))
);

CREATE INDEX IF NOT EXISTS authorization_events_restaurant_id_created_at_idx
  ON public.authorization_events (restaurant_id, created_at DESC);

CREATE INDEX IF NOT EXISTS authorization_events_token_id_idx
  ON public.authorization_events (token_id);

COMMENT ON TABLE public.authorization_events IS
  'Audit trail for the authorization step (PIN / token lifecycle). Separate from payment_events financial audit.';

-- ---------------------------------------------------------------------------
-- 4. terminal:auth:manage on owner / manager roles
-- ---------------------------------------------------------------------------
UPDATE public.restaurant_roles
SET permissions = array_append(permissions, 'terminal:auth:manage')
WHERE role_slug IN ('owner', 'manager')
  AND NOT ('terminal:auth:manage' = ANY (permissions));

-- ---------------------------------------------------------------------------
-- 5. RLS
-- ---------------------------------------------------------------------------
ALTER TABLE public.terminal_authorization_credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.privileged_authorization_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.authorization_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authorized staff can read terminal authorization credentials"
  ON public.terminal_authorization_credentials
  FOR SELECT
  USING (public.user_has_permission(restaurant_id, 'terminal:auth:manage'));

CREATE POLICY "Authorized staff can read authorization events"
  ON public.authorization_events
  FOR SELECT
  USING (public.user_has_permission(restaurant_id, 'terminal:auth:manage'));

-- privileged_authorization_tokens: intentionally no policies for authenticated/anon.
-- All client access is denied; backend uses service_role (bypasses RLS).
-- Writes to credentials and authorization_events are also service-role only (no INSERT/UPDATE policies).
