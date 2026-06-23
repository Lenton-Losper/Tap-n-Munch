-- Staff invites with token-based acceptance flow (Resend email)
-- token is uuid to match production schema

create table if not exists public.staff_invites (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants(id) on delete cascade,
  email text not null,
  role text not null check (role in ('manager', 'waiter')),
  token uuid not null unique default gen_random_uuid(),
  expires_at timestamptz not null,
  accepted boolean not null default false,
  accepted_at timestamptz,
  invited_by uuid not null references public.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

create index if not exists staff_invites_restaurant_id_idx
  on public.staff_invites (restaurant_id);

create index if not exists staff_invites_token_idx
  on public.staff_invites (token);

alter table public.staff_invites enable row level security;

drop policy if exists "Owners can read own staff invites" on public.staff_invites;
create policy "Owners can read own staff invites"
  on public.staff_invites for select
  using (
    restaurant_id in (
      select restaurant_id from public.restaurant_users where user_id = auth.uid()
    )
  );
