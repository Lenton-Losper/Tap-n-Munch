-- Phase 6: terminal activation codes on restaurant_terminals

alter table public.restaurant_terminals
  add column if not exists activation_code text,
  add column if not exists activation_code_expires_at timestamptz,
  add column if not exists activated_at timestamptz;

create index if not exists restaurant_terminals_activation_code_idx
  on public.restaurant_terminals (activation_code)
  where activation_code is not null;
