-- Onboarding setup progress per restaurant (Phase 3 signup)
create table if not exists public.restaurant_setup_status (
  restaurant_id uuid primary key references public.restaurants(id) on delete cascade,
  profile_complete boolean not null default false,
  tables_configured boolean not null default false,
  menu_added boolean not null default false,
  qr_downloaded boolean not null default false,
  staff_added boolean not null default false,
  terminal_connected boolean not null default false,
  test_order_completed boolean not null default false,
  first_payment_completed boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.restaurant_setup_status enable row level security;

drop policy if exists "Owners can read own restaurant setup status" on public.restaurant_setup_status;
create policy "Owners can read own restaurant setup status"
  on public.restaurant_setup_status
  for select
  using (
    restaurant_id in (
      select restaurant_id from public.restaurant_users where user_id = auth.uid()
    )
  );

drop policy if exists "Owners can update own restaurant setup status" on public.restaurant_setup_status;
create policy "Owners can update own restaurant setup status"
  on public.restaurant_setup_status
  for update
  using (
    restaurant_id in (
      select restaurant_id from public.restaurant_users where user_id = auth.uid()
    )
  );
