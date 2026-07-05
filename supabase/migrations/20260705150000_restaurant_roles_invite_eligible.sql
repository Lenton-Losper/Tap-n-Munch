-- Phase 4B: invite eligibility as data on restaurant_roles.

ALTER TABLE public.restaurant_roles
  ADD COLUMN IF NOT EXISTS is_invite_eligible boolean NOT NULL DEFAULT false;

UPDATE public.restaurant_roles
SET is_invite_eligible = true
WHERE role_slug IN ('manager', 'waiter');
