alter table public.restaurant_setup_status
  add column if not exists dismissed boolean not null default false;
