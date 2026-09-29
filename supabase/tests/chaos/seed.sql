-- CHAOS VENUE. One restaurant, one table, one waiter terminal, a manager who authorizes voids and
-- cash, and a menu that exercises every pricing shape the scenario needs:
--   * a REQUIRED priced group whose option REPLACES the base price (Modena Pasta: Size)
--   * a required TEXT group that must not change the price (Ribeye: Doneness)
--   * an optional text group (Modena Pasta: Sauce)
--   * a priced group on a bar item (House Wine: Glass)
--   * plain kitchen and bar items with no variants
-- Every id is fixed so the jest scenario and a human reading the database agree on what is what.

INSERT INTO public.restaurants (id, name, slug, currency, timezone, is_active, tab_pin_required)
VALUES ('c4a05000-0000-4000-8000-000000000001', 'Chaos Bistro', 'chaos-bistro', 'NAD',
        'Africa/Windhoek', true, false);

INSERT INTO public.restaurant_features (restaurant_id, station_screens_enabled, kitchen_enabled, split_bill_enabled)
VALUES ('c4a05000-0000-4000-8000-000000000001', true, true, true);

INSERT INTO public.restaurant_tables (id, restaurant_id, table_number, table_name, active, status)
VALUES ('c4a05000-0000-4000-8000-0000000000a7', 'c4a05000-0000-4000-8000-000000000001', 7, 'Table 7', true, 'available');

INSERT INTO public.restaurant_terminals (id, restaurant_id, device_serial, name, status, active)
VALUES ('c4a05000-0000-4000-8000-00000000e001', 'c4a05000-0000-4000-8000-000000000001',
        'CHAOS-P5-0001', 'Chaos waiter terminal', 'active', true);

INSERT INTO public.users (id, email)
VALUES ('c4a05000-0000-4000-8000-000000005001', 'manager@chaos.invalid'),
       ('c4a05000-0000-4000-8000-000000005002', 'waiter@chaos.invalid');

INSERT INTO public.restaurant_roles (restaurant_id, role_slug, display_name, permissions, is_system)
VALUES ('c4a05000-0000-4000-8000-000000000001', 'manager', 'Manager',
        ARRAY['orders:read', 'orders:update', 'documents:read', 'documents:write', 'payments:process'], true),
       ('c4a05000-0000-4000-8000-000000000001', 'waiter', 'Waiter', ARRAY['orders:read', 'orders:update'], true);

INSERT INTO public.restaurant_users (restaurant_id, user_id, role)
VALUES ('c4a05000-0000-4000-8000-000000000001', 'c4a05000-0000-4000-8000-000000005001', 'manager'),
       ('c4a05000-0000-4000-8000-000000000001', 'c4a05000-0000-4000-8000-000000005002', 'waiter');

INSERT INTO public.menu_categories (id, restaurant_id, name, active, route_to)
VALUES ('c4a05000-0000-4000-8000-00000000c001', 'c4a05000-0000-4000-8000-000000000001', 'Kitchen', true, 'kitchen'),
       ('c4a05000-0000-4000-8000-00000000c002', 'c4a05000-0000-4000-8000-000000000001', 'Bar', true, 'bar');

INSERT INTO public.menu_items (id, restaurant_id, category_id, name, base_price, status, variant_groups)
VALUES
  ('c4a05000-0000-4000-8000-000000001001', 'c4a05000-0000-4000-8000-000000000001', 'c4a05000-0000-4000-8000-00000000c001',
   'Modena Pasta', 120, 'active',
   '[{"name":"Size","required":true,"type":"price","options":[{"label":"Regular","price":120},{"label":"Large","price":155}]},
     {"name":"Sauce","required":false,"type":"text","options":["Tomato","Cream"]}]'::jsonb),
  ('c4a05000-0000-4000-8000-000000001002', 'c4a05000-0000-4000-8000-000000000001', 'c4a05000-0000-4000-8000-00000000c001',
   'Ribeye', 245, 'active',
   '[{"name":"Doneness","required":true,"type":"text","options":["Rare","Medium","Well done"]}]'::jsonb),
  ('c4a05000-0000-4000-8000-000000001003', 'c4a05000-0000-4000-8000-000000000001', 'c4a05000-0000-4000-8000-00000000c001',
   'Burger', 98.5, 'active', '[]'::jsonb),
  ('c4a05000-0000-4000-8000-000000001004', 'c4a05000-0000-4000-8000-000000000001', 'c4a05000-0000-4000-8000-00000000c001',
   'Chips', 35, 'active', '[]'::jsonb),
  ('c4a05000-0000-4000-8000-000000001005', 'c4a05000-0000-4000-8000-000000000001', 'c4a05000-0000-4000-8000-00000000c001',
   'Caesar Salad', 72, 'active', '[]'::jsonb),
  ('c4a05000-0000-4000-8000-000000001006', 'c4a05000-0000-4000-8000-000000000001', 'c4a05000-0000-4000-8000-00000000c001',
   'Cheesecake', 55, 'active', '[]'::jsonb),
  ('c4a05000-0000-4000-8000-000000002001', 'c4a05000-0000-4000-8000-000000000001', 'c4a05000-0000-4000-8000-00000000c002',
   'Lager', 32, 'active', '[]'::jsonb),
  ('c4a05000-0000-4000-8000-000000002002', 'c4a05000-0000-4000-8000-000000000001', 'c4a05000-0000-4000-8000-00000000c002',
   'House Wine', 45, 'active',
   '[{"name":"Glass","required":true,"type":"price","options":[{"label":"Small","price":45},{"label":"Large","price":68}]}]'::jsonb),
  ('c4a05000-0000-4000-8000-000000002003', 'c4a05000-0000-4000-8000-000000000001', 'c4a05000-0000-4000-8000-00000000c002',
   'Espresso', 26, 'active', '[]'::jsonb);

INSERT INTO public.restaurant_billing_profiles
  (restaurant_id, registration_number, vat_number, vat_registered, bank_name, bank_account_name, bank_account_number, bank_branch_code)
VALUES ('c4a05000-0000-4000-8000-000000000001', 'CC/2026/0042', '1234567-01-5', true,
        'Chaos Bank', 'Chaos Bistro (Pty) Ltd', '62000000001', '280172');
