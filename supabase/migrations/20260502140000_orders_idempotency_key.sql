-- Run in Supabase SQL Editor if migrations are not applied automatically.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS idempotency_key TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS orders_idempotency_key_unique
ON orders (idempotency_key)
WHERE idempotency_key IS NOT NULL;
