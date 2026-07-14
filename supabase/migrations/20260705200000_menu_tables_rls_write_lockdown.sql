-- Lock down menu_categories / menu_subcategories / menu_items writes at RLS + privilege layer (staging).
-- Guest SELECT stays public (existing policies unchanged). Staff mutations go through service_role API routes only.

ALTER TABLE public.menu_categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.menu_categories FORCE ROW LEVEL SECURITY;

ALTER TABLE public.menu_subcategories ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.menu_subcategories FORCE ROW LEVEL SECURITY;

ALTER TABLE public.menu_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.menu_items FORCE ROW LEVEL SECURITY;

REVOKE INSERT, UPDATE, DELETE ON TABLE public.menu_categories FROM anon;
REVOKE INSERT, UPDATE, DELETE ON TABLE public.menu_categories FROM authenticated;

REVOKE INSERT, UPDATE, DELETE ON TABLE public.menu_subcategories FROM anon;
REVOKE INSERT, UPDATE, DELETE ON TABLE public.menu_subcategories FROM authenticated;

REVOKE INSERT, UPDATE, DELETE ON TABLE public.menu_items FROM anon;
REVOKE INSERT, UPDATE, DELETE ON TABLE public.menu_items FROM authenticated;

GRANT SELECT ON TABLE public.menu_categories TO anon;
GRANT SELECT ON TABLE public.menu_categories TO authenticated;

GRANT SELECT ON TABLE public.menu_subcategories TO anon;
GRANT SELECT ON TABLE public.menu_subcategories TO authenticated;

GRANT SELECT ON TABLE public.menu_items TO anon;
GRANT SELECT ON TABLE public.menu_items TO authenticated;
