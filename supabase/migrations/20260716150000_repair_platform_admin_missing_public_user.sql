-- One-time data repair: the xshadoey@gmail.com account was created directly via the
-- Admin API (scripts/apply-platform-admin-bootstrap-staging.ts, #13 bootstrap) rather than
-- through a real signup flow, so it never got a public.users row. That row is only used to
-- resolve profile data / satisfy FKs -- this account has no restaurant/owner_id context at
-- all (platform-admin only), so it does NOT go through the sync-profile repair flow (#8,
-- which has known risky owner_id-reassignment side effects and assumes restaurant context
-- that this account doesn't have).
--
-- Shape matches exactly what a normal signup inserts (see
-- lib/auth/ensure-public-user.ts's insertPayload and the create_restaurant_for_user RPC's
-- INSERT INTO public.users): id, email, full_name only. No restaurant_id, no
-- restaurant_users row, no restaurants.owner_id assignment -- this is not a restaurant
-- account.

INSERT INTO public.users (id, email, full_name)
SELECT id, email, NULL
FROM auth.users
WHERE lower(email) = lower('xshadoey@gmail.com')
ON CONFLICT (id) DO NOTHING;
