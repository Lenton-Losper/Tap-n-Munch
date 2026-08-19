-- POST-MERGE VERIFICATION. Measures the result; changes nothing that survives.
--
-- Wrapped BEGIN ... ROLLBACK, because the central check is not a SELECT: the cross-organisation
-- invariant is enforced by a trigger that only fires on a WRITE to stock_items, and nothing in the
-- merge fires it. Reading rows back cannot tell you the guard is satisfied -- only attempting a
-- write can. So this attempts two, and throws both away.
--
-- TWO-SIDED, because "the write succeeded" alone proves nothing. A trigger that has been dropped
-- also accepts every write, and would look exactly like a healthy one:
--
--   ACCEPT  a moved stock_items row, re-pointed at its OWN catalogue item, must SUCCEED.
--           This is the thing the merge had to get right.
--   REJECT  the same row pointed at ANOTHER organisation's catalogue item must RAISE.
--           This is the positive control. If it does not raise, the guard is dead and the
--           first result is meaningless.
--
-- Failure of either raises, so a bad result cannot be reported as a pass.

BEGIN;

DO $$
DECLARE
    v_accepted   boolean := false;
    v_rejected   boolean := false;
    v_moved_item uuid;
    v_foreign    uuid;
    v_err        text;
BEGIN
    -- A stock_items row belonging to the restaurant that moved.
    SELECT id INTO v_moved_item
      FROM public.stock_items
     WHERE restaurant_id = 'b161c758-582d-4dfa-839a-9fa35c492a49'
       AND organization_stock_item_id IS NOT NULL
     ORDER BY id
     LIMIT 1;
    IF v_moved_item IS NULL THEN
        RAISE EXCEPTION 'no linked stock_items row on the moved restaurant -- nothing to test';
    END IF;

    -- A catalogue item belonging to some OTHER organisation, for the control.
    SELECT id INTO v_foreign
      FROM public.organization_stock_items
     WHERE organization_id <> '5608ba8f-54a7-445b-aca5-80593663670c'
     ORDER BY id
     LIMIT 1;
    IF v_foreign IS NULL THEN
        RAISE EXCEPTION 'no foreign catalogue item exists -- the control cannot be built';
    END IF;

    -- ---- ACCEPT: re-point the row at its own item. Naming the column in SET is what makes the
    -- trigger fire (BEFORE UPDATE OF organization_stock_item_id), even though the value is equal.
    BEGIN
        UPDATE public.stock_items
           SET organization_stock_item_id = organization_stock_item_id
         WHERE id = v_moved_item;
        v_accepted := true;
    EXCEPTION WHEN OTHERS THEN
        v_accepted := false;
        v_err := SQLERRM;
    END;

    -- ---- REJECT: the positive control.
    BEGIN
        UPDATE public.stock_items
           SET organization_stock_item_id = v_foreign
         WHERE id = v_moved_item;
        v_rejected := false;   -- no exception => the guard did not fire
    EXCEPTION WHEN OTHERS THEN
        v_rejected := true;
    END;

    IF NOT v_accepted THEN
        RAISE EXCEPTION 'TRIGGER REJECTED A LEGITIMATE WRITE to moved row % -- merge is incomplete: %',
            v_moved_item, coalesce(v_err, '(no message)');
    END IF;
    IF NOT v_rejected THEN
        RAISE EXCEPTION 'GUARD IS DEAD: a cross-organisation write to % was ACCEPTED. The pass above means nothing.',
            v_moved_item;
    END IF;

    RAISE NOTICE 'TRIGGER OK: legitimate write accepted, cross-org write rejected (row %)', v_moved_item;
END $$;

ROLLBACK;

-- ---------------------------------------------------------------------------------------
-- The measurements, as plain reads, outside the rolled-back transaction.
-- ---------------------------------------------------------------------------------------

-- 1. both restaurants report the surviving organisation
SELECT 'restaurants_in_surviving_org' AS check, r.name, r.organization_id, o.name AS org_name
  FROM public.restaurants r
  JOIN public.organizations o ON o.id = r.organization_id
 WHERE r.id IN ('b161c758-582d-4dfa-839a-9fa35c492a49', '01bf27f1-a958-4322-bb3e-cc5240987808')
 ORDER BY r.name;

-- 2. all 10 stock_items link to catalogue rows in that org, and none is cross-org
SELECT 'stock_items_links' AS check,
       count(*) AS total,
       count(*) FILTER (WHERE r.organization_id = osi.organization_id) AS same_org,
       count(*) FILTER (WHERE r.organization_id <> osi.organization_id) AS cross_org
  FROM public.stock_items si
  JOIN public.restaurants r ON r.id = si.restaurant_id
  JOIN public.organization_stock_items osi ON osi.id = si.organization_stock_item_id
 WHERE si.restaurant_id IN ('b161c758-582d-4dfa-839a-9fa35c492a49', '01bf27f1-a958-4322-bb3e-cc5240987808');

-- 3. staff access unchanged -- every restaurant_users row still present
SELECT 'restaurant_users' AS check, restaurant_id, user_id, role, created_at, deleted_at
  FROM public.restaurant_users
 WHERE restaurant_id IN ('b161c758-582d-4dfa-839a-9fa35c492a49', '01bf27f1-a958-4322-bb3e-cc5240987808')
 ORDER BY restaurant_id, created_at;

-- 4. the owner can reach Add Location and view-all-locations: authorizeOrganization reads
--    organization_users, OWNER rows only, on the org the caller's restaurant belongs to.
--    This is that exact lookup, for both restaurants.
SELECT 'org_capability' AS check, r.name AS restaurant, u.email, ou.role
  FROM public.restaurants r
  JOIN public.organization_users ou ON ou.organization_id = r.organization_id AND ou.role = 'OWNER'
  JOIN public.users u ON u.id = ou.user_id
 WHERE r.id IN ('b161c758-582d-4dfa-839a-9fa35c492a49', '01bf27f1-a958-4322-bb3e-cc5240987808')
 ORDER BY r.name;

-- 5. the emptied organisation, and the catalogue as merged
SELECT 'catalogue' AS check, o.name AS org_name, count(osi.id) AS items
  FROM public.organizations o
  LEFT JOIN public.organization_stock_items osi ON osi.organization_id = o.id
 WHERE o.id IN ('5608ba8f-54a7-445b-aca5-80593663670c', '1d623c21-8c5e-40fd-b7bc-df654166d412')
 GROUP BY o.name
 ORDER BY o.name;
