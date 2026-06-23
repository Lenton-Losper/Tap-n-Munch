-- Bug reports from restaurant staff dashboard
create table if not exists public.bug_reports (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants (id) on delete cascade,
  description text not null,
  area text,
  created_at timestamptz not null default now()
);

create index if not exists bug_reports_restaurant_id_idx on public.bug_reports (restaurant_id);
create index if not exists bug_reports_created_at_idx on public.bug_reports (created_at desc);

alter table public.bug_reports enable row level security;

-- Staff can insert reports for their own restaurant
create policy "bug_reports_insert_own_restaurant"
  on public.bug_reports
  for insert
  to authenticated
  with check (
    restaurant_id in (
      select restaurant_id from public.users where id = auth.uid()
    )
  );

-- Staff can read their own restaurant's reports (optional, for future admin UI)
create policy "bug_reports_select_own_restaurant"
  on public.bug_reports
  for select
  to authenticated
  using (
    restaurant_id in (
      select restaurant_id from public.users where id = auth.uid()
    )
  );
