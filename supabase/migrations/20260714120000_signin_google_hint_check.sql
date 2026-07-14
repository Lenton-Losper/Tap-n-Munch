-- Server-side check for the sign-in "signed up with Google" hint (#34).
-- Returns true only for confirmed Google-only accounts (no password
-- credential), so the hint stops appearing on every invalid-credentials
-- error. service_role only — not a general-purpose email lookup.

CREATE OR REPLACE FUNCTION public.should_show_google_signin_hint(p_email text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, auth
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM auth.users u
    WHERE lower(u.email) = lower(p_email)
      AND EXISTS (
        SELECT 1 FROM auth.identities i
        WHERE i.user_id = u.id AND i.provider = 'google'
      )
      AND NOT EXISTS (
        SELECT 1 FROM auth.identities i2
        WHERE i2.user_id = u.id AND i2.provider = 'email'
      )
      AND COALESCE((u.raw_user_meta_data->>'has_password_credential')::boolean, false) = false
  );
$$;

REVOKE ALL ON FUNCTION public.should_show_google_signin_hint(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.should_show_google_signin_hint(text) TO service_role;
