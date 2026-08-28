-- Staff records without auth accounts, and history that cannot be silently erased.
--
-- ============================================================================================
-- WHY
-- ============================================================================================
--
-- Riviera has 2 owners, 1 manager and a full floor of waiters. Most waiters have no work email,
-- and nobody is running fifteen invite flows before service. The terminal already asks for a PIN
-- rather than a login, so the device is the authenticated principal and the person is the
-- recorded actor.
--
-- MEASURED ON STAGING 2026-08-28, because this was assumed to need a redesign and does not:
--   * public.users has ZERO foreign keys to auth.users.
--   * 30 of 44 public.users rows ALREADY have no auth account.
--   * ZERO RLS policies on orders, order_lines, tabs, order_line_events or
--     service_table_assignments reference auth.uid().
--   * order_line_events.actor_kind already carries 'station' and 'terminal' in live data.
--
-- So staff-without-logins is not a new architecture. It is what is already running. This
-- migration removes the two things standing in the way of USING it deliberately, and closes a
-- history hole found while measuring.
--
-- ============================================================================================
-- 1. staff_members.name -- there is nowhere to put "Maria"
-- ============================================================================================
--
-- staff_members is id, restaurant_id, email, role, active, created_at, push_token. A manager
-- creating a floor of waiters has no column to type a name into, and a waiter who never has an
-- email cannot be identified by one either.
--
-- ============================================================================================
-- 2. staff_members.user_id -- retiring the EMAIL JOIN
-- ============================================================================================
--
-- resolveStaffMemberId() links a user to their staff_members row BY EMAIL, because the table has
-- no user_id. Every permission override a person holds is found through that join.
--
-- That is already costing us. It is why the staging authorize suites share one fixture row, which
-- is why two overlapping CI runs corrupt each other, which is what went red on 2026-08-28. With
-- fifteen waiters who have no email, a nullable email column collapses them into an ambiguous
-- join and .maybeSingle() starts erroring or returning the wrong person's permissions.
--
-- The column is backfilled from the existing email match below, so the link survives the change.
--
-- ============================================================================================
-- 3. SET NULL -> RESTRICT -- the immutability rule, enforced by the database
-- ============================================================================================
--
-- THIS IS THE PART THAT IS NOT ABOUT LOGINS AND MATTERS MOST.
--
-- Deleting a user today does not fail. It SUCCEEDS and quietly rewrites history:
--   tabs.opened_by_user_id                        ON DELETE SET NULL
--   order_line_events.actor_user_id               ON DELETE SET NULL
--   service_table_assignments.assigned_by_user_id ON DELETE SET NULL
--
-- Who opened every tab and who bumped every line becomes NULL, with no error raised. The business
-- record survives; the attribution does not. For a system whose audit trail is the thing that
-- distinguishes "the kitchen never made it" from "it sat on the pass", that is the record being
-- destroyed rather than preserved.
--
-- One constraint is currently all that prevents it: service_table_assignments.waiter_user_id is
-- already RESTRICT, so the delete is blocked TODAY only as a side effect. Clean up assignment
-- rows first and the delete goes through, blanking everything else on its way.
--
-- After this migration a hard delete of a user with any history REFUSES. Deactivation is
-- active = false plus deleting the PIN credential, never a row delete -- see the app-side change.
--
-- terminal_authorization_credentials.user_id stays ON DELETE CASCADE deliberately: a credential is
-- not history, and it SHOULD die with the person it authenticates.

-- ------------------------------------------------------------------------------------------
-- 1 + 2. The columns.
-- ------------------------------------------------------------------------------------------
-- Column and constraint are added in SEPARATE statements, deliberately. `ADD COLUMN IF NOT EXISTS
-- ... REFERENCES` short-circuits the WHOLE definition when the column already exists, so the
-- foreign key is silently never created and the migration still reports success (#358).

ALTER TABLE public.staff_members
  ADD COLUMN IF NOT EXISTS name text;

ALTER TABLE public.staff_members
  ADD COLUMN IF NOT EXISTS user_id uuid;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'staff_members_user_id_fkey'
  ) THEN
    ALTER TABLE public.staff_members
      ADD CONSTRAINT staff_members_user_id_fkey
      FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE RESTRICT;
  END IF;
END $$;

-- Backfill from the join being retired, so no existing link is lost. Case-insensitive and
-- trimmed, matching what resolveStaffMemberId() does today (.ilike on email).
UPDATE public.staff_members sm
SET user_id = u.id
FROM public.users u
WHERE sm.user_id IS NULL
  AND sm.email IS NOT NULL
  AND btrim(lower(sm.email)) = btrim(lower(u.email));

-- One staff row per person per restaurant. Without this the ambiguity simply moves from email to
-- user_id. Partial, because a staff member with no linked user is legitimate -- that is the whole
-- point of the change.
CREATE UNIQUE INDEX IF NOT EXISTS staff_members_restaurant_user_unique
  ON public.staff_members (restaurant_id, user_id)
  WHERE user_id IS NOT NULL;

-- The lookup path resolveStaffMemberId() will use instead of the email scan.
CREATE INDEX IF NOT EXISTS staff_members_user_id_idx
  ON public.staff_members (user_id)
  WHERE user_id IS NOT NULL;

-- ------------------------------------------------------------------------------------------
-- 3. SET NULL -> RESTRICT.
-- ------------------------------------------------------------------------------------------
-- Dropped and recreated by name. Each is guarded so a re-run is a no-op rather than an error, and
-- each DROP names the constraint it expects so a rename upstream surfaces here instead of silently
-- leaving the old SET NULL in place.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tabs_opened_by_user_id_fkey') THEN
    ALTER TABLE public.tabs DROP CONSTRAINT tabs_opened_by_user_id_fkey;
  END IF;

  ALTER TABLE public.tabs
    ADD CONSTRAINT tabs_opened_by_user_id_fkey
    FOREIGN KEY (opened_by_user_id) REFERENCES public.users(id) ON DELETE RESTRICT;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'order_line_events_actor_user_id_fkey') THEN
    ALTER TABLE public.order_line_events DROP CONSTRAINT order_line_events_actor_user_id_fkey;
  END IF;

  ALTER TABLE public.order_line_events
    ADD CONSTRAINT order_line_events_actor_user_id_fkey
    FOREIGN KEY (actor_user_id) REFERENCES public.users(id) ON DELETE RESTRICT;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'service_table_assignments_assigned_by_user_id_fkey'
  ) THEN
    ALTER TABLE public.service_table_assignments
      DROP CONSTRAINT service_table_assignments_assigned_by_user_id_fkey;
  END IF;

  ALTER TABLE public.service_table_assignments
    ADD CONSTRAINT service_table_assignments_assigned_by_user_id_fkey
    FOREIGN KEY (assigned_by_user_id) REFERENCES public.users(id) ON DELETE RESTRICT;
END $$;

COMMENT ON COLUMN public.staff_members.user_id IS
  'The person this staff record is. Replaces the email join in resolveStaffMemberId(). Nullable: a '
  'staff member with no login is the normal case for a waiter.';

COMMENT ON COLUMN public.staff_members.name IS
  'Display name. The only identifier for a waiter created in bulk with no email.';
