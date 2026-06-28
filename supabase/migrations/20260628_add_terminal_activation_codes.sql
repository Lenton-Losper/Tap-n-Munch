CREATE TABLE IF NOT EXISTS terminal_activation_codes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id UUID NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  terminal_id UUID NOT NULL REFERENCES restaurant_terminals(id) ON DELETE CASCADE,
  code TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE terminal_activation_codes ENABLE ROW LEVEL SECURITY;
