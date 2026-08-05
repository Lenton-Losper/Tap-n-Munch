-- READ-ONLY. Enumerates every object created by 20260705210000_post_payment_order_lifecycle
-- and 20260705220000_refund_events, and reports whether each is present on the target DB.
-- Written for PRODUCTION (ihlmmpmolnpchzgwyhgh) to establish whether either migration is
-- partially applied. Contains no DDL and no writes of any kind.
WITH want_col(v, t, c) AS (VALUES
  ('20260705210000','restaurants','short_code'),
  ('20260705210000','document_sequences','restaurant_id'),
  ('20260705210000','document_sequences','sequence_type'),
  ('20260705210000','document_sequences','current_number'),
  ('20260705210000','invoice_requests','idempotency_key'),
  ('20260705210000','invoice_requests','invoice_number'),
  ('20260705210000','invoice_requests','status'),
  ('20260705210000','invoice_requests','company_name'),
  ('20260705210000','invoice_requests','vat_number'),
  ('20260705210000','invoice_requests','email'),
  ('20260705210000','invoice_requests','metadata'),
  ('20260705210000','invoice_requests','pdf_url'),
  ('20260705210000','invoice_requests','failure_reason'),
  ('20260705210000','invoice_requests','retry_count'),
  ('20260705210000','invoice_requests','requested_at'),
  ('20260705210000','invoice_requests','generated_at'),
  ('20260705210000','invoice_requests','sent_at'),
  ('20260705210000','invoice_requests','updated_at'),
  ('20260705210000','order_revisions','revision_number'),
  ('20260705210000','order_revisions','amended_by'),
  ('20260705210000','order_revisions','reason'),
  ('20260705210000','order_revisions','changes'),
  ('20260705210000','order_revisions','financial_delta'),
  ('20260705220000','refund_events','payment_id'),
  ('20260705220000','refund_events','amount'),
  ('20260705220000','refund_events','reason'),
  ('20260705220000','refund_events','refunded_by'),
  ('20260705220000','refund_events','idempotency_key'),
  ('20260705220000','refund_events','status')),
want_tbl(v, t) AS (VALUES
  ('20260705210000','document_sequences'),('20260705210000','invoice_requests'),
  ('20260705210000','order_revisions'),('20260705220000','refund_events')),
want_fn(v, f) AS (VALUES
  ('20260705210000','generate_document_number'),('20260705210000','touch_updated_at'),
  ('20260705210000','set_order_revision_number'),
  ('DEPENDENCY','user_restaurant_ids')),
want_idx(v, i) AS (VALUES
  ('20260705210000','idx_invoice_requests_order_id'),
  ('20260705210000','idx_invoice_requests_restaurant_id'),
  ('20260705210000','idx_invoice_requests_status'),
  ('20260705210000','idx_order_revisions_order_id'),
  ('20260705220000','idx_refund_events_order_id'),
  ('20260705220000','idx_refund_events_payment_id')),
want_con(v, t, k) AS (VALUES
  ('20260705210000','invoice_requests','invoice_requests_idempotency_key_unique'),
  ('20260705210000','order_revisions','order_revisions_order_revision_unique'),
  ('20260705220000','refund_events','refund_events_idempotency_key_unique')),
want_trg(v, t, g) AS (VALUES
  ('20260705210000','invoice_requests','trg_invoice_requests_updated_at'),
  ('20260705210000','order_revisions','trg_set_order_revision_number')),
want_pol(v, t, p) AS (VALUES
  ('20260705210000','invoice_requests','staff_view_invoice_requests'),
  ('20260705210000','invoice_requests','staff_update_invoice_requests'),
  ('20260705210000','order_revisions','staff_view_order_revisions'),
  ('20260705210000','order_revisions','staff_insert_order_revisions'),
  ('20260705220000','refund_events','staff_view_refund_events'),
  ('20260705220000','refund_events','staff_insert_refund_events')),
want_rls(v, t) AS (VALUES
  ('20260705210000','invoice_requests'),('20260705210000','order_revisions'),
  ('20260705220000','refund_events'))
SELECT v AS migration, kind, obj, status FROM (
  SELECT v, 'TABLE' kind, t obj,
    CASE WHEN to_regclass('public.'||t) IS NOT NULL THEN 'present' ELSE 'MISSING' END status FROM want_tbl
  UNION ALL SELECT v, 'COLUMN', t||'.'||c,
    CASE WHEN EXISTS(SELECT 1 FROM information_schema.columns
      WHERE table_schema='public' AND table_name=t AND column_name=c) THEN 'present' ELSE 'MISSING' END FROM want_col
  UNION ALL SELECT v, 'FUNCTION', f,
    CASE WHEN EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='public' AND p.proname=f) THEN 'present' ELSE 'MISSING' END FROM want_fn
  UNION ALL SELECT v, 'INDEX', i,
    CASE WHEN EXISTS(SELECT 1 FROM pg_indexes WHERE schemaname='public' AND indexname=i) THEN 'present' ELSE 'MISSING' END FROM want_idx
  UNION ALL SELECT v, 'CONSTRAINT', k,
    CASE WHEN EXISTS(SELECT 1 FROM pg_constraint WHERE conname=k AND conrelid=to_regclass('public.'||t)) THEN 'present' ELSE 'MISSING' END FROM want_con
  UNION ALL SELECT v, 'TRIGGER', g,
    CASE WHEN EXISTS(SELECT 1 FROM pg_trigger WHERE tgname=g AND tgrelid=to_regclass('public.'||t) AND NOT tgisinternal) THEN 'present' ELSE 'MISSING' END FROM want_trg
  UNION ALL SELECT v, 'POLICY', t||' :: '||p,
    CASE WHEN EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename=t AND policyname=p) THEN 'present' ELSE 'MISSING' END FROM want_pol
  UNION ALL SELECT v, 'RLS', t||' rowsecurity',
    CASE WHEN EXISTS(SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename=t AND rowsecurity) THEN 'present' ELSE 'MISSING' END FROM want_rls
) z ORDER BY migration, kind, obj;
