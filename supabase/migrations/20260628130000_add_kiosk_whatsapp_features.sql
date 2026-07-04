ALTER TABLE restaurant_features
  ADD COLUMN IF NOT EXISTS kiosk_enabled BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS whatsapp_enabled BOOLEAN NOT NULL DEFAULT false;

-- Enable kiosk for ChowNow
INSERT INTO restaurant_features (restaurant_id, kiosk_enabled)
VALUES ('b161c758-582d-4dfa-839a-9fa35c492a49', true)
ON CONFLICT (restaurant_id) DO UPDATE SET kiosk_enabled = true;

-- platform_admins table
CREATE TABLE IF NOT EXISTS platform_admins (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  email TEXT NOT NULL UNIQUE,
  role TEXT NOT NULL DEFAULT 'support'
    CHECK (role IN ('super_admin', 'support')),
  created_at TIMESTAMPTZ DEFAULT now()
);
ALTER TABLE platform_admins ENABLE ROW LEVEL SECURITY;
