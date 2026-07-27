-- Follow-up to 20260727140000: that migration revoked the explicit
-- anon/authenticated grants found via information_schema.routine_privileges,
-- but missed a second, distinct default: Postgres auto-grants EXECUTE to the
-- PUBLIC pseudo-role when a function is created, and PUBLIC's grant is
-- invisible to information_schema.routine_privileges (it only lists direct
-- per-role grants). Five functions never had an explicit
-- "REVOKE ALL ... FROM PUBLIC" in their original migration, so PUBLIC's
-- default grant was still silently in effect after 20260727140000 --
-- confirmed by direct pg_proc.proacl inspection and by anon still
-- successfully calling correct_invoice and is_platform_admin after that
-- migration ran.
--
-- Since any privilege granted to PUBLIC applies to every role including
-- anon, this reopened the same class of hole for these five specifically.
--
-- generate_document_number/get_next_document_number/set_document_sequence_start
-- targeted by exact signature -- generate_document_number has a second,
-- unrelated non-SECURITY-DEFINER 4-arg overload that must not be touched.

REVOKE ALL ON FUNCTION public.correct_invoice(uuid, jsonb, text, uuid)
  FROM PUBLIC;

REVOKE ALL ON FUNCTION public.generate_document_number(text, text)
  FROM PUBLIC;

REVOKE ALL ON FUNCTION public.get_next_document_number(uuid, text)
  FROM PUBLIC;

REVOKE ALL ON FUNCTION public.set_document_sequence_start(uuid, text, integer)
  FROM PUBLIC;

REVOKE ALL ON FUNCTION public.is_platform_admin(uuid)
  FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.correct_invoice(uuid, jsonb, text, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.generate_document_number(text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.get_next_document_number(uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.set_document_sequence_start(uuid, text, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.is_platform_admin(uuid) TO service_role;
