-- Kitchen vs bar order routing per menu category
alter table public.menu_categories
  add column if not exists route_to text not null default 'kitchen';

alter table public.menu_categories
  drop constraint if exists menu_categories_route_to_check;

alter table public.menu_categories
  add constraint menu_categories_route_to_check
  check (route_to in ('kitchen', 'bar', 'both'));
