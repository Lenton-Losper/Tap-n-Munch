-- Add cashier and kitchen to restaurant_users
ALTER TABLE restaurant_users
  DROP CONSTRAINT IF EXISTS restaurant_users_role_check;
ALTER TABLE restaurant_users
  ADD CONSTRAINT restaurant_users_role_check
  CHECK (role IN ('owner','manager','cashier','waiter','kitchen'));

-- Add cashier and kitchen to staff_invites
ALTER TABLE staff_invites
  DROP CONSTRAINT IF EXISTS staff_invites_role_check;
ALTER TABLE staff_invites
  ADD CONSTRAINT staff_invites_role_check
  CHECK (role IN ('manager','cashier','waiter','kitchen'));

-- Add constraint to staff_members role if not already constrained
ALTER TABLE staff_members
  DROP CONSTRAINT IF EXISTS staff_members_role_check;
ALTER TABLE staff_members
  ADD CONSTRAINT staff_members_role_check
  CHECK (role IN ('manager','cashier','waiter','kitchen'));

-- Repurpose staff_permissions as overrides table
-- Add allow/deny column (default allow since existing rows are grants)
ALTER TABLE staff_permissions
  ADD COLUMN IF NOT EXISTS effect TEXT NOT NULL DEFAULT 'allow'
  CHECK (effect IN ('allow','deny'));

ALTER TABLE staff_permissions
  ADD COLUMN IF NOT EXISTS restaurant_id UUID REFERENCES restaurants(id) ON DELETE CASCADE;
