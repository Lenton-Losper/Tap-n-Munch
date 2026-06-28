export const STAGING_BASE = process.env.E2E_BASE_URL ?? 'https://flashtap-staging.llosperofficial.workers.dev'

// Staging test restaurant (created during replay test sprint)
export const TEST_RESTAURANT_ID = 'ade55dd9-ab0d-46c7-9f53-d65f4bed4305'
export const TEST_TABLE_NUMBER = '1'
export const TEST_MENU_URL = `${STAGING_BASE}/menu/${TEST_RESTAURANT_ID}/v2?table=${TEST_TABLE_NUMBER}`
export const TEST_BROWSE_URL = `${STAGING_BASE}/menu/${TEST_RESTAURANT_ID}/browse?table=${TEST_TABLE_NUMBER}`
export const TEST_KIOSK_URL = `${STAGING_BASE}/menu/${TEST_RESTAURANT_ID}/kiosk?table=${TEST_TABLE_NUMBER}`
