import { initializeApp, getApps, FirebaseApp } from 'firebase/app'
import { getAuth, Auth } from 'firebase/auth'
import { getFirestore, Firestore } from 'firebase/firestore'
import { getStorage, FirebaseStorage } from 'firebase/storage'

// Firebase configuration
// Get these values from Firebase Console > Project Settings > Your apps > Web app
const getFirebaseConfig = () => ({
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
  storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
})

// Validate Firebase configuration
const isFirebaseConfigValid = () => {
  const config = getFirebaseConfig()
  const isValid = !!(
    config.apiKey &&
    config.authDomain &&
    config.projectId &&
    config.storageBucket &&
    config.messagingSenderId &&
    config.appId &&
    config.apiKey !== 'undefined' &&
    config.apiKey !== '' &&
    config.appId !== 'undefined' &&
    config.appId !== ''
  )
  
  // Debug logging in development
  if (typeof window !== 'undefined' && !isValid) {
    const missing = []
    if (!config.apiKey || config.apiKey === 'undefined') missing.push('NEXT_PUBLIC_FIREBASE_API_KEY')
    if (!config.authDomain || config.authDomain === 'undefined') missing.push('NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN')
    if (!config.projectId || config.projectId === 'undefined') missing.push('NEXT_PUBLIC_FIREBASE_PROJECT_ID')
    if (!config.storageBucket || config.storageBucket === 'undefined') missing.push('NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET')
    if (!config.messagingSenderId || config.messagingSenderId === 'undefined') missing.push('NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID')
    if (!config.appId || config.appId === 'undefined') missing.push('NEXT_PUBLIC_FIREBASE_APP_ID')
    
    if (missing.length > 0) {
      console.warn('Missing Firebase environment variables:', missing.join(', '))
    }
  }
  
  return isValid
}

// Initialize Firebase only if config is valid
let app: FirebaseApp | null = null
let auth: Auth | null = null
let db: Firestore | null = null
let storage: FirebaseStorage | null = null

if (isFirebaseConfigValid()) {
  try {
    const firebaseConfig = getFirebaseConfig()
    if (getApps().length === 0) {
      app = initializeApp(firebaseConfig)
    } else {
      app = getApps()[0]
    }

    // Auth is client-side only
    if (typeof window !== 'undefined' && app) {
      auth = getAuth(app)
    }

    // Firestore can work on both client and server
    if (app) {
      db = getFirestore(app)
    }

    // Storage is client-side only
    if (typeof window !== 'undefined' && app) {
      storage = getStorage(app)
    }
  } catch (error) {
    console.error('Firebase initialization error:', error)
    if (typeof window !== 'undefined') {
      console.warn(
        'Firebase is not properly configured. Please check your .env.local file. ' +
        'See FIREBASE_SETUP.md for instructions.'
      )
    }
  }
} else {
  if (typeof window !== 'undefined') {
    console.warn(
      'Firebase configuration is missing or invalid. ' +
      'Please create a .env.local file with your Firebase credentials. ' +
      'See FIREBASE_SETUP.md for instructions.'
    )
  }
}

export { app, auth, db, storage, isFirebaseConfigValid }

