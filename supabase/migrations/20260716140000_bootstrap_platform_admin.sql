-- One-time bootstrap for the Super Admin Dashboard (#13): the platform_admins invite flow
-- has no one to invite from initially, so this seeds the first row directly. Looks the user
-- up by email rather than hardcoding a UUID -- this is a one-time data insert, not a
-- special-cased identity check in application code.

INSERT INTO public.platform_admins (user_id, email, role)
SELECT id, email, 'super_admin'
FROM auth.users
WHERE lower(email) = lower('xshadoey@gmail.com')
ON CONFLICT (email) DO NOTHING;
