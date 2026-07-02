export const STAGING_BASE = process.env.E2E_BASE_URL ?? 'https://flashtap-staging.llosperofficial.workers.dev'

// Staging test restaurant (stable fixture on mdqjpxwczrhkxkbqatqa)
export const TEST_RESTAURANT_ID = 'a1999166-ddfa-40d1-ad1f-2f01282a1652'
export const TEST_TABLE_NUMBER = '1'
export const TEST_MENU_URL = `${STAGING_BASE}/menu/${TEST_RESTAURANT_ID}/v2?table=${TEST_TABLE_NUMBER}`
export const TEST_BROWSE_URL = `${STAGING_BASE}/menu/${TEST_RESTAURANT_ID}/browse?table=${TEST_TABLE_NUMBER}`
export const TEST_KIOSK_URL = `${STAGING_BASE}/menu/${TEST_RESTAURANT_ID}/kiosk?table=${TEST_TABLE_NUMBER}`
