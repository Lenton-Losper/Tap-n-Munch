-- Active-context model for accounts that are both a platform admin and a
-- restaurant member. Replaces the old restaurantId-wins ternary redirect
-- logic with an explicit, persisted per-user context choice.

CREATE TABLE IF NOT EXISTS public.user_active_context (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  context_type text NOT NULL CHECK (context_type IN ('platform', 'restaurant')),
  restaurant_id uuid REFERENCES public.restaurants(id) ON DELETE CASCADE,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT user_active_context_restaurant_id_matches_type CHECK (
    (context_type = 'platform' AND restaurant_id IS NULL)
    OR (context_type = 'restaurant' AND restaurant_id IS NOT NULL)
  )
);

ALTER TABLE public.user_active_context ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can read own active context" ON public.user_active_context;
CREATE POLICY "Users can read own active context"
  ON public.user_active_context FOR SELECT
  USING (auth.uid() = user_id);

-- Service role (API) writes; no authenticated INSERT/UPDATE policy needed for browser clients.
