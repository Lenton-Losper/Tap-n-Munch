-- Phase 4A: replace role CHECK constraints with composite FK to restaurant_roles.

ALTER TABLE public.restaurant_users
  DROP CONSTRAINT IF EXISTS restaurant_users_role_check;

ALTER TABLE public.staff_invites
  DROP CONSTRAINT IF EXISTS staff_invites_role_check;

ALTER TABLE public.staff_members
  DROP CONSTRAINT IF EXISTS staff_members_role_check;

ALTER TABLE public.restaurant_users
  ADD CONSTRAINT restaurant_users_role_slug_fkey
  FOREIGN KEY (restaurant_id, role)
  REFERENCES public.restaurant_roles (restaurant_id, role_slug)
  ON UPDATE CASCADE
  ON DELETE RESTRICT;

ALTER TABLE public.staff_invites
  ADD CONSTRAINT staff_invites_role_slug_fkey
  FOREIGN KEY (restaurant_id, role)
  REFERENCES public.restaurant_roles (restaurant_id, role_slug)
  ON UPDATE CASCADE
  ON DELETE RESTRICT;

ALTER TABLE public.staff_members
  ADD CONSTRAINT staff_members_role_slug_fkey
  FOREIGN KEY (restaurant_id, role)
  REFERENCES public.restaurant_roles (restaurant_id, role_slug)
  ON UPDATE CASCADE
  ON DELETE RESTRICT;
