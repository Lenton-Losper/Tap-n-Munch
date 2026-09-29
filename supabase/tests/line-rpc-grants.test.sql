-- ================================================================================================
-- 20260929150000: the three line/allocation RPCs are service_role only.
--
-- Measured against Supabase's REAL default privileges (fixture-schema.sql now reproduces them), so
-- anon/authenticated start WITH execute and only the migration's explicit REVOKE removes it. Every
-- refusal has a positive control: service_role must still execute, and the function must exist,
-- or "cannot execute" would also pass for a function that is simply absent.
-- ================================================================================================
DO $$
DECLARE
  sigs text[] := ARRAY[
    'public.amend_order_lines(uuid, uuid, integer, text, uuid, jsonb)',
    'public.settle_order_line_allocations(uuid, uuid, uuid[], text, text, uuid)',
    'public.order_is_fully_paid_by_allocations(uuid)'
  ];
  names text[] := ARRAY['amend_order_lines', 'settle_order_line_allocations', 'order_is_fully_paid_by_allocations'];
  i int;
BEGIN
  FOR i IN 1 .. array_length(sigs, 1) LOOP
    PERFORM public._expect('line_rpc_grants/' || names[i] || '/exists', to_regprocedure(sigs[i]) IS NOT NULL, sigs[i]);
    CONTINUE WHEN to_regprocedure(sigs[i]) IS NULL;
    PERFORM public._expect('line_rpc_grants/' || names[i] || '/anon_cannot_execute',
      NOT has_function_privilege('anon', sigs[i], 'EXECUTE'), 'anon can execute');
    PERFORM public._expect('line_rpc_grants/' || names[i] || '/authenticated_cannot_execute',
      NOT has_function_privilege('authenticated', sigs[i], 'EXECUTE'), 'authenticated can execute');
    PERFORM public._expect('line_rpc_grants/' || names[i] || '/service_role_can_execute',
      has_function_privilege('service_role', sigs[i], 'EXECUTE'), 'service_role lost execute');
  END LOOP;
END
$$;
