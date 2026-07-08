-- Issue #23: document_sequences write policy still subqueries restaurant_roles
-- (RLS recursion). Use user_has_permission like billing_profiles / business_documents.

DROP POLICY IF EXISTS "Authorized staff can write document sequences"
  ON public.document_sequences;

CREATE POLICY "Authorized staff can write document sequences"
  ON public.document_sequences
  FOR ALL
  USING (public.user_has_permission(restaurant_id, 'documents:write'))
  WITH CHECK (public.user_has_permission(restaurant_id, 'documents:write'));
