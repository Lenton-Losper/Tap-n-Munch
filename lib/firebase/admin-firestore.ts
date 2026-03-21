import { cert, getApp, initializeApp, type App } from 'firebase-admin/app'
import type { ServiceAccount } from 'firebase-admin/app'
import { FieldValue, getFirestore, type Firestore } from 'firebase-admin/firestore'

/** Isolated app name so we never attach to another package’s default Admin app (wrong project → PERMISSION_DENIED). */
const ADMIN_APP_NAME = 'flashtap-server-admin'

let adminApp: App | null = null
let cachedDb: Firestore | null | undefined = undefined
let warnedMissingCredentials = false

/**
 * Prefer base64 on hosts (e.g. Vercel) that mangle multiline JSON in env vars.
 * Set FIREBASE_SERVICE_ACCOUNT_B64 = Buffer.from(JSON.stringify(serviceAccountJson)).toString('base64')
 */
function parseServiceAccountCredentials(): ServiceAccount | null {
  const b64 = process.env.FIREBASE_SERVICE_ACCOUNT_B64?.trim()
  if (b64) {
    try {
      const json = Buffer.from(b64, 'base64').toString('utf8')
      return JSON.parse(json) as ServiceAccount
    } catch (e) {
      console.error('[firebase-admin] FIREBASE_SERVICE_ACCOUNT_B64 is set but invalid:', e)
    }
  }

  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON?.trim()
  if (!raw) return null

  try {
    return JSON.parse(raw) as ServiceAccount
  } catch (e) {
    console.error('[firebase-admin] FIREBASE_SERVICE_ACCOUNT_JSON is not valid JSON, trying base64 decode:', e)
    try {
      const json = Buffer.from(raw, 'base64').toString('utf8')
      return JSON.parse(json) as ServiceAccount
    } catch {
      return null
    }
  }
}

/**
 * Lazily initializes Firebase Admin once per server runtime.
 * Returns null when not on the server or when FIREBASE_SERVICE_ACCOUNT_JSON is missing/invalid.
 */
function resolveAdminFirestore(): Firestore | null {
  if (typeof window !== 'undefined') return null

  if (cachedDb !== undefined) {
    return cachedDb
  }

  try {
    const cred = parseServiceAccountCredentials()
    if (!cred) {
      if (!warnedMissingCredentials) {
        console.warn(
          '[firebase-admin] No valid service account: set FIREBASE_SERVICE_ACCOUNT_JSON and/or FIREBASE_SERVICE_ACCOUNT_B64 (recommended on Vercel). Server API routes return 503 until configured.'
        )
        warnedMissingCredentials = true
      }
      cachedDb = null
      return null
    }

    try {
      adminApp = getApp(ADMIN_APP_NAME)
    } catch {
      adminApp = initializeApp({ credential: cert(cred) }, ADMIN_APP_NAME)
    }
    cachedDb = getFirestore(adminApp)
    return cachedDb
  } catch (e) {
    console.error('[firebase-admin] Failed to initialize Firebase Admin:', e)
    cachedDb = null
    return null
  }
}

/**
 * Firebase Admin Firestore — bypasses security rules. Call on each request (lazy singleton inside).
 * @returns Firestore instance or null if not configured
 */
export function adminDb(): Firestore | null {
  return resolveAdminFirestore()
}

/** @deprecated Use adminDb() — kept for older imports */
export function getAdminFirestore(): Firestore | null {
  return adminDb()
}

export { FieldValue }
