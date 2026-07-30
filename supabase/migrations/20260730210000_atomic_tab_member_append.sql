-- Atomic append of a member to tabs.members.
--
-- app/api/tabs/join/route.ts previously read tabs.members, appended one entry in JS, and
-- wrote the whole array back. With no version check that is a read-modify-write race: when a
-- group scans the table QR at the same time -- the ordinary case in a restaurant -- the
-- concurrent writes clobber each other. Measured on staging: 4 concurrent joins all returned
-- HTTP 200, but only 1 survived, 5/5 trials, 3 members silently lost each time. Dropped
-- members lose order attribution (memberName renders as an em dash) and break split-bill.
--
-- Doing the append inside a single UPDATE fixes it. Under READ COMMITTED, a concurrent
-- UPDATE of the same row blocks on the row lock and then re-evaluates both the SET
-- expression and the WHERE clause against the newly committed version, so each caller
-- appends to the latest array rather than to a stale snapshot.
--
-- The NOT ... @> guard keeps the operation idempotent: re-joining with a session_id that is
-- already a member is a no-op rather than a duplicate entry.

CREATE OR REPLACE FUNCTION public.add_tab_member(
  p_tab_id uuid,
  p_member jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_members jsonb;
BEGIN
  IF p_member IS NULL OR COALESCE(p_member->>'session_id', '') = '' THEN
    RAISE EXCEPTION 'add_tab_member requires a member object with a non-empty session_id';
  END IF;

  -- The fallback display name is derived here, from the row's current value under the same
  -- lock, rather than from a count the caller read earlier. Deriving it caller-side was the
  -- same race in miniature: two simultaneous joiners both read length 2 and both became
  -- "Person 3".
  UPDATE tabs
     SET members = COALESCE(members, '[]'::jsonb) || jsonb_build_array(
           CASE
             WHEN COALESCE(p_member->>'display_name', '') = ''
               THEN jsonb_set(
                      p_member,
                      '{display_name}',
                      to_jsonb('Person ' || (jsonb_array_length(COALESCE(members, '[]'::jsonb)) + 1))
                    )
             ELSE p_member
           END
         )
   WHERE id = p_tab_id
     AND NOT COALESCE(members, '[]'::jsonb) @> jsonb_build_array(
           jsonb_build_object('session_id', p_member->>'session_id')
         )
  RETURNING members INTO v_members;

  -- No row updated: either the tab does not exist, or this session is already a member.
  -- Both are success cases for the caller, so return the current array rather than raising.
  IF v_members IS NULL THEN
    SELECT members INTO v_members FROM tabs WHERE id = p_tab_id;
  END IF;

  RETURN COALESCE(v_members, '[]'::jsonb);
END;
$$;

-- This project's default privileges grant EXECUTE on new public functions to anon and
-- authenticated at CREATE time, so REVOKE ... FROM PUBLIC alone would leave both roles able
-- to call this with the anon key via PostgREST and inject members into any tab they can name.
-- Revoke those roles explicitly; the join route runs with the service role.
REVOKE ALL ON FUNCTION public.add_tab_member(uuid, jsonb) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.add_tab_member(uuid, jsonb) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.add_tab_member(uuid, jsonb) TO service_role;
