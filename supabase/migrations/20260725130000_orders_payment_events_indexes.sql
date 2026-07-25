-- Add indexes on orders/payment_events columns identified as unindexed in the
-- Mingle go-live capacity investigation: orders.status, orders.tab_id,
-- orders.payment_status, orders.placed_at, orders.firebase_restaurant_id are
-- all filtered by the POS/terminal order-flow routes with no matching index;
-- payment_events.origin_business_order_no and .event_type are filtered on
-- every payment-projection lookup. Not a current bottleneck at today's table
-- size, but cheap to add now ahead of added Mingle volume.

CREATE INDEX IF NOT EXISTS orders_status_idx ON orders (status);
CREATE INDEX IF NOT EXISTS orders_tab_id_idx ON orders (tab_id);
CREATE INDEX IF NOT EXISTS orders_payment_status_idx ON orders (payment_status);
CREATE INDEX IF NOT EXISTS orders_placed_at_idx ON orders (placed_at);
CREATE INDEX IF NOT EXISTS orders_firebase_restaurant_id_idx ON orders (firebase_restaurant_id);
CREATE INDEX IF NOT EXISTS payment_events_origin_business_order_no_idx ON payment_events (origin_business_order_no);
CREATE INDEX IF NOT EXISTS payment_events_event_type_idx ON payment_events (event_type);
