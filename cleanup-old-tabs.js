#!/usr/bin/env node
/* One-time cleanup: settle open tabs older than 12 hours. */
const fs = require('fs')
const path = require('path')
const admin = require('firebase-admin')
require('dotenv').config()

function initAdmin() {
  if (admin.apps.length > 0) return admin.app()

  const serviceAccountPath = path.join(process.cwd(), 'serviceAccountKey.json')
  if (fs.existsSync(serviceAccountPath)) {
    const serviceAccount = require(serviceAccountPath)
    return admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
    })
  }

  if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    const json = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON)
    return admin.initializeApp({
      credential: admin.credential.cert(json),
    })
  }

  if (process.env.FIREBASE_SERVICE_ACCOUNT_B64) {
    const json = JSON.parse(Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT_B64, 'base64').toString('utf8'))
    return admin.initializeApp({
      credential: admin.credential.cert(json),
    })
  }

  throw new Error(
    'Missing Firebase Admin credentials. Provide serviceAccountKey.json or FIREBASE_SERVICE_ACCOUNT_JSON/B64.'
  )
}

async function main() {
  let db = null
  let mode = 'admin'
  try {
    initAdmin()
    db = admin.firestore()
  } catch (err) {
    // Fallback to client SDK when Admin credentials are unavailable.
    mode = 'client'
    const { initializeApp, getApps } = await import('firebase/app')
    const {
      getFirestore,
      collection,
      getDocs,
      query,
      where,
      updateDoc,
      serverTimestamp,
      doc,
    } = await import('firebase/firestore')

    const firebaseConfig = {
      apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
      authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
      projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
      storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
      messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
      appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
    }
    if (!firebaseConfig.apiKey || !firebaseConfig.projectId) {
      throw new Error(
        'Admin credentials missing and client Firebase config is incomplete in .env'
      )
    }

    const app = getApps().length ? getApps()[0] : initializeApp(firebaseConfig)
    const clientDb = getFirestore(app)

    const cutoff = new Date(Date.now() - 12 * 60 * 60 * 1000)
    console.log('[cleanup-old-tabs] Mode: client fallback')
    console.log('[cleanup-old-tabs] Cutoff:', cutoff.toISOString())

    const restaurantsSnap = await getDocs(collection(clientDb, 'restaurants'))
    console.log('[cleanup-old-tabs] Restaurants found:', restaurantsSnap.size)

    let totalSettled = 0
    for (const restaurantDoc of restaurantsSnap.docs) {
      const restaurantId = restaurantDoc.id
      const tabsSnap = await getDocs(
        query(
          collection(clientDb, 'restaurants', restaurantId, 'tabs'),
          where('status', '==', 'open'),
          where('created_at', '<', cutoff)
        )
      )
      if (tabsSnap.empty) continue

      await Promise.all(
        tabsSnap.docs.map((tabDoc) =>
          updateDoc(doc(clientDb, 'restaurants', restaurantId, 'tabs', tabDoc.id), {
            status: 'settled',
            settled_at: serverTimestamp(),
            settlement_type: 'auto_cleanup',
            updated_at: serverTimestamp(),
          })
        )
      )
      totalSettled += tabsSnap.size
      console.log(`[cleanup-old-tabs] ${restaurantId}: settled ${tabsSnap.size} tab(s)`)
    }

    console.log('[cleanup-old-tabs] Done. Total settled:', totalSettled)
    return
  }

  if (!db) {
    throw new Error('Failed to initialize Firestore')
  }

  const cutoff = new Date(Date.now() - 12 * 60 * 60 * 1000)
  const now = admin.firestore.FieldValue.serverTimestamp()

  console.log(`[cleanup-old-tabs] Mode: ${mode}`)
  console.log('[cleanup-old-tabs] Cutoff:', cutoff.toISOString())

  const restaurantsSnap = await db.collection('restaurants').get()
  console.log('[cleanup-old-tabs] Restaurants found:', restaurantsSnap.size)

  let totalSettled = 0
  for (const restaurantDoc of restaurantsSnap.docs) {
    const restaurantId = restaurantDoc.id
    const tabsSnap = await db
      .collection('restaurants')
      .doc(restaurantId)
      .collection('tabs')
      .where('status', '==', 'open')
      .where('created_at', '<', cutoff)
      .get()

    if (tabsSnap.empty) continue

    const updates = tabsSnap.docs.map((tabDoc) =>
      tabDoc.ref.update({
        status: 'settled',
        settled_at: now,
        settlement_type: 'auto_cleanup',
        updated_at: now,
      })
    )
    await Promise.all(updates)
    totalSettled += tabsSnap.size
    console.log(`[cleanup-old-tabs] ${restaurantId}: settled ${tabsSnap.size} tab(s)`)
  }

  console.log('[cleanup-old-tabs] Done. Total settled:', totalSettled)
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('[cleanup-old-tabs] Failed:', err)
    process.exit(1)
  })
