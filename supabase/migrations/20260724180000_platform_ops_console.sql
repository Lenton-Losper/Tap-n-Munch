-- Platform Ops Console: alert acknowledgements + bug report triage status

CREATE TABLE IF NOT EXISTS public.platform_alert_acks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  alert_key text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'acknowledged'
    CHECK (status IN ('acknowledged', 'resolved', 'open')),
  actor_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  actor_email text,
  note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS platform_alert_acks_status_idx
  ON public.platform_alert_acks (status);

ALTER TABLE public.platform_alert_acks ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Platform admins can read alert acks"
  ON public.platform_alert_acks FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.platform_admins
      WHERE platform_admins.user_id = auth.uid()
    )
  );

-- Service role (API) writes; no authenticated INSERT/UPDATE policy needed for browser clients.

ALTER TABLE public.bug_reports
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'in_progress', 'resolved', 'closed'));

ALTER TABLE public.bug_reports
  ADD COLUMN IF NOT EXISTS reporter_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL;

ALTER TABLE public.bug_reports
  ADD COLUMN IF NOT EXISTS reporter_name text;

ALTER TABLE public.bug_reports
  ADD COLUMN IF NOT EXISTS page_url text;

ALTER TABLE public.bug_reports
  ADD COLUMN IF NOT EXISTS resolved_at timestamptz;

ALTER TABLE public.bug_reports
  ADD COLUMN IF NOT EXISTS internal_note text;

CREATE INDEX IF NOT EXISTS bug_reports_status_created_idx
  ON public.bug_reports (status, created_at DESC);

-- Optional correlation id on platform audit for OWASP-style tracing
ALTER TABLE public.platform_audit_logs
  ADD COLUMN IF NOT EXISTS correlation_id text;

CREATE INDEX IF NOT EXISTS platform_audit_logs_created_idx
  ON public.platform_audit_logs (created_at DESC);

CREATE INDEX IF NOT EXISTS platform_audit_logs_action_idx
  ON public.platform_audit_logs (action);
