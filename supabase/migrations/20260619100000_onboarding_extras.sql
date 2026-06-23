-- Phase 4 onboarding: timestamps, completion %, terminals, invites

alter table public.restaurant_setup_status
  add column if not exists profile_completed_at timestamptz,
  add column if not exists tables_configured_at timestamptz,
  add column if not exists menu_added_at timestamptz,
  add column if not exists qr_downloaded_at timestamptz,
  add column if not exists staff_added_at timestamptz,
  add column if not exists terminal_connected_at timestamptz,
  add column if not exists test_order_completed_at timestamptz,
  add column if not exists first_payment_completed_at timestamptz,
  add column if not exists completion_percentage integer not null default 0;

create table if not exists public.restaurant_terminals (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants(id) on delete cascade,
  activation_code text not null,
  expires_at timestamptz not null,
  activated_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists restaurant_terminals_restaurant_id_idx
  on public.restaurant_terminals (restaurant_id);

create table if not exists public.restaurant_invites (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants(id) on delete cascade,
  email text not null,
  role text not null check (role in ('manager', 'waiter')),
  invited_by uuid references public.users(id) on delete set null,
  status text not null default 'pending',
  created_at timestamptz not null default now()
);

create index if not exists restaurant_invites_restaurant_id_idx
  on public.restaurant_invites (restaurant_id);

alter table public.restaurant_terminals enable row level security;
alter table public.restaurant_invites enable row level security;

drop policy if exists "Owners can read own restaurant terminals" on public.restaurant_terminals;
create policy "Owners can read own restaurant terminals"
  on public.restaurant_terminals for select
  using (
    restaurant_id in (
      select restaurant_id from public.restaurant_users where user_id = auth.uid()
    )
  );

drop policy if exists "Owners can read own restaurant invites" on public.restaurant_invites;
create policy "Owners can read own restaurant invites"
  on public.restaurant_invites for select
  using (
    restaurant_id in (
      select restaurant_id from public.restaurant_users where user_id = auth.uid()
    )
  );
