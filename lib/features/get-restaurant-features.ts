import { createServerSupabaseClient } from '@/lib/supabase/server'
import { RestaurantFeatures } from '@/contexts/feature-context'

/**
 * WHY A DENIAL CARRIES A REASON (#370).
 *
 * `{ allowed: false }` used to be the entire answer, and three genuinely different situations
 * produced it:
 *
 *   - the row exists and the flag is false          -> a manager switches it on
 *   - there is no restaurant_features row at all    -> nothing to switch on; set it up first
 *   - the read itself failed                        -> not a setting; nobody can fix it by looking
 *
 * A screen told "ask your manager to enable station screens" when the read merely failed sends
 * someone to a setting that is already correct. That is what happened on 2026-09-02.
 *
 * All three are distinguishable from the SAME query that was already being made -- `error` was
 * simply being discarded by the destructure. This costs no extra round trip.
 */
export type FeatureDenialReason =
  /** The row exists and this flag is false. */
  | 'disabled'
  /** No restaurant_features row for this restaurant. */
  | 'not_configured'
  /** The read failed: RLS, connectivity, or a missing service-role key. */
  | 'unreadable'

export type FeatureCheck = { allowed: boolean; reason?: FeatureDenialReason }

/**
 * The one read. Both exported functions go through here so the error can never be dropped in one
 * of them and honoured in the other.
 */
async function readRestaurantFeatures(
  restaurantId: string,
): Promise<{ features: RestaurantFeatures | null; failed: boolean }> {
  const supabase = createServerSupabaseClient()
  const { data, error } = await supabase
    .from('restaurant_features')
    .select('*')
    .eq('restaurant_id', restaurantId)
    .maybeSingle()

  if (error) return { features: null, failed: true }
  return { features: (data as RestaurantFeatures | null) ?? null, failed: false }
}

export async function getRestaurantFeatures(restaurantId: string): Promise<RestaurantFeatures | null> {
  const { features } = await readRestaurantFeatures(restaurantId)
  return features
}

export async function requireFeature(
  restaurantId: string,
  feature: keyof RestaurantFeatures
): Promise<FeatureCheck> {
  const { features, failed } = await readRestaurantFeatures(restaurantId)

  // Ordered most-specific first. A failed read is NOT "no row": one is an outage, the other is a
  // configuration state, and telling them apart is the whole point of #370.
  if (failed) return { allowed: false, reason: 'unreadable' }
  if (!features) return { allowed: false, reason: 'not_configured' }
  if (features[feature] === true) return { allowed: true }
  return { allowed: false, reason: 'disabled' }
}
