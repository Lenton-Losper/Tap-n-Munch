-- Authorization v2 Phase 1: allow persisting the bar station role on restaurant_users.
-- Bar staff are assigned directly (staff PATCH / admin), not via email invite — see ADR Phase 1.
-- staff_invites_role_check unchanged: invite API only supports manager/waiter today.

ALTER TABLE restaurant_users
  DROP CONSTRAINT IF EXISTS restaurant_users_role_check;

ALTER TABLE restaurant_users
  ADD CONSTRAINT restaurant_users_role_check
  CHECK (role IN ('owner', 'manager', 'cashier', 'waiter', 'kitchen', 'bar'));

-- staff_permissions overrides resolve via staff_members (email + restaurant_id).
ALTER TABLE staff_members
  DROP CONSTRAINT IF EXISTS staff_members_role_check;

ALTER TABLE staff_members
  ADD CONSTRAINT staff_members_role_check
  CHECK (role IN ('manager', 'cashier', 'waiter', 'kitchen', 'bar'));
