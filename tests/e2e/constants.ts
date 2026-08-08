export const STAGING_BASE = process.env.E2E_BASE_URL ?? 'https://flashtap-staging.llosperofficial.workers.dev'

// Staging test restaurant (stable fixture on mdqjpxwczrhkxkbqatqa)
export const TEST_RESTAURANT_ID = 'a1999166-ddfa-40d1-ad1f-2f01282a1652'
export const TEST_TABLE_NUMBER = '1'
/** Active is_kiosk fixture — see scripts/ensure-e2e-kiosk-fixture.mjs */
export const TEST_KIOSK_TABLE_NUMBER = '1001'
/**
 * #178 — authenticated staff fixtures. Both accounts are members of the staging test restaurant
 * above; their roles are what makes the permission case meaningful.
 *
 *   STAFF_EMAIL   — owner. tables:read + tables:manage, so Clear table is visible.
 *   NOPERMS_EMAIL — kitchen. no tables:* at all, so /qr-codes must refuse it outright.
 *
 * The password for both is STAGING_TEST_PASSWORD (.env.test). Never hardcode it.
 */
export const STAFF_EMAIL = process.env.E2E_STAFF_EMAIL ?? 'flashtap.staging.test@gmail.com'
export const NOPERMS_EMAIL = process.env.E2E_NOPERMS_EMAIL ?? 'staging.kitchen.test@gmail.com'

export const STAFF_STORAGE_STATE = 'tests/e2e/.auth/staff.json'
export const NOPERMS_STORAGE_STATE = 'tests/e2e/.auth/noperms.json'

/**
 * An ACTIVE table on the staging test restaurant. Clear table is only offered on active
 * ordering points, so an inactive number would hide the item and the spec would pass for the
 * wrong reason. 120 is the table #176 was reported against.
 */
export const TEST_ACTIVE_TABLE_NUMBER = 120

export const TEST_MENU_URL = `${STAGING_BASE}/menu/${TEST_RESTAURANT_ID}/v2?table=${TEST_TABLE_NUMBER}`
export const TEST_BROWSE_URL = `${STAGING_BASE}/menu/${TEST_RESTAURANT_ID}/browse?table=${TEST_TABLE_NUMBER}`
export const TEST_KIOSK_URL = `${STAGING_BASE}/menu/${TEST_RESTAURANT_ID}/kiosk?table=${TEST_KIOSK_TABLE_NUMBER}`
