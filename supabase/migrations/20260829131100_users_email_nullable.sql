-- public.users.email becomes nullable. The waiter-staff half of 20260829131000.
--
-- ============================================================================================
-- WHY
-- ============================================================================================
--
-- 20260829131000 gives staff_members a name and a user_id so a waiter with no work email can be
-- identified and linked to permissions. That is inert without this: the only path to add staff
-- today is POST /api/admin/invites, which hard-requires an email, and public.users.email is
-- NOT NULL and UNIQUE -- so creating a waiter still means inventing an address nobody reads.
-- Riviera has 2 owners, 1 manager and a full floor of waiters, none of whom have one.
--
-- ============================================================================================
-- WHY DROPPING NOT NULL AND NOT WEAKENING UNIQUE
-- ============================================================================================
--
-- Postgres UNIQUE permits any number of NULLs -- NULL is never considered equal to another NULL
-- for a unique index -- so ten waiters with no email do not collide with each other or with a
-- real address already in use. The UNIQUE constraint (users_email_key) is untouched: every row
-- that DOES carry an email still cannot collide with another.
--
-- ============================================================================================
-- BLAST RADIUS, MEASURED BEFORE WRITING THIS
-- ============================================================================================
--
-- No non-null assertion (`.email!`) reads public.users.email anywhere in shippable app/lib code
-- (grepped 2026-08-28). Every call site that selects it already guards with `?.`, `|| ''` or
-- `|| null` -- lib/permissions/authorize.ts, lib/auth/sync-user-email.ts,
-- app/api/auth/sync-profile/route.ts, app/api/admin/user-profile/route.ts among them.
--
-- ONE RESIDUAL RISK, worth recording rather than silently accepting the all-clear:
-- app/api/platform/restaurants/route.ts does `String(owner.email)` when building an owner-email
-- map for the platform dashboard. `String(null)` does not throw -- it coerces to the four-
-- character string "null", which would render as a real-looking email for any row this hits.
-- Low risk in practice: that map is built from RESTAURANT OWNERS, who still go through the
-- email-required invite flow this migration does not touch -- but it is a data-correctness risk,
-- not a crash, so it is named here rather than assumed safe because nothing asserts.
--
-- ============================================================================================
-- NOT APPLIED ANYWHERE AS OF THIS COMMIT.
-- ============================================================================================
--
-- This is Deploy 3 (waiter staff), its own deploy before Sunday, deliberately not riding in on
-- Deploy 2. Do not apply ahead of 20260829131000 -- the two ship together.

ALTER TABLE public.users
  ALTER COLUMN email DROP NOT NULL;

COMMENT ON COLUMN public.users.email IS
  'Nullable as of 20260829131100. A staff member added without a login (see staff_members.user_id, '
  '20260829131000) has no email -- that is the normal case for a waiter, not a missing value. '
  'users_email_key (UNIQUE) is unaffected: Postgres UNIQUE permits any number of NULLs.';
