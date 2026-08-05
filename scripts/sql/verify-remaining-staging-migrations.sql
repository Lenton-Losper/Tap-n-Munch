-- READ-ONLY. Issue #143: verify every object the five unappliable migrations create is
-- already present on staging, which is the precondition for repair-only ledger treatment.
WITH want_tables(v, t) AS (VALUES
  ('20260705280000','restaurant_billing_profiles'),('20260705280000','document_sequences'),
  ('20260705280000','business_documents'),
  ('20260705320000','terminal_authorization_credentials'),
  ('20260705320000','privileged_authorization_tokens'),('20260705320000','authorization_events'),
  ('20260722140000','document_payments')),
want_idx(v, i) AS (VALUES
  ('20260705280000','restaurant_billing_profiles_restaurant_id_idx'),
  ('20260705280000','business_documents_restaurant_id_idx'),
  ('20260705280000','business_documents_restaurant_id_document_type_idx'),
  ('20260705280000','business_documents_quote_id_idx'),
  ('20260705320000','terminal_authorization_credentials_restaurant_id_idx'),
  ('20260705320000','privileged_authorization_tokens_restaurant_id_idx'),
  ('20260705320000','privileged_authorization_tokens_terminal_id_idx'),
  ('20260705320000','privileged_authorization_tokens_expires_at_idx'),
  ('20260705320000','authorization_events_restaurant_id_created_at_idx'),
  ('20260705320000','authorization_events_token_id_idx'),
  ('20260722140000','business_documents_restaurant_status_due_idx'),
  ('20260722140000','document_payments_document_id_idx')),
want_pol(v, t, p) AS (VALUES
  ('20260705280000','restaurant_billing_profiles','Authorized staff can read restaurant billing profiles'),
  ('20260705280000','restaurant_billing_profiles','Authorized staff can write restaurant billing profiles'),
  ('20260705280000','document_sequences','Staff can read document sequences'),
  ('20260705280000','document_sequences','Authorized staff can write document sequences'),
  ('20260705280000','business_documents','Authorized staff can read business documents'),
  ('20260705280000','business_documents','Authorized staff can write business documents'),
  ('20260705320000','terminal_authorization_credentials','Authorized staff can read terminal authorization credentials'),
  ('20260705320000','authorization_events','Authorized staff can read authorization events'),
  ('20260722140000','document_payments','Authorized staff can read document payments'),
  ('20260722140000','document_payments','Authorized staff can record document payments'),
  ('20260726200000','tabs','Staff can select tabs for their restaurants'),
  ('20260726200000','tabs','Staff can insert tabs for their restaurants'),
  ('20260726200000','tabs','Staff can update tabs for their restaurants'),
  ('20260726200000','tabs','Guests can read active tabs for ordering'),
  ('20260726200000','restaurants','Guests can read public restaurant identity'),
  ('20260726200000','restaurants','Staff can select restaurants they belong to'),
  ('20260726200000','restaurants','Staff can update restaurants they belong to'),
  ('20260726200000','users','Users can read own row'),
  ('20260726200000','users','Users can update own row')),
want_col(v, t, c) AS (VALUES
  ('20260722140000','business_documents','status'),('20260722140000','business_documents','sent_at')),
want_con(v, t, k) AS (VALUES
  ('20260705330000','authorization_events','authorization_events_event_type_check'),
  ('20260722140000','business_documents','business_documents_status_check')),
want_rls(v, t) AS (VALUES
  ('20260726200000','tabs'),('20260726200000','restaurants'),('20260726200000','users'),
  ('20260726200000','sessions'),('20260722140000','document_payments'))
SELECT v, kind, obj, status FROM (
  SELECT v, 'TABLE' kind, t obj,
    CASE WHEN to_regclass('public.'||t) IS NOT NULL THEN 'present' ELSE 'MISSING' END status FROM want_tables
  UNION ALL SELECT v, 'INDEX', i,
    CASE WHEN EXISTS(SELECT 1 FROM pg_indexes WHERE schemaname='public' AND indexname=i) THEN 'present' ELSE 'MISSING' END FROM want_idx
  UNION ALL SELECT v, 'POLICY', t||' :: '||p,
    CASE WHEN EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename=t AND policyname=p) THEN 'present' ELSE 'MISSING' END FROM want_pol
  UNION ALL SELECT v, 'COLUMN', t||'.'||c,
    CASE WHEN EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name=t AND column_name=c) THEN 'present' ELSE 'MISSING' END FROM want_col
  UNION ALL SELECT v, 'CONSTRAINT', k,
    CASE WHEN EXISTS(SELECT 1 FROM pg_constraint WHERE conname=k AND conrelid=to_regclass('public.'||t)) THEN 'present' ELSE 'MISSING' END FROM want_con
  UNION ALL SELECT v, 'RLS', t||' rowsecurity',
    CASE WHEN EXISTS(SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename=t AND rowsecurity) THEN 'present' ELSE 'MISSING' END FROM want_rls
) z ORDER BY v, kind, obj;
