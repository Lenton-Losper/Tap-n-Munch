-- Bootstrap the first PRODUCTION platform admin for the Super Admin Dashboard (#13),
-- mirroring 20260716140000_bootstrap_platform_admin.sql (the staging bootstrap). Looks the
-- user up by email rather than hardcoding a UUID -- this is a one-time data insert, not a
-- special-cased identity check in application code.
--
-- Note: as of writing this, a platform_admins row for this account already exists on
-- production (created 2026-06-28, predating this migration) -- this INSERT is therefore
-- expected to be a no-op via ON CONFLICT DO NOTHING, kept for consistency with the staging
-- bootstrap pattern and to document the intended first-admin decision in migration history.

INSERT INTO public.platform_admins (user_id, email, role)
SELECT id, email, 'super_admin'
FROM auth.users
WHERE lower(email) = lower('llosperofficial@gmail.com')
ON CONFLICT (email) DO NOTHING;
