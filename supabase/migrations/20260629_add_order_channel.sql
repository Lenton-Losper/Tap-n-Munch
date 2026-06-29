ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS channel TEXT NOT NULL DEFAULT 'table'
  CHECK (channel IN ('table', 'kiosk', 'online'));

-- Add kiosk order number sequence
ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS kiosk_order_number INTEGER;

CREATE INDEX IF NOT EXISTS idx_orders_channel ON orders (channel);
