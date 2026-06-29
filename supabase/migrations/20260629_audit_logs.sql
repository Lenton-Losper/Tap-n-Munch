-- Audit log for platform admin actions.
-- Append-only — no updates or deletes should ever occur on this table.
-- success flag allows recording unauthorized attempts and validation failures
-- in addition to successful changes.

CREATE TABLE IF NOT EXISTS public.platform_audit_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  actor_email text NOT NULL,
  action text NOT NULL,
  target_type text NOT NULL,
  target_id uuid,
  payload jsonb,
  ip_address text,
  user_agent text,
  success boolean NOT NULL DEFAULT true,
  created_at timestamptz DEFAULT now() NOT NULL
);

ALTER TABLE public.platform_audit_logs ENABLE ROW LEVEL SECURITY;

-- Platform admins can read audit logs; nobody can update or delete them.
CREATE POLICY "Platform admins can read audit logs"
  ON public.platform_audit_logs FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.platform_admins
      WHERE platform_admins.user_id = auth.uid()
    )
  );
