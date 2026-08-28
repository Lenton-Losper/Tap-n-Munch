export const FEATURE_FLAG_KEYS = [
  'kitchen_enabled',
  'inventory_enabled',
  'analytics_enabled',
  'split_bill_enabled',
  'reservations_enabled',
  'loyalty_enabled',
  'online_payments_enabled',
  'multi_branch_enabled',
  'staff_app_enabled',
  'kiosk_enabled',
  'whatsapp_enabled',
  'station_screens_enabled',
] as const

export type FeatureFlagKey = (typeof FEATURE_FLAG_KEYS)[number]
export type FeatureFlagsState = Record<FeatureFlagKey, boolean>

/**
 * Flags that exist in the schema and are persisted by the platform routes, but that NO application
 * code reads — so an operator switching one on sees nothing change. They stay in
 * `FEATURE_FLAG_KEYS`, which is what selects the columns and validates the PATCH payload; they are
 * simply not rendered as operator-facing switches.
 *
 * MEASURED 2026-08-27 for #351 (a measurement, per rule 20, so it ages visibly):
 * `kitchen_enabled` had no reader anywhere in this repo — no kitchen route, no kitchen component,
 * no branch on the flag — while the admin panel labelled it "Kitchen Display System", a named
 * product that does not exist. On production the flag was already `true` at one venue.
 *
 * When a kitchen surface is built, delete the key from this list and its switch comes back. The
 * accompanying test asserts BOTH halves: hidden from the panel, still in `FEATURE_FLAG_KEYS`.
 */
/**
 * `station_screens_enabled` (feat/station-screens-v1) is here for a DIFFERENT reason than
 * `kitchen_enabled` above, worth stating so the two are not read as the same mistake twice:
 * this flag DOES have a reader (every station API route under app/api/terminal/station-*,
 * app/api/terminal/bar-rounds gates on it) — it is not #351's "nothing reads this" defect.
 * It is withheld from the operator panel because the ruling was that ONE person turns it on,
 * deliberately, once the order_lines/order_line_events integration and the station credential
 * both ship — not that any super_admin can self-serve it from a switch today, which is exactly
 * the "screens are wired but the data behind them is still a guess" state #351 warns a labelled
 * switch must never represent. It is still PATCHable directly (this route's allowlist, driven
 * by FEATURE_FLAG_KEYS below) for the one person doing that turn-on. Remove it from this list
 * once both ship and it belongs to every super_admin, not one operator's deliberate call.
 */
export const UNBUILT_FEATURE_FLAG_KEYS = ['kitchen_enabled', 'station_screens_enabled'] as const

export type UnbuiltFeatureFlagKey = (typeof UNBUILT_FEATURE_FLAG_KEYS)[number]
export type OperatorFeatureFlagKey = Exclude<FeatureFlagKey, UnbuiltFeatureFlagKey>

/** The subset of `FEATURE_FLAG_KEYS` that is rendered to operators. */
export const OPERATOR_FEATURE_FLAG_KEYS: readonly OperatorFeatureFlagKey[] =
  FEATURE_FLAG_KEYS.filter(
    (key): key is OperatorFeatureFlagKey =>
      !(UNBUILT_FEATURE_FLAG_KEYS as readonly string[]).includes(key),
  )
