-- USERS
create table users (
  id uuid primary key default gen_random_uuid(),
  email text unique not null,
  name text,
  phone text,
  role text default 'owner',
  restaurant_id uuid,
  created_at timestamptz default now(),
  last_login timestamptz
);

-- RESTAURANTS
create table restaurants (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid references users(id),
  name text not null,
  slug text unique,
  phone text,
  logo_url text,
  primary_color text default '#FF6B35',
  currency text default 'NAD',
  tax_rate numeric default 0,
  service_fee numeric default 0,
  payment_methods text[] default array['cash'],
  subscription_status text default 'trial',
  subscription_tier text default 'starter',
  finatic_merchant_no text,
  finatic_store_no text,
  finatic_terminal_sn text,
  terminals jsonb default '[]',
  online_ordering_enabled boolean default true,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- TABLES
create table restaurant_tables (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid references restaurants(id) on delete cascade,
  table_number integer not null,
  table_name text,
  qr_code_url text,
  active boolean default true,
  created_at timestamptz default now()
);

-- TABLE SESSIONS
create table table_sessions (
  id uuid primary key default gen_random_uuid(),
  table_id uuid references restaurant_tables(id) on delete cascade,
  restaurant_id uuid references restaurants(id) on delete cascade,
  status text default 'active',
  created_at timestamptz default now(),
  closed_at timestamptz
);

-- MENU CATEGORIES
create table menu_categories (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid references restaurants(id) on delete cascade,
  name text not null,
  description text,
  display_order integer default 0,
  active boolean default true,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- MENU SUBCATEGORIES
create table menu_subcategories (
  id uuid primary key default gen_random_uuid(),
  category_id uuid references menu_categories(id) on delete cascade,
  restaurant_id uuid references restaurants(id) on delete cascade,
  name text not null,
  description text,
  display_order integer default 0,
  active boolean default true,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- MENU ITEMS
create table menu_items (
  id uuid primary key default gen_random_uuid(),
  subcategory_id uuid references menu_subcategories(id) on delete cascade,
  category_id uuid references menu_categories(id) on delete cascade,
  restaurant_id uuid references restaurants(id) on delete cascade,
  name text not null,
  description text,
  base_price numeric not null default 0,
  image_url text,
  status text default 'active',
  variants jsonb default '[]',
  variant_groups jsonb default '[]',
  times_ordered integer default 0,
  total_revenue numeric default 0,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- TABS
create table tabs (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid references restaurants(id) on delete cascade,
  table_id uuid references restaurant_tables(id),
  table_number integer,
  status text default 'open',
  members jsonb default '[]',
  total numeric default 0,
  created_at timestamptz default now(),
  settled_at timestamptz
);

-- ORDERS
create table orders (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid references restaurants(id) on delete cascade,
  table_id uuid references restaurant_tables(id),
  tab_id uuid references tabs(id),
  order_number integer,
  table_number integer,
  session_id text,
  member_session_id text,
  status text default 'new',
  payment_status text default 'pending',
  payment_method text default 'cash',
  payment_channel text,
  subtotal numeric default 0,
  tax numeric default 0,
  total numeric default 0,
  items jsonb default '[]',
  order_instructions text,
  is_closed boolean default false,
  table_closed boolean default false,
  tab_settlement_for_tab_id text,
  paycloud_merchant_order_no text,
  payment_checkout_url text,
  terminal_sn text,
  placed_at timestamptz default now(),
  accepted_at timestamptz,
  preparing_at timestamptz,
  ready_at timestamptz,
  completed_at timestamptz,
  paid_at timestamptz
);

-- ANALYTICS
create table daily_analytics (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid references restaurants(id) on delete cascade,
  date date not null,
  total_orders integer default 0,
  total_revenue numeric default 0,
  created_at timestamptz default now(),
  unique(restaurant_id, date)
);

-- ROW LEVEL SECURITY
alter table users enable row level security;
alter table restaurants enable row level security;
alter table restaurant_tables enable row level security;
alter table table_sessions enable row level security;
alter table menu_categories enable row level security;
alter table menu_subcategories enable row level security;
alter table menu_items enable row level security;
alter table tabs enable row level security;
alter table orders enable row level security;
alter table daily_analytics enable row level security;

-- RLS POLICIES (basic)
-- Public can read restaurants and menu
create policy "Public can read restaurants"
  on restaurants for select using (true);

create policy "Public can read menu categories"
  on menu_categories for select using (true);

create policy "Public can read menu subcategories"
  on menu_subcategories for select using (true);

create policy "Public can read menu items"
  on menu_items for select using (true);

create policy "Public can read tables"
  on restaurant_tables for select using (true);

create policy "Public can create orders"
  on orders for insert with check (true);

create policy "Public can read open orders"
  on orders for select using (is_closed = false);

create policy "Public can create tabs"
  on tabs for insert with check (true);

create policy "Public can read tabs"
  on tabs for select using (true);

create policy "Public can update tabs"
  on tabs for update using (true);
