-- ================================================================================================
-- report_send_log: a DATABASE-ENFORCED claim per (schedule, trading day), so a scheduled report
-- can never be emailed twice.
-- ================================================================================================
--
-- WHY. send-scheduled-reports decided "already sent?" by READING report_send_log for a success row
-- and then sending. Two invocations running together both read "not sent" and both send. That is
-- not theoretical: on 2026-10-04 from 21:46 to at least 22:54 UTC Cloudflare dispatched every
-- production cron tick TWICE, 3 s apart (it persisted across a rollback, so it was the platform,
-- not the code). The 17:00 UTC send window was missed by luck. Application code cannot arbitrate
-- between two isolates that cannot see each other; only the database can.
--
-- WHAT. The route now INSERTS a `claimed` row for (schedule_id, report_period) BEFORE sending. This
-- unique partial index lets exactly one such row exist per period while it is `claimed` or
-- `success`, so the second invocation's insert fails with 23505 and it sends nothing. The claim
-- row becomes `success` after the send, or is released to `failed` (outside the index) so the next
-- tick can retry.
--
--   1. CHECK widened to admit 'claimed'. Additive: every existing value stays valid.
--   2. UNIQUE (schedule_id, report_period) WHERE status IN ('claimed','success').
--      Measured 2026-10-05 before writing this: production 444 rows, all 'success', ZERO duplicate
--      (schedule_id, report_period) groups; staging 0 rows. The index builds on both.
--
-- COMPATIBLE WITH THE CODE THAT IS LIVE WHEN IT IS APPLIED. The previous route never writes
-- 'claimed' and writes one 'success' row per send, so neither change alters its behaviour -- except
-- that a duplicate 'success' row from a doubled tick now fails its insert (the email had already
-- gone; the route already reports that path loudly). So: APPLY THIS FIRST, then deploy the route.
-- The other order is wrong: the new route's 'claimed' insert would be refused by the old CHECK and
-- every report would be skipped.
--
-- ROLLBACK (only after rolling the route back):
--   UPDATE public.report_send_log SET status = 'failed', error = 'claim released by rollback'
--    WHERE status = 'claimed';
--   DROP INDEX IF EXISTS public.report_send_log_one_claim_per_period;
--   ALTER TABLE public.report_send_log DROP CONSTRAINT report_send_log_status_check;
--   ALTER TABLE public.report_send_log ADD CONSTRAINT report_send_log_status_check
--     CHECK (status = ANY (ARRAY['success'::text, 'failed'::text]));
-- ================================================================================================

ALTER TABLE public.report_send_log DROP CONSTRAINT IF EXISTS report_send_log_status_check;
ALTER TABLE public.report_send_log ADD CONSTRAINT report_send_log_status_check
  CHECK (status = ANY (ARRAY['success'::text, 'failed'::text, 'claimed'::text]));

CREATE UNIQUE INDEX IF NOT EXISTS report_send_log_one_claim_per_period
  ON public.report_send_log (schedule_id, report_period)
  WHERE status IN ('claimed', 'success');
